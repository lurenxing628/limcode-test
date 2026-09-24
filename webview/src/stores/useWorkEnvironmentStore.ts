import { defineStore } from 'pinia';
import {
  createMessageId,
  type ConversationWorkEnvironmentLinkRecord,
  type WorkEnvironmentPolicyRecord,
  type WorkEnvironmentPolicyScopeKind,
  type WorkEnvironmentPolicyScopeLinkRecord,
  type WorkEnvironmentPolicyScopeSetPayload,
  type WorkEnvironmentKind,
  type WorkEnvironmentRecord
} from '@shared/protocol';
import {
  canRemoveWorkEnvironment,
  createRemoteServerWorkEnvironmentRecord,
  isRemoteServerWorkEnvironment,
  isRemoteServerWorkEnvironmentKind,
  workEnvironmentSortKey as buildWorkEnvironmentSortKey
} from '@shared/workEnvironmentCatalog';
import {
  resolveWorkEnvironmentSelection,
  type WorkEnvironmentSelection,
  type WorkEnvironmentSelectionPolicy
} from '@shared/workEnvironmentSelection';
import { useReliableKernelClientFeedStore } from './useReliableKernelClientFeedStore';
import { useAgentStore } from './useAgentStore';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';
import { DEFAULT_WORKFLOW_OPTION_ID, useWorkflowStore } from './useWorkflowStore';

export interface WorkEnvironmentPolicyResolution {
  policy?: WorkEnvironmentPolicyRecord;
  link?: WorkEnvironmentPolicyScopeLinkRecord;
  inheritedFrom?: WorkEnvironmentPolicyScopeKind | 'workflow' | 'fallback';
}

function scopeIdFor(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): string | undefined {
  return scopeKind === 'global' ? undefined : scopeId?.trim();
}

function scopeLinkMatches(link: WorkEnvironmentPolicyScopeLinkRecord, scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): boolean {
  return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId);
}

