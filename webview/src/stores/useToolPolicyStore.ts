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
import { CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY, CROSS_CONVERSATION_TOOL_NAMES, READONLY_CROSS_CONVERSATION_TOOL_NAMES } from '@shared/protocol';
import { crossConversationToolPermitted, defaultToolNames, resolveToolPolicyLayers, toolPolicyScopeLayer, type ToolPolicyLayer } from '@shared/toolPolicyResolution';
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

/** The cross-conversation tools a scope is meant to get, and those its effective list still blocks. */
export interface CrossConversationToolAvailability {
  /** False when the scope's effective list lacks run_agent: the backend then offers only the read-type tools. */
  sendTools: boolean;
  /** What the backend offers here while the switch is on, from the effective list. */
  available: string[];
  expected: string[];
  missing: string[];
}

interface ScopeRef {
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
}

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

function cloneSourceConfigs(sourceConfigs: Record<string, ToolPolicySourceConfigRecord> | undefined): Record<string, ToolPolicySourceConfigRecord> | undefined {
  if (!sourceConfigs) return undefined;
  const cloned: Record<string, ToolPolicySourceConfigRecord> = {};
  for (const [sourceId, record] of Object.entries(sourceConfigs)) {
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
      if (scopeKind !== 'global' && !scopeId?.trim()) return;
      if (!AGENT_COLLABORATION_CONFIG_KEYS.includes(key)) throw new TypeError('未知的 Agent 协作配置项。');
      const minimum = key === 'maxConcurrentAgents' ? 1 : 0;
      if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
        throw new TypeError(`Agent 协作配置必须是大于或等于 ${minimum} 的整数。`);
      }
      const definition = this.toolDefinitions.find((tool) => tool.name === SUB_AGENT_TOOL_NAME);
      if (!definition?.configSchema?.fields.some((field) => field.key === key)) return;
      const local = this.localPolicyFor(scopeKind, scopeId).policy;
      if (value === undefined && local?.toolConfigs?.[SUB_AGENT_TOOL_NAME]?.config?.[key] === undefined) return;
      // A field override must not freeze unrelated inherited tool configuration or the tool list.
      const configs = cloneToolConfigs(local?.toolConfigs) ?? {};
      const entry = configs[SUB_AGENT_TOOL_NAME] ?? { config: {} };
      if (value === undefined) delete entry.config[key];
      else entry.config[key] = value;
      if (Object.keys(entry.config).length === 0 && Object.keys(entry).length === 1) delete configs[SUB_AGENT_TOOL_NAME];
      else configs[SUB_AGENT_TOOL_NAME] = entry;
      this.saveOrDropLocalPolicy(scopeKind, scopeId, local?.allowedTools, configs, undefined);
    },
    /**
     * Stores the cross-conversation switch in this scope's run_agent config without changing what
     * any other tool may do:
     * - A scope with its own saved tool list gains the cross-conversation tools it lacks (only the
     *   read-type ones when its effective list has no run_agent). The record remembers those
     *   additions, and turning the switch off or restoring inheritance removes exactly them.
     * - A scope without its own list gets a record with no list, which narrows nothing and keeps a
     *   built-in Agent/workflow list in force, so the switch never freezes a new ceiling.
     * Restoring inheritance drops a record that is left empty. Upper layers keep gating the tools.
     */
    setCrossConversationCollaborationForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, value: boolean | undefined): void {
      if (scopeKind !== 'global' && !scopeId?.trim()) return;
      if (value !== undefined && typeof value !== 'boolean') throw new TypeError('跨对话协作开关必须是布尔值。');
      const definition = this.toolDefinitions.find((tool) => tool.name === SUB_AGENT_TOOL_NAME);
      if (!definition?.configSchema?.fields.some((field) => field.key === CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY)) return;
      const local = this.localPolicyFor(scopeKind, scopeId).policy;
      if (value === undefined && local?.toolConfigs?.[SUB_AGENT_TOOL_NAME]?.config?.[CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY] === undefined) return;
      const configs = cloneToolConfigs(local?.toolConfigs) ?? {};
      const entry = configs[SUB_AGENT_TOOL_NAME] ?? { config: {} };
      if (value === undefined) delete entry.config[CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY];
      else entry.config[CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY] = value;
      if (Object.keys(entry.config).length === 0 && Object.keys(entry).length === 1) delete configs[SUB_AGENT_TOOL_NAME];
      else configs[SUB_AGENT_TOOL_NAME] = entry;

      let allowedTools = local?.allowedTools ? [...local.allowedTools] : undefined;
      let granted: string[] = [];
      if (allowedTools) {
        const previous = local?.crossConversationGrantedTools ?? [];
        const current = allowedTools;
        if (value === true) {
          const added = this.crossConversationToolsFor(scopeKind, scopeId).expected.filter((name) => !current.includes(name));
          allowedTools = [...current, ...added];
          granted = uniqueNames([...previous.filter((name) => current.includes(name)), ...added]);
        } else if (value === undefined && this.crossConversationOnWithoutOwnValue(scopeKind, scopeId)) {
          // Restoring inheritance while another layer keeps the switch on for Turns this list
          // bounds: this scope still needs the tools, and they stay marked so a later switch-off
          // here removes them.
          granted = previous.filter((name) => current.includes(name));
        } else {
          allowedTools = current.filter((name) => !previous.includes(name));
        }
      }
      this.saveOrDropLocalPolicy(scopeKind, scopeId, allowedTools, configs, granted);
    },
    /**
     * Saves this scope's record with the given list and configs, keeping its name, preset and
     * source settings. A record left with nothing of its own is removed instead of kept empty.
     */
    saveOrDropLocalPolicy(
      scopeKind: ToolPolicyScopeKind,
      scopeId: string | undefined,
      allowedTools: string[] | undefined,
      toolConfigs: Record<string, ToolPolicyToolConfigRecord>,
      crossConversationGrantedTools: string[] | undefined
    ): void {
      const local = this.localPolicyFor(scopeKind, scopeId).policy;
      if (!allowedTools && isEmptyRecord(toolConfigs) && isEmptyRecord(local?.sourceConfigs) && local?.preset === undefined) {
        if (local) this.dropLocalPolicy(scopeKind, scopeId);
        return;
      }
      this.setPolicyForScope(scopeKind, scopeId, allowedTools, local?.name, toolConfigs, cloneSourceConfigs(local?.sourceConfigs), local?.preset, crossConversationGrantedTools);
    },
    localPolicyFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): ToolPolicyResolution {
      const clientState = useClientStateStore();
      const link = latestLink(clientState.toolPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, scopeId)));
      const policy = clientState.toolPolicies.find((candidate) => candidate.id === link?.toolPolicyId);
      return { ...(policy ? { policy } : {}), ...(link ? { link } : {}) };
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
     * no tool enabled rather than breaking the settings view.
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
    /** This scope's switch-added tools minus the ones the user has now enabled explicitly. */
    crossConversationGrantsWithout(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, enabledByUser: readonly string[]): string[] {
      return (this.localPolicyFor(scopeKind, scopeId).policy?.crossConversationGrantedTools ?? []).filter((name) => !enabledByUser.includes(name));
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
     * Agents: their MCP tools and the tools a user ticked on them stay theirs, since a name in an
     * upper list would admit an MCP source no layer configures for every Agent.
     */
    listSeedFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): string[] {
      const saved: unknown = this.localPolicyFor(scopeKind, scopeId).policy?.allowedTools;
      if (Array.isArray(saved)) return saved.filter((name): name is string => typeof name === 'string');
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
      if (this.localPolicyFor(scopeKind, scopeId).policy?.allowedTools !== undefined) return [];
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
     * Whether the cross-conversation switch stays on for some Turn this scope's list bounds once the
     * scope's own value is gone: an upper layer turns it on, or, since an Agent and a workflow run
     * together, some workflow (at an Agent scope) or some Agent (at a workflow scope) turns it on
     * over global.
     */
    crossConversationOnWithoutOwnValue(scopeKind: ToolPolicyScopeKind, scopeId?: string): boolean {
      const key = CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY;
      if (this.inheritedToolConfigValue(scopeKind, scopeId, SUB_AGENT_TOOL_NAME, key)?.value === true) return true;
      const partner = scopeKind === 'agent' ? 'workflow' : scopeKind === 'workflow' ? 'agent' : undefined;
      if (!partner) return false;
      const clientState = useClientStateStore();
      const globalValue = this.layerFor({ scopeKind: 'global' })?.policy.toolConfigs?.[SUB_AGENT_TOOL_NAME]?.config?.[key];
      const partnerIds = uniqueNames([
        ...clientState.builtinToolPolicies.filter((record) => record.scopeKind === partner).map((record) => record.scopeId),
        ...clientState.toolPolicyScopeLinks
          .filter((link) => link.role === 'active' && link.scopeKind === partner)
          .map((link) => link.scopeId?.trim() ?? '')
      ]);
      return partnerIds.some((partnerId) =>
        (this.layerFor({ scopeKind: partner, scopeId: partnerId })?.policy.toolConfigs?.[SUB_AGENT_TOOL_NAME]?.config?.[key] ?? globalValue) === true);
    },
    /** A child task's conversation: cross-conversation tools are never offered there. */
    isChildConversation(conversationId: string | undefined): boolean {
      const id = conversationId?.trim();
      if (!id) return false;
      return Object.values(useReliableKernelClientFeedStore().records.ChildExecution ?? {})
        .some((child) => plainText(child.child_conversation_id) === id);
    },
    crossConversationToolsFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): CrossConversationToolAvailability {
      const allowed = this.effectivePolicyFor(scopeKind, scopeId).policy.allowedTools;
      const known = new Set(useClientStateStore().toolDefinitions.map((tool) => tool.name));
      // The backend's own rule: send, create and fork need run_agent in the same list.
      const expected = CROSS_CONVERSATION_TOOL_NAMES.filter((name) => known.has(name) && crossConversationToolPermitted(allowed, name));
      return {
        sendTools: allowed.includes(SUB_AGENT_TOOL_NAME),
        available: expected.filter((name) => allowed.includes(name)),
        expected,
        missing: expected.filter((name) => !allowed.includes(name))
      };
    },
    /**
     * Saves one scope's record. `allowedTools` undefined saves a record without a list. The record's
     * switch-granted tools carry over (limited to the new list) unless the caller states them.
     */
    setPolicyForScope(
      scopeKind: ToolPolicyScopeKind,
      scopeId: string | undefined,
      allowedTools: string[] | undefined,
      name?: string,
      toolConfigs?: Record<string, ToolPolicyToolConfigRecord>,
      sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>,
      preset?: ToolPolicyPresetKind,
      crossConversationGrantedTools?: string[]
    ): void {
      const clientState = useClientStateStore();
      const validNames = new Set(clientState.toolDefinitions.map((tool) => tool.name));
      const sanitized = allowedTools
        ?.map((tool) => tool.trim())
        .filter((tool, index, list) => !!tool && validNames.has(tool) && list.indexOf(tool) === index);
      const granted = sanitized
        ? uniqueNames(crossConversationGrantedTools ?? this.localPolicyFor(scopeKind, scopeId).policy?.crossConversationGrantedTools ?? [])
          .filter((tool) => sanitized.includes(tool))
        : [];

      const plainToolConfigs = cloneToolConfigs(toolConfigs);
      const plainSourceConfigs = cloneSourceConfigs(sourceConfigs);
      this.applyOptimisticPolicyScopeSet(scopeKind, scopeId, sanitized, name, plainToolConfigs, plainSourceConfigs, preset, granted);

      const payload: ToolPolicyScopeSetPayload = {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(sanitized ? { allowedTools: sanitized } : {}),
        ...(granted.length > 0 ? { crossConversationGrantedTools: granted } : {}),
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
        local?.allowedTools,
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
      preset?: ToolPolicyPresetKind,
      crossConversationGrantedTools: string[] = []
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
        ...(crossConversationGrantedTools.length > 0 ? { crossConversationGrantedTools: [...crossConversationGrantedTools] } : {}),
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
