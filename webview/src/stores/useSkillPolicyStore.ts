import { defineStore } from 'pinia';
import type {
  SkillDefinitionRecord,
  SkillPolicyRecord,
  SkillPolicyScopeKind,
  SkillPolicyScopeLinkRecord,
  SkillPolicyScopeSetPayload,
  SkillPolicySourceConfigRecord,
  SkillSource
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';
import { useToolPolicyStore } from './useToolPolicyStore';

export interface SkillPolicyResolution {
  policy?: SkillPolicyRecord;
  link?: SkillPolicyScopeLinkRecord;
  inheritedFrom?: SkillPolicyScopeKind;
  inheritedScopeId?: string;
}

function scopeIdFor(scopeKind: SkillPolicyScopeKind, scopeId?: string): string | undefined {
  return scopeKind === 'global' ? undefined : scopeId?.trim();
}

function scopeLinkMatches(link: SkillPolicyScopeLinkRecord, scopeKind: SkillPolicyScopeKind, scopeId?: string): boolean {
  return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId);
}

function latestLink(links: SkillPolicyScopeLinkRecord[]): SkillPolicyScopeLinkRecord | undefined {
  return [...links].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function policyIdForScope(scopeKind: SkillPolicyScopeKind, scopeId?: string): string {
  return `skill-policy:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function linkIdForScope(scopeKind: SkillPolicyScopeKind, scopeId?: string): string {
  return `skill-policy-scope:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function defaultPolicyName(scopeKind: SkillPolicyScopeKind): string {
  switch (scopeKind) {
    case 'global': return '全局默认技能策略';
    case 'conversation': return '对话技能策略';
    case 'agent': return 'Agent 技能策略';
    case 'workflow': return '工作流技能策略';
    case 'run': return '运行技能策略';
  }
}

function cloneSourceConfigs(
  sourceConfigs: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> | undefined
): Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> | undefined {
  if (!sourceConfigs) return undefined;
  const cloned: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> = {};
  for (const [source, record] of Object.entries(sourceConfigs) as [SkillSource, SkillPolicySourceConfigRecord | undefined][]) {
    if (!record) continue;
    cloned[source] = {
      enabled: record.enabled !== false,
      ...(record.disabledSkills?.length ? { disabledSkills: [...record.disabledSkills] } : {})
    };
  }
  return cloned;
}

function upsertById<T extends { id: string }>(list: T[], record: T): void {
  const index = list.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
}

export const useSkillPolicyStore = defineStore('skillPolicy', {
  getters: {
    skillDefinitions(): SkillDefinitionRecord[] {
      const clientState = useClientStateStore();
      return [...clientState.skillDefinitions].sort((left, right) => left.source.localeCompare(right.source) || left.name.localeCompare(right.name));
    }
  },
  actions: {
    localPolicyFor(scopeKind: SkillPolicyScopeKind, scopeId?: string): SkillPolicyResolution {
      const clientState = useClientStateStore();
      const link = latestLink(clientState.skillPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, scopeId)));
      const policy = clientState.skillPolicies.find((candidate) => candidate.id === link?.skillPolicyId);
      return { ...(policy ? { policy } : {}), ...(link ? { link } : {}) };
    },
    /**
     * The backend's resolution (vscodeConfigurationAuthority): the nearest scope with its own skill
     * record replaces the whole policy — a Conversation inherits its workflow, then its Agent, then
     * global — so a child Agent's conversation shows the Agent's own settings, not global ones.
     */
    effectivePolicyFor(scopeKind: SkillPolicyScopeKind, scopeId?: string): SkillPolicyResolution {
      const local = this.localPolicyFor(scopeKind, scopeId);
      if (local.policy) return local;
      for (const scope of [...useToolPolicyStore().upperScopesFor(scopeKind, scopeId)].reverse()) {
        const inherited = this.localPolicyFor(scope.scopeKind, scope.scopeId);
        if (inherited.policy) {
          return { ...inherited, inheritedFrom: scope.scopeKind, ...(scope.scopeId ? { inheritedScopeId: scope.scopeId } : {}) };
        }
      }
      return {};
    },
    setPolicyForScope(
      scopeKind: SkillPolicyScopeKind,
      scopeId: string | undefined,
      sourceConfigs: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> | undefined,
      name?: string
    ): void {
      const plainSourceConfigs = cloneSourceConfigs(sourceConfigs);
      this.applyOptimisticPolicyScopeSet(scopeKind, scopeId, plainSourceConfigs, name);

      const payload: SkillPolicyScopeSetPayload = {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(plainSourceConfigs !== undefined ? { sourceConfigs: plainSourceConfigs } : {})
      };
      bridge.request(BridgeMessageType.SkillPolicyScopeSet, payload);
    },
    refreshCatalog(): void {
      bridge.request(BridgeMessageType.SkillCatalogRefresh, {});
    },
    clearPolicyScope(scopeKind: SkillPolicyScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.skillPolicyScopeLinks = clientState.skillPolicyScopeLinks.filter((link) => !scopeLinkMatches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.SkillPolicyScopeClear, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {})
      });
    },
    applyOptimisticPolicyScopeSet(
      scopeKind: SkillPolicyScopeKind,
      scopeId: string | undefined,
      sourceConfigs: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> | undefined,
      name?: string
    ): void {
      const clientState = useClientStateStore();
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      const existingLink = latestLink(clientState.skillPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, normalizedScopeId)));
      const existingPolicy = clientState.skillPolicies.find((policy) => policy.id === existingLink?.skillPolicyId);
      const policyId = existingLink?.skillPolicyId ?? policyIdForScope(scopeKind, normalizedScopeId);
      const now = Date.now();
      const nextPolicy: SkillPolicyRecord = {
        id: policyId,
        name: name?.trim() || existingPolicy?.name || defaultPolicyName(scopeKind),
        ...(sourceConfigs !== undefined
          ? { sourceConfigs: cloneSourceConfigs(sourceConfigs) ?? {} }
          : existingPolicy?.sourceConfigs
            ? { sourceConfigs: cloneSourceConfigs(existingPolicy.sourceConfigs) ?? {} }
            : {})
      };
      upsertById(clientState.skillPolicies, nextPolicy);

      const nextLink: SkillPolicyScopeLinkRecord = {
        id: existingLink?.id ?? linkIdForScope(scopeKind, normalizedScopeId),
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        skillPolicyId: policyId,
        role: 'active',
        createdAt: existingLink?.createdAt ?? now,
        updatedAt: now
      };
      upsertById(clientState.skillPolicyScopeLinks, nextLink);
    }
  }
});