function latestLink(links: WorkEnvironmentPolicyScopeLinkRecord[]): WorkEnvironmentPolicyScopeLinkRecord | undefined {
  return [...links].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function policyIdForScope(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): string {
  return `work-environment-policy:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function linkIdForScope(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): string {
  return `work-environment-policy-scope:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function defaultPolicyName(scopeKind: WorkEnvironmentPolicyScopeKind): string {
  switch (scopeKind) {
    case 'global': return '全局默认工作环境策略';
    case 'conversation': return '对话工作环境策略';
    case 'agent': return 'Agent 工作环境策略';
    case 'workflow': return '工作流工作环境策略';
    case 'run': return '运行工作环境策略';
  }
}

function upsertById<T extends { id: string }>(list: T[], record: T): void {
  const index = list.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
}

function workEnvironmentSortKey(environment: WorkEnvironmentRecord): string {
  return buildWorkEnvironmentSortKey(environment);
}

function uniqueAllowed(ids: readonly string[]): string[] {
  const result: string[] = [];
  for (const id of ids) {
    const text = id.trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function availableEnvironmentIds(): string[] {
  const clientState = useClientStateStore();
  return sortedWorkEnvironments(clientState.workEnvironments.filter((environment) => environment.available)).map((environment) => environment.id);
}

function sortedWorkEnvironments(items: WorkEnvironmentRecord[]): WorkEnvironmentRecord[] {
  return [...items].sort((left, right) => workEnvironmentSortKey(left).localeCompare(workEnvironmentSortKey(right), 'zh-CN') || left.id.localeCompare(right.id));
}

function fallbackPolicy(): WorkEnvironmentPolicyRecord | undefined {
  const ids = availableEnvironmentIds();
  if (ids.length === 0) return undefined;
  const now = Date.now();
  return { id: 'work-environment-policy:fallback', name: '默认工作环境策略', enabled: false, allowedWorkEnvironmentIds: ids, createdAt: now, updatedAt: now };
}

function sanitizePolicyInput(allowedIds: string[], defaultId?: string): { allowed: string[]; defaultId?: string } {
  // Use record existence instead of projected `available` to avoid revoking persisted policy
  // entries whose `available` flag is temporarily false due to Host-scoped workspace-folder projection.
  const existing = new Set(useClientStateStore().workEnvironments.map((environment) => environment.id));
  const allowed = uniqueAllowed(allowedIds).filter((id) => existing.has(id));
  const resolvedDefault = defaultId && allowed.includes(defaultId) ? defaultId : undefined;
  return { allowed, ...(resolvedDefault ? { defaultId: resolvedDefault } : {}) };
}

export const useWorkEnvironmentStore = defineStore('workEnvironment', {
  state: () => ({ status: '' }),
  getters: {
    environments(): WorkEnvironmentRecord[] {
      const clientState = useClientStateStore();
      return sortedWorkEnvironments(clientState.workEnvironments);
    },
    availableEnvironments(): WorkEnvironmentRecord[] {
      return this.environments.filter((environment) => environment.available);
    },
    remoteServerEnvironments(): WorkEnvironmentRecord[] {
      return this.environments.filter((environment) => isRemoteServerWorkEnvironment(environment));
    }
  },
  actions: {
    localPolicyFor(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): WorkEnvironmentPolicyResolution {
      const clientState = useClientStateStore();
      const link = latestLink(clientState.workEnvironmentPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, scopeId)));
      const policy = clientState.workEnvironmentPolicies.find((candidate) => candidate.id === link?.workEnvironmentPolicyId);
      return { ...(policy ? { policy } : {}), ...(link ? { link } : {}) };
    },
    effectivePolicyFor(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): WorkEnvironmentPolicyResolution {
      const local = this.localPolicyFor(scopeKind, scopeId);
      if (local.policy) return local;
      if (scopeKind !== 'global') {
        const global = this.localPolicyFor('global');
        if (global.policy) return { ...global, inheritedFrom: 'global' };
      }
      const fallback = fallbackPolicy();
      return fallback ? { policy: fallback, inheritedFrom: 'fallback' } : {};
    },
    effectivePolicyForConversation(conversationId: string): WorkEnvironmentPolicyResolution {
      if (!conversationId) return this.effectivePolicyFor('global');
      const local = this.localPolicyFor('conversation', conversationId);
      if (local.policy) return local;
      const workflowStore = useWorkflowStore();
      const activeWorkflowId = workflowStore.activeWorkflowIdForConversation(conversationId);
      if (activeWorkflowId && activeWorkflowId !== DEFAULT_WORKFLOW_OPTION_ID) {
        const workflowPolicy = this.localPolicyFor('workflow', activeWorkflowId);
        if (workflowPolicy.policy) return { ...workflowPolicy, inheritedFrom: 'workflow' };
      }
      const agent = useAgentStore().activeAgentForConversation(conversationId);
      if (agent) {
        const agentPolicy = this.localPolicyFor('agent', agent.id);
        if (agentPolicy.policy) return { ...agentPolicy, inheritedFrom: 'agent' };
      }
      return this.effectivePolicyFor('global');
    },
    workEnvironmentEnabledForConversation(conversationId: string): boolean {
      return this.effectivePolicyForConversation(conversationId).policy?.enabled === true;
    },
    /**
     * The work environments a child Agent conversation's next Turn inherits (its latest Turn's frozen
     * list and directory), as the kernel applies them; undefined for any other conversation.
     */
    childInheritedWorkEnvironmentPolicy(conversationId: string): WorkEnvironmentSelectionPolicy | 'unknown' | undefined {
      const feed = useReliableKernelClientFeedStore();
      const child = Object.values(feed.records.ChildExecution ?? {}).some(record => record.child_conversation_id === conversationId);
      if (!child) return undefined;
      const window = feed.projections.activeConversationWindow as Record<string, unknown> | undefined;
      const boundary = window?.childConversationBoundary as Record<string, unknown> | null | undefined;
      if (!boundary || boundary.conversationId !== conversationId) return 'unknown';
      const frozen = boundary.workEnvironment as Record<string, unknown> | null | undefined;
      // A latest Turn that froze no work environments bounds nothing, as in the kernel.
      if (!frozen || !Array.isArray(frozen.allowedWorkEnvironmentIds)) return undefined;
      return {
        allowedWorkEnvironmentIds: frozen.allowedWorkEnvironmentIds.filter((id): id is string => typeof id === 'string'),
        defaultWorkEnvironmentId: typeof frozen.defaultWorkEnvironmentId === 'string' ? frozen.defaultWorkEnvironmentId : null
      };
    },
    environmentSelectionForConversation(conversationId: string): WorkEnvironmentSelection {
      const clientState = useClientStateStore();
      const feed = useReliableKernelClientFeedStore();
      const inheritedPolicy = this.childInheritedWorkEnvironmentPolicy(conversationId);
      if (inheritedPolicy === 'unknown') return { allowed: [], error: '子 Agent 对话的工作目录范围暂不可用，请稍后再试。' };
      const projectLinks = Object.values(feed.records.ConversationProjectLink ?? {}).filter(link =>
        link.conversation_id === conversationId && link.role === 'primary');
      const project = projectLinks.length === 1
        ? feed.records.ProjectContext?.[String(projectLinks[0].project_context_id)] : undefined;
      const selected = [...clientState.conversationWorkEnvironmentLinks]
        .filter(link => link.conversationId === conversationId && link.role === 'active')
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
      return resolveWorkEnvironmentSelection({
        environments: clientState.workEnvironments,
        policy: this.effectivePolicyForConversation(conversationId).policy,
        ...(inheritedPolicy ? { inheritedPolicy } : {}),
        explicitWorkEnvironmentId: selected?.workEnvironmentId,
        ...(typeof project?.uri === 'string' ? { project: { uri: project.uri } } : {}),
        projectMissing: projectLinks.length > 0 && typeof project?.uri !== 'string'
      });
    },
    frozenEnvironmentSelectionForConversation(conversationId: string): WorkEnvironmentSelection | undefined {
      const feed = useReliableKernelClientFeedStore();
      const window = feed.projections.activeConversationWindow as Record<string, unknown> | undefined;
      const frozen = window?.activeTurnWorkEnvironment as Record<string, unknown> | null | undefined;
      if (!frozen || frozen.conversationId !== conversationId) {
        const active = Object.values(feed.records.Turn ?? {}).some(turn => turn.conversation_id === conversationId && turn.status === 'active');
        return active ? { allowed: [], error: '本回合工作目录信息不可用。' } : undefined;
      }
      if (!Array.isArray(frozen.allowedWorkEnvironmentIds)) return undefined;
      const allowedWorkEnvironmentIds = frozen.allowedWorkEnvironmentIds.filter((id): id is string => typeof id === 'string');
      const defaultWorkEnvironmentId = typeof frozen.defaultWorkEnvironmentId === 'string' ? frozen.defaultWorkEnvironmentId : undefined;
      // A null frozen default is also authoritative: do not invent a root from today's candidates.
      if (!defaultWorkEnvironmentId) return { allowed: [] };
      return resolveWorkEnvironmentSelection({
        environments: useClientStateStore().workEnvironments,
        policy: { allowedWorkEnvironmentIds, defaultWorkEnvironmentId },
        explicitWorkEnvironmentId: defaultWorkEnvironmentId
      });
    },
    allowedEnvironmentsForConversation(conversationId: string): WorkEnvironmentRecord[] {
      return this.environmentSelectionForConversation(conversationId).allowed;
    },
    activeEnvironmentForConversation(conversationId: string): WorkEnvironmentRecord | undefined {
      return this.environmentSelectionForConversation(conversationId).active;
    },
    selectConversationEnvironment(conversationId: string, workEnvironmentId: string): void {
      if (!conversationId || !workEnvironmentId) return;
      const allowed = new Set(this.allowedEnvironmentsForConversation(conversationId).map((environment) => environment.id));
      if (!allowed.has(workEnvironmentId)) return;
      const clientState = useClientStateStore();
      const now = Date.now();
      const existing = clientState.conversationWorkEnvironmentLinks.find((link) => link.conversationId === conversationId && link.role === 'active');
      const link: ConversationWorkEnvironmentLinkRecord = {
        id: existing?.id ?? `cwel-local-${createMessageId()}`,
        conversationId,
        workEnvironmentId,
        role: 'active',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      clientState.conversationWorkEnvironmentLinks = clientState.conversationWorkEnvironmentLinks.filter((candidate) => !(candidate.conversationId === conversationId && candidate.role === 'active'));
      upsertById(clientState.conversationWorkEnvironmentLinks, link);
      bridge.request(BridgeMessageType.WorkEnvironmentSelect, { conversationId, workEnvironmentId });
    },
    setPolicyForScope(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId: string | undefined, allowedIds: string[], defaultId?: string, name?: string, enabled?: boolean): void {
      const sanitized = sanitizePolicyInput(allowedIds, defaultId);
      const resolvedEnabled = enabled ?? this.effectivePolicyFor(scopeKind, scopeId).policy?.enabled ?? false;
      this.applyOptimisticPolicyScopeSet(scopeKind, scopeId, sanitized.allowed, sanitized.defaultId, name, resolvedEnabled);
      const payload: WorkEnvironmentPolicyScopeSetPayload = {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        ...(name?.trim() ? { name: name.trim() } : {}),
        enabled: resolvedEnabled,
        allowedWorkEnvironmentIds: sanitized.allowed,
        ...(sanitized.defaultId ? { defaultWorkEnvironmentId: sanitized.defaultId } : {})
      };
      bridge.request(BridgeMessageType.WorkEnvironmentPolicyScopeSet, payload);
    },
    clearPolicyScope(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.workEnvironmentPolicyScopeLinks = clientState.workEnvironmentPolicyScopeLinks.filter((link) => !scopeLinkMatches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.WorkEnvironmentPolicyScopeClear, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {})
      });
    },
    applyOptimisticPolicyScopeSet(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId: string | undefined, allowedIds: string[], defaultId?: string, name?: string, enabled?: boolean): void {
      const clientState = useClientStateStore();
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      const existingLink = latestLink(clientState.workEnvironmentPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, normalizedScopeId)));
      const existingPolicy = clientState.workEnvironmentPolicies.find((policy) => policy.id === existingLink?.workEnvironmentPolicyId);
      const policyId = existingLink?.workEnvironmentPolicyId ?? policyIdForScope(scopeKind, normalizedScopeId);
      const now = Date.now();
      const policy: WorkEnvironmentPolicyRecord = {
        id: policyId,
        name: name?.trim() || existingPolicy?.name || defaultPolicyName(scopeKind),
        enabled: enabled ?? existingPolicy?.enabled ?? false,
        allowedWorkEnvironmentIds: allowedIds,
        ...(defaultId ? { defaultWorkEnvironmentId: defaultId } : {}),
        createdAt: existingPolicy?.createdAt ?? now,
        updatedAt: now
      };
      upsertById(clientState.workEnvironmentPolicies, policy);
      const link: WorkEnvironmentPolicyScopeLinkRecord = {
        id: existingLink?.id ?? linkIdForScope(scopeKind, normalizedScopeId),
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        workEnvironmentPolicyId: policyId,
        role: 'active',
        createdAt: existingLink?.createdAt ?? now,
        updatedAt: now
      };
      upsertById(clientState.workEnvironmentPolicyScopeLinks, link);
    },
    upsertEnvironmentRecord(record: WorkEnvironmentRecord): string {
      const clientState = useClientStateStore();
      upsertById(clientState.workEnvironments, record);
      this.ensureEnvironmentAllowedInGlobal(record.id);
      bridge.request(BridgeMessageType.WorkEnvironmentUpsert, { workEnvironment: record });
      return record.id;
    },
    createEnvironment(kind: WorkEnvironmentKind, seed: string): string | undefined {
      const text = seed.trim();
      if (!text) return undefined;
      if (isRemoteServerWorkEnvironmentKind(kind)) {
        return this.upsertRemoteServerEnvironment({ host: text, name: text, source: 'manual', available: true });
      }
      return undefined;
    },
    updateEnvironment(workEnvironmentId: string, patch: Partial<WorkEnvironmentRecord>): string | undefined {
      const clientState = useClientStateStore();
      const existing = clientState.workEnvironments.find((item) => item.id === workEnvironmentId);
      if (!existing) return undefined;
      if (isRemoteServerWorkEnvironment(existing)) {
        return this.upsertRemoteServerEnvironment({ ...existing, ...patch, id: existing.id });
      }
      const now = Date.now();
      return this.upsertEnvironmentRecord({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: now });
    },
    upsertRemoteServerEnvironment(patch: Partial<WorkEnvironmentRecord> & { id?: string; host?: string; name?: string }): string {
      const clientState = useClientStateStore();
      const now = Date.now();
      const existing = patch.id ? clientState.workEnvironments.find((item) => item.id === patch.id) : undefined;
      const host = (patch.host ?? patch.name ?? existing?.host ?? existing?.name ?? 'server').trim() || 'server';
      const id = existing?.id ?? patch.id ?? `work-env-remote-${createMessageId()}`;
      const hasField = (key: keyof WorkEnvironmentRecord): boolean => Object.prototype.hasOwnProperty.call(patch, key);
      const stringField = (key: keyof WorkEnvironmentRecord): string | undefined => {
        const value = hasField(key) ? patch[key] : existing?.[key];
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
      };
      const port = hasField('port') ? normalizePort(patch.port) : normalizePort(existing?.port);
      const user = stringField('user');
      const identityFile = stringField('identityFile');
      const password = identityFile ? undefined : hasField('password') ? patch.password : existing?.password;
      const workdir = stringField('workdir');
      const os = stringField('os');
      const description = stringField('description');
      const record = createRemoteServerWorkEnvironmentRecord({
        id,
        source: patch.source ?? existing?.source ?? 'manual',
        name: (patch.name ?? existing?.name ?? host).trim() || host,
        host,
        port,
        user,
        identityFile,
        ...(typeof password === 'string' ? { password } : {}),
        workdir,
        os,
        description,
        available: patch.available ?? existing?.available ?? true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
      return this.upsertEnvironmentRecord(record);
    },
    removeEnvironment(workEnvironmentId: string): void {
      const clientState = useClientStateStore();
      const environment = clientState.workEnvironments.find((candidate) => candidate.id === workEnvironmentId);
      if (!environment || !canRemoveWorkEnvironment(environment)) return;
      clientState.workEnvironments = clientState.workEnvironments.filter((candidate) => candidate.id !== workEnvironmentId);
      // Retain selected/default identities so a deleted environment produces a visible error.
      bridge.request(BridgeMessageType.WorkEnvironmentRemove, { workEnvironmentId });
    },
    importFromVscode(): void {
      this.status = '正在从 VS Code SSH 配置导入工作环境...';
      bridge.request(BridgeMessageType.WorkEnvironmentImportFromVscode, { includeDefaultSshConfig: true });
    },
    ensureEnvironmentAllowedInGlobal(workEnvironmentId: string): void {
      const global = this.effectivePolicyFor('global').policy;
      const allowed = uniqueAllowed([...(global?.allowedWorkEnvironmentIds ?? availableEnvironmentIds()), workEnvironmentId]);
      const defaultId = global?.defaultWorkEnvironmentId;
      this.applyOptimisticPolicyScopeSet('global', undefined, allowed, defaultId, global?.name, global?.enabled ?? false);
    }
  }
});

function normalizePort(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : undefined;
  return number !== undefined && Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
