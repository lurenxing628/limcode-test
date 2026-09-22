import { defineStore } from 'pinia';
import type {
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
import { resolveToolPolicyLayers, type ToolPolicyLayer } from '@shared/toolPolicyResolution';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

export const SUB_AGENT_TOOL_NAME = 'run_agent';
export const AGENT_COLLABORATION_CONFIG_KEYS = ['maxChildAgentDepth', 'maxConcurrentAgents', 'maxAutomaticFollowups'] as const;
export type AgentCollaborationConfigKey = typeof AGENT_COLLABORATION_CONFIG_KEYS[number];

export interface ToolPolicyResolution {
  policy?: ToolPolicyRecord;
  link?: ToolPolicyScopeLinkRecord;
  inheritedFrom?: ToolPolicyScopeKind;
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

function defaultAllowedTools(definitions: ToolDefinitionRecord[]): string[] {
  return definitions
    .filter((tool) => tool.source?.kind !== 'mcp' && tool.metadata?.defaultEnabled !== false)
    .map((tool) => tool.name);
}

function defaultToolPolicy(definitions: ToolDefinitionRecord[], scopeKind: ToolPolicyScopeKind): ToolPolicyRecord {
  return {
    id: policyIdForScope(scopeKind, undefined),
    name: defaultPolicyName(scopeKind),
    allowedTools: defaultAllowedTools(definitions),
    preset: 'custom'
  };
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
      const current = local ?? this.effectivePolicyFor(scopeKind, scopeId).policy;
      if (!current) return;
      // A field override must not freeze unrelated inherited tool configuration.
      const configs = cloneToolConfigs(local?.toolConfigs) ?? {};
      const entry = configs[SUB_AGENT_TOOL_NAME] ?? { config: {} };
      if (value === undefined) delete entry.config[key];
      else entry.config[key] = value;
      if (Object.keys(entry.config).length === 0 && Object.keys(entry).length === 1) delete configs[SUB_AGENT_TOOL_NAME];
      else configs[SUB_AGENT_TOOL_NAME] = entry;
      this.setPolicyForScope(scopeKind, scopeId, current.allowedTools, current.name, configs, cloneSourceConfigs(local?.sourceConfigs), local?.preset);
    },
    localPolicyFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): ToolPolicyResolution {
      const clientState = useClientStateStore();
      const link = latestLink(clientState.toolPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, scopeId)));
      const policy = clientState.toolPolicies.find((candidate) => candidate.id === link?.toolPolicyId);
      return { ...(policy ? { policy } : {}), ...(link ? { link } : {}) };
    },
    effectivePolicyFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): ToolPolicyResolution {
      const local = this.localPolicyFor(scopeKind, scopeId);
      const clientState = useClientStateStore();
      const global = this.localPolicyFor('global');
      const globalPolicy = global.policy ?? defaultToolPolicy(clientState.toolDefinitions, 'global');
      if (scopeKind === 'global') {
        return global.policy ? global : { policy: globalPolicy, inheritedFrom: 'global' };
      }
      const layers: ToolPolicyLayer[] = [
        { scopeKind: 'global', policy: globalPolicy },
        ...(local.policy ? [{ scopeKind, policy: local.policy }] : [])
      ];
      const resolved = resolveToolPolicyLayers(
        layers,
        clientState.toolDefinitions.map((tool) => tool.name)
      );
      return {
        policy: {
          id: resolved.id ?? globalPolicy.id,
          name: local.policy?.name ?? globalPolicy.name,
          allowedTools: resolved.allowedTools,
          preset: resolved.preset,
          toolConfigs: resolved.toolConfigs,
          sourceConfigs: resolved.sourceConfigs
        },
        ...(local.link ? { link: local.link } : {}),
        ...(!local.policy ? { inheritedFrom: 'global' as const } : {})
      };
    },
    setPolicyForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, allowedTools: string[], name?: string, toolConfigs?: Record<string, ToolPolicyToolConfigRecord>, sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>, preset?: ToolPolicyPresetKind): void {
      const clientState = useClientStateStore();
      const validNames = new Set(clientState.toolDefinitions.map((tool) => tool.name));
      const sanitized = allowedTools
        .map((tool) => tool.trim())
        .filter((tool, index, list) => !!tool && validNames.has(tool) && list.indexOf(tool) === index);

      const plainToolConfigs = cloneToolConfigs(toolConfigs);
      const plainSourceConfigs = cloneSourceConfigs(sourceConfigs);
      this.applyOptimisticPolicyScopeSet(scopeKind, scopeId, sanitized, name, plainToolConfigs, plainSourceConfigs, preset);

      const payload: ToolPolicyScopeSetPayload = {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        ...(name?.trim() ? { name: name.trim() } : {}),
        allowedTools: sanitized,
        ...(preset !== undefined ? { preset } : {}),
        ...(plainToolConfigs !== undefined ? { toolConfigs: plainToolConfigs } : {}),
        ...(plainSourceConfigs !== undefined ? { sourceConfigs: plainSourceConfigs } : {})
      };
      bridge.request(BridgeMessageType.ToolPolicyScopeSet, payload);
    },
    clearPolicyScope(scopeKind: ToolPolicyScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.toolPolicyScopeLinks = clientState.toolPolicyScopeLinks.filter((link) => !scopeLinkMatches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.ToolPolicyScopeClear, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {})
      });
    },
    setPolicyPresetForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, preset: ToolPolicyPresetKind): void {
      const current = this.effectivePolicyFor(scopeKind, scopeId).policy;
      const clientState = useClientStateStore();
      const validNames = new Set(clientState.toolDefinitions.map((tool) => tool.name));
      const defaultAllowed = clientState.toolDefinitions
        .filter((tool) => tool.source?.kind !== 'mcp' && tool.metadata?.defaultEnabled !== false)
        .map((tool) => tool.name);
      const allowedTools = [...(current?.allowedTools ?? defaultAllowed)]
        .map((tool) => tool.trim())
        .filter((tool, index, list) => !!tool && validNames.has(tool) && list.indexOf(tool) === index);
      const toolConfigs = cloneToolConfigs(current?.toolConfigs) ?? {};
      const sourceConfigs = cloneSourceConfigs(current?.sourceConfigs) ?? {};
      const name = current?.name?.trim();
      this.applyOptimisticPolicyScopeSet(scopeKind, scopeId, allowedTools, current?.name, toolConfigs, sourceConfigs, preset);
      const payload: ToolPolicyScopeSetPayload = {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        ...(name ? { name } : {}),
        allowedTools,
        preset,
        toolConfigs,
        sourceConfigs
      };
      bridge.request(BridgeMessageType.ToolPolicyScopeSet, payload);
    },
    applyOptimisticPolicyScopeSet(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, allowedTools: string[], name?: string, toolConfigs?: Record<string, ToolPolicyToolConfigRecord>, sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>, preset?: ToolPolicyPresetKind): void {
      const clientState = useClientStateStore();
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      const existingLink = latestLink(clientState.toolPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, normalizedScopeId)));
      const existingPolicy = clientState.toolPolicies.find((policy) => policy.id === existingLink?.toolPolicyId);
      const policyId = existingLink?.toolPolicyId ?? policyIdForScope(scopeKind, normalizedScopeId);
      const now = Date.now();
      const nextPolicy: ToolPolicyRecord = {
        id: policyId,
        name: name?.trim() || existingPolicy?.name || defaultPolicyName(scopeKind),
        allowedTools,
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
