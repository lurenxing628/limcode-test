import { createStorageRevision } from '../capabilities/vscodeStorage/storageRevision';
import type { ChatModelOverrideRecord, ModelProfileScopeMutationReceipt, ModelProfileScopeSnapshotPayload, ModelProfileScopeReadPayload, SessionThinkingOverride, SystemPromptScopeSetPayload } from '../../shared/protocol';
import { hasThinkingBodyConflict } from '../../shared/sessionThinkingBody';
import { sourceConfigsProblem } from '../../shared/toolPolicyResolution';
import { requireSkillSourceConfigs } from '../world/modules/skill/policy';
import { canonicalModelProfile, loadScopedModelProfiles } from './scopedModelProfiles';
import { canonicalLlmProviderKind } from '../../shared/protocol';
import { resolveSavedSessionThinkingOverride, validateSessionThinkingOverride } from '../../shared/sessionThinking';
import { compatibleChildThinkingOverride } from './childThinkingInheritance';
import { loadLlmProviderConfigsSettings } from '../capabilities/vscodeStorage/llmProviderConfigs';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  AgentCreatePayload,
  AgentDeletePayload,
  AgentRecord,
  AgentUpdatePayload,
  CheckpointPolicyRecord,
  CheckpointPolicyScopeLinkRecord,
  CheckpointPolicyScopeSetPayload,
  ConfigScopeKind,
  ConversationWorkflowSelectPayload,
  ConversationWorkflowSelectionRecord,
  ConversationWorkEnvironmentLinkRecord,
  ModelProfileRecord,
  ModelProfileScopeLinkRecord,
  ModelProfileScopeSetPayload,
  PlanReviewPolicyRecord,
  PlanReviewPolicyScopeLinkRecord,
  PlanReviewPolicyScopeSetPayload,
  RuntimeContextRecord,
  RuntimeContextScopeLinkRecord,
  RuntimeContextScopeSetPayload,
  SkillPolicyRecord,
  SkillPolicyScopeLinkRecord,
  SkillPolicyScopeSetPayload,
  SystemPromptRecord,
  SystemPromptScopeLinkRecord,
  ToolPolicyRecord,
  ToolPolicyScopeLinkRecord,
  ToolPolicyScopeSetPayload,
  WorkEnvironmentPolicyRecord,
  WorkEnvironmentPolicyScopeLinkRecord,
  WorkEnvironmentPolicyScopeSetPayload,
  WorkEnvironmentRecord,
  WorkflowCreatePayload,
  WorkflowRecord,
  WorkflowUpdatePayload
} from '../../shared/protocol';
import {
  canRemoveWorkEnvironment,
  createLocalFolderWorkEnvironmentRecord,
  createRemoteServerWorkEnvironmentRecord,
  isLocalFolderWorkEnvironment,
  isRemoteServerWorkEnvironment,
  workEnvironmentCapabilities,
  workEnvironmentIdFromUri
} from '../../shared/workEnvironmentCatalog';
import type { StoragePaths } from '../capabilities/vscodeStorage/paths';
import {
  loadRecordStore,
  saveRecordStore,
  withRecordStoreTransaction
} from '../capabilities/vscodeStorage/recordStore';
import { createDefaultAgentBlueprints } from '../world/modules/agent/blueprints';

const BLUEPRINTS = createDefaultAgentBlueprints();
const CONFIGURATION_MUTATION_LOCK = '.configuration-authority';
const DEFAULT_CHECKPOINT_TRIGGERS: CheckpointPolicyRecord['triggers'] = {
  conversationInitial: false,
  userMessageBefore: true,
  userMessageAfter: false,
  llmResponseBefore: false,
  llmResponseAfter: false,
  agentRunCompletedBefore: false,
  agentRunCompletedAfter: false,
  manual: true
};

type ScopeKind = ConfigScopeKind;

interface ScopeRef {
  scopeKind: ScopeKind;
  scopeId?: string;
}

interface ScopeLinkBase {
  id: string;
  scopeKind: string;
  scopeId?: string;
  role: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreSpec<TRecord extends { id: string }, TKey extends string> {
  root: vscode.Uri;
  index: vscode.Uri;
  key: TKey;
  idPrefix: string;
  label(record: TRecord): string;
  /** 读取时规范化旧格式记录（例如原 DeepSeek 渠道类型）。 */
  normalize?(record: TRecord): TRecord;
}

/**
 * Settings-root mutation boundary. It never reads or writes Runtime SQLite.
 * A dedicated cross-process lock serializes multi-store record/link updates. Record-first set and
 * link-first clear never publish a dangling link. A fence between writes can leave an unreachable
 * record (new set/clear), or an updated record reachable through the existing link (update). This
 * is an uncertain partial commit, NOT a rollback; the next locked observation returns the actual
 * pair/absence, including any committed change, without compensating writes.
 */
export interface ModelProfileRootCapture { paths: StoragePaths; authorityId: string; root: string }

export class VscodeConfigurationMutations {
  private modelProfileRoot?: string;
  private modelProfileAuthorityId = randomUUID();
  private modelProfileSequence = 0;
  private modelProfileRetired = false;
  public constructor(private readonly getPaths: () => StoragePaths) {}

  /** Captured synchronously on message receipt; queued work can never resolve a new root later. */
  public captureModelProfileRoot(expectedAuthorityId?: string): ModelProfileRootCapture {
    if (this.modelProfileRetired) throw new Error('ModelProfile authority 已结束；请显式重新读取。');
    const paths = this.getPaths();
    const root = paths.settingsRootUri.toString();
    if (this.modelProfileRoot !== undefined && this.modelProfileRoot !== root) {
      this.modelProfileAuthorityId = randomUUID();
      this.modelProfileSequence = 0;
    }
    this.modelProfileRoot = root;
    if (expectedAuthorityId !== undefined && expectedAuthorityId !== this.modelProfileAuthorityId) throw new Error('ModelProfile authority/root 已改变；未自动重发，请显式重新读取。');
    return { paths, root, authorityId: this.modelProfileAuthorityId };
  }

  public retireModelProfileAuthority(): void { this.modelProfileRetired = true; }

  private assertModelProfileRoot(capture: ModelProfileRootCapture): void {
    const current = this.captureModelProfileRoot(capture.authorityId);
    if (current.root !== capture.root) throw new Error('ModelProfile root 已改变。');
  }

  private async modelProfilePair(paths: StoragePaths, scope: ScopeRef): Promise<{ profile?: ModelProfileRecord; link?: ModelProfileScopeLinkRecord; revision: string }> {
    const { modelProfiles: profiles, modelProfileScopeLinks: active } = await loadScopedModelProfiles(paths, [scope]);
    if (active.length > 1) throw new Error('ModelProfile scope 存在多个 active link。');
    const link = active[0];
    const profile = link ? profiles.find(item => item.id === link.modelProfileId) : undefined;
    if (link && !profile) throw new Error('ModelProfile scope link 指向缺失记录。');
    return { profile, link, revision: createStorageRevision({ scope, profile: profile ?? null, link: link ?? null }) };
  }

  private async modelProfileObservation(capture: ModelProfileRootCapture, scope: ScopeRef, effective?: () => Promise<ChatModelOverrideRecord | undefined>, receipt?: ModelProfileScopeMutationReceipt): Promise<ModelProfileScopeSnapshotPayload> {
    const pair = await this.modelProfilePair(capture.paths, scope);
    let effectiveModel: ChatModelOverrideRecord | undefined;
    let effectiveModelError: string | undefined;
    try {
      effectiveModel = await effective?.();
    } catch (error) {
      // The stored pair/revision remains readable when its inherited provider or model was
      // removed. Model-dependent mutations still validate effective() before writing.
      effectiveModelError = error instanceof Error ? error.message : String(error);
    }
    this.assertModelProfileRoot(capture);
    // One provider-independent shape for reads and every successful mutation, including clear.
    return { ...scope, ...pair, ...(effectiveModel ? { effectiveModel } : {}),
      ...(effectiveModelError ? { effectiveModelError } : {}), authorityId: capture.authorityId,
      sequence: ++this.modelProfileSequence, profileState: !pair.profile ? 'absent' : pair.profile.thinkingOverride ? 'overridden' : 'default',
      ...(receipt ?? {}), outcome: receipt ? 'committed' : 'observed' };
  }

  public readModelProfileScope(capture: ModelProfileRootCapture, input: ModelProfileScopeReadPayload, effective?: () => Promise<ChatModelOverrideRecord | undefined>, externalFence?: () => void): Promise<ModelProfileScopeSnapshotPayload> {
    const scope = normalizeScope(input.scopeKind, input.scopeId);
    return withRecordStoreTransaction(vscode.Uri.joinPath(capture.paths.settingsRootUri, CONFIGURATION_MUTATION_LOCK), async () => {
      this.assertModelProfileRoot(capture); externalFence?.();
      const observed = await this.modelProfileObservation(capture, scope, effective);
      externalFence?.();
      return observed;
    });
  }

  /** External UI CAS only. Internal child initialization/Fork keep their existing locked methods. */
  public writeModelProfileScope(capture: ModelProfileRootCapture, payload: ModelProfileScopeSetPayload | { scopeKind: ConfigScopeKind; scopeId?: string; authorityId?: string; expectedRevision?: string }, clear: boolean, effective?: () => Promise<ChatModelOverrideRecord | undefined>, externalFence?: () => void): Promise<ModelProfileScopeSnapshotPayload> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    if (!payload.expectedRevision || payload.authorityId !== capture.authorityId) return Promise.reject(new Error('ModelProfile 保存缺少已确认的 scope revision/authority。请先读取。'));
    return withRecordStoreTransaction(vscode.Uri.joinPath(capture.paths.settingsRootUri, CONFIGURATION_MUTATION_LOCK), async () => {
      const guard = () => { this.assertModelProfileRoot(capture); externalFence?.(); };
      guard();
      const before = await this.modelProfilePair(capture.paths, scope);
      if (before.revision !== payload.expectedRevision) throw new Error('ModelProfile 已被其他窗口修改；草稿已保留，请重新读取后决定。');
      const set = payload as ModelProfileScopeSetPayload;
      const operation = clear ? 'clear' : set.operation;
      if (!operation || (!clear && operation !== 'select' && operation !== 'thinking' && operation !== 'reset' && operation !== 'inherit')) throw new Error('ModelProfile UI mutation 缺少有效操作。');
      if (!clear && set.inheritThinkingToChildren !== undefined && scope.scopeKind !== 'conversation') {
        throw new Error('“子 Agent 也用这个思考强度”只能在对话里设置。');
      }
      const inheritThinkingToChildren = scope.scopeKind === 'conversation'
        ? set.inheritThinkingToChildren ?? before.profile?.inheritThinkingToChildren
        : undefined;
      let profile: ModelProfileRecord | undefined;
      if (!clear) {
        if (operation === 'thinking' || operation === 'reset') {
          if (scope.scopeKind !== 'conversation') throw new Error('思维覆盖仅限当前对话。');
          const current = await effective?.();
          if (!current || createStorageRevision(current) !== createStorageRevision(set.expectedEffectiveModel ?? null)) throw new Error('当前继承模型已改变；没有固定旧模型，请重新读取。');
          if (operation === 'reset') {
            if (before.profile && (!before.profile.inheritModel || inheritThinkingToChildren)) {
              const { thinkingOverride: _removed, ...kept } = before.profile;
              profile = { ...kept, ...current };
            }
          } else {
            if (set.thinkingOverride == null) throw new Error('思维修改缺少参数；恢复默认请用 reset。');
            profile = {
              ...(before.profile ?? { id: scopeRecordId('model-profile', scope), name: '会话思维覆盖', inheritModel: true }),
              ...current,
              ...(inheritThinkingToChildren ? { inheritThinkingToChildren: true } : {}),
              thinkingOverride: set.thinkingOverride
            };
          }
        } else if (operation === 'inherit') {
          if (scope.scopeKind !== 'conversation') throw new Error('“子 Agent 也用这个思考强度”只能在对话里设置。');
          const current = await effective?.();
          if (!current || createStorageRevision(current) !== createStorageRevision(set.expectedEffectiveModel ?? null)) throw new Error('当前继承模型已改变；没有固定旧模型，请重新读取。');
          profile = {
            ...(before.profile ?? { id: scopeRecordId('model-profile', scope), name: '会话思维覆盖', inheritModel: true }),
            ...current,
            inheritThinkingToChildren: inheritThinkingToChildren === true
          };
          if (before.profile && (before.profile.providerConfigId !== current.providerConfigId
            || before.profile.provider !== current.provider || before.profile.model !== current.model)) {
            delete profile.thinkingOverride;
          }
        } else {
          profile = {
            id: before.profile?.id ?? scopeRecordId('model-profile', scope),
            name: set.name?.trim() || before.profile?.name || 'LLM 配置',
            providerConfigId: set.providerConfigId,
            provider: set.provider,
            model: requireId(set.model, 'model'),
            ...(inheritThinkingToChildren ? { inheritThinkingToChildren: true } : {})
          };
        }
      }
      if (profile?.thinkingOverride) {
        const providers = await loadLlmProviderConfigsSettings(capture.paths);
        const provider = providers.settings.configs.find(item => item.id === profile!.providerConfigId);
        if (!provider || provider.provider !== profile.provider || !(provider.model === profile.model || provider.models.some(item => item.id === profile!.model))) throw new Error('思维覆盖模型已改变。');
        const modelConfig = provider.modelConfigs.find(item => item.modelId === profile!.model);
        const body = modelConfig ? modelConfig.requestBody : provider.requestBody;
        const generation = modelConfig ? modelConfig.generationConfig : provider.generationConfig;
        if (operation === 'thinking') {
          // 用户这次选择的强度：严格校验。
          if (hasThinkingBodyConflict(provider.provider, body)) throw new Error('自定义请求体与本次思维修改冲突；未改变已保存配置。');
          profile.thinkingOverride = validateSessionThinkingOverride(profile.thinkingOverride, provider.provider, profile.model, generation, body, provider);
        } else {
          // 只改“子 Agent 也用”时带着的旧覆盖：容错解析，适用就规范化，不适用就原样保留（界面显示“当前不生效”，可重置）。
          const saved = resolveSavedSessionThinkingOverride(profile.thinkingOverride, provider.provider, profile.model, generation, body, provider);
          if (saved.status === 'applied') profile.thinkingOverride = saved.override;
        }
      }
      guard();
      if (profile) {
        const next = profile;
        await this.setScoped(modelProfileStore(capture.paths), modelProfileLinkStore(capture.paths), scope, link => link.modelProfileId,
          () => next, (existing, recordId, now) => ({ id: existing?.id ?? scopeLinkId('model-profile', scope), ...scope, modelProfileId: recordId, role: 'active' as const, createdAt: existing?.createdAt ?? now, updatedAt: now }), guard);
      } else {
        await this.clearScoped(modelProfileStore(capture.paths), modelProfileLinkStore(capture.paths), scope, link => link.modelProfileId, guard);
      }
      const result = await this.modelProfileObservation(capture, scope, effective, { operation, expectedRevision: before.revision });
      guard();
      return result;
    });
  }

  public createAgent(payload: AgentCreatePayload): Promise<AgentRecord> {
    return this.mutate(async (paths) => {
      const spec = agentStore(paths);
      const records = await loadStore(spec);
      const record: AgentRecord = {
        id: `agent:${randomUUID()}`,
        name: normalizedName(payload.name, '新 Agent'),
        ...(normalizedOptionalText(payload.description) ? { description: normalizedOptionalText(payload.description) } : {}),
        kind: normalizedOptionalText(payload.kind) ?? 'custom',
        source: 'user',
        status: 'idle'
      };
      await saveStore(spec, upsert(records, record));
      return record;
    });
  }

  public updateAgent(payload: AgentUpdatePayload): Promise<AgentRecord> {
    return this.mutate(async (paths) => {
      const spec = agentStore(paths);
      const configured = await loadStore(spec);
      const id = requireId(payload.agentId, 'agentId');
      const current = configured.find((record) => record.id === id) ?? builtinAgent(id);
      if (!current) throw new Error(`Agent 不存在：${id}`);
      const description = payload.description === undefined
        ? current.description
        : normalizedOptionalText(payload.description);
      const record: AgentRecord = {
        ...current,
        id,
        name: payload.name === undefined ? current.name : normalizedName(payload.name, current.name),
        kind: payload.kind === undefined ? current.kind : normalizedName(payload.kind, current.kind),
        source: current.source,
        status: 'idle',
        ...(description ? { description } : {})
      };
      if (!description) delete record.description;
      await saveStore(spec, upsert(configured, record));
      return record;
    });
  }

  public async deleteAgent(payload: AgentDeletePayload): Promise<void> {
    const id = requireId(payload.agentId, 'agentId');
    if (builtinAgent(id)) throw new Error('内置 Agent 不能删除。');
    throw new Error('工作区隔离模式下，共享 Agent 暂不支持删除；仍可重命名或修改配置。');
  }

  public createWorkflow(payload: WorkflowCreatePayload): Promise<WorkflowRecord> {
    return this.mutate(async (paths) => {
      const spec = workflowStore(paths);
      const records = await loadStore(spec);
      const now = Date.now();
      const record: WorkflowRecord = {
        id: `workflow:${randomUUID()}`,
        name: normalizedName(payload.name, '新工作流'),
        ...(normalizedOptionalText(payload.description) ? { description: normalizedOptionalText(payload.description) } : {}),
        source: 'user',
        icon: 'list-details',
        createdAt: now,
        updatedAt: now
      };
      await saveStore(spec, upsert(records, record));
      return record;
    });
  }

  public updateWorkflow(payload: WorkflowUpdatePayload): Promise<WorkflowRecord> {
    return this.mutate(async (paths) => {
      const spec = workflowStore(paths);
      const configured = await loadStore(spec);
      const id = requireId(payload.workflowId, 'workflowId');
      const current = configured.find((record) => record.id === id) ?? builtinWorkflow(id);
      if (!current) throw new Error(`Workflow 不存在：${id}`);
      const description = payload.description === undefined
        ? current.description
        : normalizedOptionalText(payload.description);
      const record: WorkflowRecord = {
        ...current,
        id,
        name: payload.name === undefined ? current.name : normalizedName(payload.name, current.name),
        source: current.source,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
        ...(description ? { description } : {}),
        ...(payload.icon !== undefined ? { icon: payload.icon } : current.icon ? { icon: current.icon } : {})
      };
      if (!description) delete record.description;
      await saveStore(spec, upsert(configured, record));
      return record;
    });
  }

  public deleteWorkflow(workflowIdInput: string): Promise<void> {
    return this.mutate(async (paths) => {
      const workflowId = requireId(workflowIdInput, 'workflowId');
      if (builtinWorkflow(workflowId)) throw new Error('内置 Workflow 不能删除。');
      const spec = workflowStore(paths);
      const configured = await loadStore(spec);
      if (!configured.some((record) => record.id === workflowId)) return;
      await saveStore(spec, configured.filter((record) => record.id !== workflowId));
      await this.clearOwnerScopes(paths, 'workflow', workflowId);
      const selections = conversationWorkflowSelectionStore(paths);
      await saveStore(
        selections,
        (await loadStore(selections)).filter((selection) => selection.workflowId !== workflowId)
      );
    });
  }

  public synchronizeWorkspaceFolders(folders: readonly { uri: string; name: string; rootPath: string; index: number }[]): Promise<void> {
    return this.mutate(async (paths) => {
      // The store is shared by Extension Hosts. Only publish folders observed by this Host; absence
      // here must not mark a folder used by another Host unavailable or rewrite shared policy defaults.
      const spec = workEnvironmentStore(paths);
      const records = await loadStore(spec);
      const byId = new Map(records.map((record) => [record.id, record]));
      const now = Date.now();
      let environmentsChanged = false;
      for (const folder of folders) {
        const uri = requireText(folder.uri, 'workspace folder uri');
        const id = workEnvironmentIdFromUri(uri);
        const record = createLocalFolderWorkEnvironmentRecord({
          id,
          name: normalizedName(folder.name, folder.rootPath),
          uri,
          rootPath: requireText(folder.rootPath, 'workspace folder path'),
          displayPath: folder.rootPath,
          index: folder.index,
          available: true,
          createdAt: byId.get(id)?.createdAt ?? now,
          updatedAt: now
        }, now);
        const existing = byId.get(record.id);
        const next = existing && sameWorkspaceEnvironment(existing, record)
          ? existing
          : record;
        if (next !== existing) environmentsChanged = true;
        byId.set(next.id, next);
      }
      if (environmentsChanged) await saveStore(spec, [...byId.values()]);
    });
  }

  public selectConversationWorkflow(payload: ConversationWorkflowSelectPayload): Promise<void> {
    return this.mutate(async (paths) => {
      const conversationId = requireId(payload.conversationId, 'conversationId');
      const workflowId = payload.scopeKind === 'workflow' ? requireId(payload.workflowId, 'workflowId') : undefined;
      if (workflowId && !await this.workflowExists(paths, workflowId)) throw new Error(`Workflow 不存在：${workflowId}`);
      const spec = conversationWorkflowSelectionStore(paths);
      const records = await loadStore(spec);
      const existing = latest(records.filter((record) => record.conversationId === conversationId && record.role === 'active'));
      const now = Date.now();
      const record: ConversationWorkflowSelectionRecord = {
        id: payload.scopeKind === 'global'
          ? `conversation-workflow:global:${conversationId}`
          : `conversation-workflow:workflow:${conversationId}:${workflowId}`,
        conversationId,
        scopeKind: payload.scopeKind,
        ...(workflowId ? { workflowId } : {}),
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      await saveStore(
        spec,
        upsert(records.filter((candidate) => !(candidate.conversationId === conversationId && candidate.role === 'active')), record)
      );
    });
  }

  public setModelProfile(payload: ModelProfileScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    const model = requireId(payload.model, 'model');
    if (payload.inheritThinkingToChildren !== undefined && scope.scopeKind !== 'conversation') {
      throw new Error('“子 Agent 也用这个思考强度”只能在对话里设置。');
    }
    return this.mutate(async (paths) => {
      let thinkingOverride: SessionThinkingOverride | undefined;
      if (payload.thinkingOverride != null) {
        if (scope.scopeKind !== 'conversation') throw new Error('思维覆盖仅限当前对话。');
        const providers = await loadLlmProviderConfigsSettings(paths);
        const provider = providers.settings.configs.find((item) => item.id === payload.providerConfigId);
        if (!provider || provider.provider !== canonicalLlmProviderKind(payload.provider) || !(provider.model === model || provider.models.some((item) => item.id === model))) throw new Error('思维覆盖的渠道或模型不存在。');
        const modelConfig = provider.modelConfigs.find((item) => item.modelId === model);
        if (hasThinkingBodyConflict(provider.provider, modelConfig ? modelConfig.requestBody : provider.requestBody)) throw new Error('自定义请求体控制思维或输出参数；请先在渠道设置中解除冲突。');
        const generation = modelConfig ? modelConfig.generationConfig : provider.generationConfig;
        thinkingOverride = validateSessionThinkingOverride(payload.thinkingOverride, provider.provider, model, generation, modelConfig ? modelConfig.requestBody : provider.requestBody, provider);
      }
      return this.setScoped(
      modelProfileStore(paths),
      modelProfileLinkStore(paths),
      scope,
      (link) => link.modelProfileId,
      (existing, id) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultScopeName('Model Profile', scope),
        ...(normalizedOptionalText(payload.providerConfigId)
          ? { providerConfigId: normalizedOptionalText(payload.providerConfigId) }
          : existing?.providerConfigId ? { providerConfigId: existing.providerConfigId } : {}),
        ...(payload.provider ? { provider: payload.provider } : existing?.provider ? { provider: existing.provider } : {}),
        model,
        ...(thinkingOverride ? { thinkingOverride } : {}),
         ...(scope.scopeKind === 'conversation'
           && (payload.inheritThinkingToChildren ?? existing?.inheritThinkingToChildren)
           ? { inheritThinkingToChildren: true }
           : {})
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('model-profile', scope),
        ...scope,
        modelProfileId: recordId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    );
    });
  }

  /**
   * Seeds a newly-created child Conversation with its first frozen effective model. Existing
   * conversation selection is authoritative, so a user switch racing this initializer is retained.
   */
  public initializeConversationModelProfile(input: {
    conversationId: string;
    providerConfigId?: string;
    provider?: ModelProfileScopeSetPayload['provider'];
    model: string;
    thinkingOverride?: SessionThinkingOverride;
  }): Promise<{ created: boolean }> {
    const scope = normalizeScope('conversation', input.conversationId);
    const model = requireId(input.model, 'model');
    return this.mutate(async (paths) => {
      const recordStore = modelProfileStore(paths);
      const linkStore = modelProfileLinkStore(paths);
      const [records, links] = await Promise.all([loadStore(recordStore), loadStore(linkStore)]);
      const matching = links.filter((link) => scopeMatches(link, scope));
      if (matching.length > 1) {
        throw new Error(`Conversation ${scope.scopeId} 存在多个 active ModelProfileScopeLink。`);
      }
      if (matching.length === 1) {
        const recordId = matching[0].modelProfileId;
        if (!records.some((record) => record.id === recordId)) {
          throw new Error(`Conversation ${scope.scopeId} 的 ModelProfileScopeLink 指向不存在的记录。`);
        }
        return { created: false };
      }

      const now = Date.now();
      const providerConfigId = normalizedOptionalText(input.providerConfigId);
       let thinkingOverride: SessionThinkingOverride | undefined;
       if (input.thinkingOverride) {
         const providers = await loadLlmProviderConfigsSettings(paths);
         const provider = providers.settings.configs.find((item) => item.id === providerConfigId);
         if (!provider || provider.provider !== canonicalLlmProviderKind(input.provider) || !(provider.model === model || provider.models.some((item) => item.id === model))) {
           throw new Error('子会话思维覆盖的渠道或模型不存在。');
         }
         const modelConfig = provider.modelConfigs.find((item) => item.modelId === model);
         const body = modelConfig ? modelConfig.requestBody : provider.requestBody;
         thinkingOverride = compatibleChildThinkingOverride(
           input.thinkingOverride,
           provider.provider,
           model,
           modelConfig ? modelConfig.generationConfig : provider.generationConfig,
           body,
           provider
         );
       }

      const record: ModelProfileRecord = {
        id: scopeRecordId(recordStore.idPrefix, scope),
        name: '子对话继承 LLM',
        ...(providerConfigId ? { providerConfigId } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        model,
        // 只有父对话开着“派出的子 Agent 也用这个思考强度”时才会带来思考强度；继承标记一起写进子对话，
        // 这个子 Agent 再派出的孙 Agent 也按同一强度。
        ...(thinkingOverride ? { thinkingOverride, inheritThinkingToChildren: true } : {})
      };
      const link: ModelProfileScopeLinkRecord = {
        id: scopeLinkId('model-profile', scope),
        ...scope,
        modelProfileId: record.id,
        role: 'active',
        createdAt: now,
        updatedAt: now
      };
      await saveStore(recordStore, upsert(records, record));
      await saveStore(linkStore, upsert(links, link));
      return { created: true };
    });
  }

  public clearModelProfile(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      modelProfileStore(paths), modelProfileLinkStore(paths), scope, (link) => link.modelProfileId
    ));
  }

  public setToolPolicy(payload: ToolPolicyScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    // Refuse source settings the policy would only read as a disabled source, naming the field.
    const sourceProblem = sourceConfigsProblem(payload.sourceConfigs);
    if (sourceProblem) return Promise.reject(new TypeError(`工具策略的 ${sourceProblem}`));
    // The payload states the record's whole list: absent saves a record that narrows nothing.
    const allowedTools = payload.allowedTools === undefined ? undefined : uniqueStrings(payload.allowedTools);
    return this.mutate((paths) => this.setScoped(
      toolPolicyStore(paths),
      toolPolicyLinkStore(paths),
      scope,
      (link) => link.toolPolicyId,
      (existing, id) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultPolicyName('工具', scope.scopeKind),
        ...(allowedTools ? { allowedTools } : {}),
        ...(payload.preset !== undefined ? { preset: payload.preset } : existing?.preset !== undefined ? { preset: existing.preset } : {}),
        ...(payload.toolConfigs !== undefined ? { toolConfigs: plainClone(payload.toolConfigs) } : existing?.toolConfigs ? { toolConfigs: plainClone(existing.toolConfigs) } : {}),
        ...(payload.sourceConfigs !== undefined ? { sourceConfigs: plainClone(payload.sourceConfigs) } : existing?.sourceConfigs ? { sourceConfigs: plainClone(existing.sourceConfigs) } : {})
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('tool-policy', scope),
        ...scope,
        toolPolicyId: recordId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearToolPolicy(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      toolPolicyStore(paths), toolPolicyLinkStore(paths), scope, (link) => link.toolPolicyId
    ));
  }

  public setSkillPolicy(payload: SkillPolicyScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    let sourceConfigs: SkillPolicyRecord['sourceConfigs'];
    try {
      sourceConfigs = payload.sourceConfigs === undefined
        ? undefined
        : requireSkillSourceConfigs(payload.sourceConfigs, 'Skill Policy sourceConfigs');
    } catch (error) {
      return Promise.reject(error);
    }
    return this.mutate((paths) => this.setScoped(
      skillPolicyStore(paths),
      skillPolicyLinkStore(paths),
      scope,
      (link) => link.skillPolicyId,
      (existing, id) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultPolicyName('技能', scope.scopeKind),
        ...(sourceConfigs !== undefined ? { sourceConfigs } : existing?.sourceConfigs ? { sourceConfigs: plainClone(existing.sourceConfigs) } : {})
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('skill-policy', scope),
        ...scope,
        skillPolicyId: recordId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearSkillPolicy(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      skillPolicyStore(paths), skillPolicyLinkStore(paths), scope, (link) => link.skillPolicyId
    ));
  }

  public setSystemPrompt(payload: SystemPromptScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    const text = requireText(payload.text, 'System Prompt');
    return this.mutate((paths) => this.setScoped(
      systemPromptStore(paths),
      systemPromptLinkStore(paths),
      scope,
      (link) => link.systemPromptId,
      (existing, id) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultScopeName('System Prompt', scope),
        text
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('system-prompt', scope),
        ...scope,
        systemPromptId: recordId,
        role: 'active' as const,
        ...(payload.order !== undefined ? { order: finiteInteger(payload.order, 0) } : existing?.order !== undefined ? { order: existing.order } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearSystemPrompt(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      systemPromptStore(paths), systemPromptLinkStore(paths), scope, (link) => link.systemPromptId
    ));
  }

  public setRuntimeContext(payload: RuntimeContextScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    const template = requireText(payload.template, 'Runtime Context template');
    return this.mutate((paths) => this.setScoped(
      runtimeContextStore(paths),
      runtimeContextLinkStore(paths),
      scope,
      (link) => link.runtimeContextId,
      (existing, id) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultScopeName('Runtime Context', scope),
        template
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('runtime-context', scope),
        ...scope,
        runtimeContextId: recordId,
        role: 'active' as const,
        ...(payload.order !== undefined ? { order: finiteInteger(payload.order, 0) } : existing?.order !== undefined ? { order: existing.order } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearRuntimeContext(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      runtimeContextStore(paths), runtimeContextLinkStore(paths), scope, (link) => link.runtimeContextId
    ));
  }

  public setPlanReviewPolicy(payload: PlanReviewPolicyScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    const required = uniqueRiskLevels(payload.requireForToolRiskLevels);
    return this.mutate((paths) => this.setScoped(
      planReviewPolicyStore(paths),
      planReviewPolicyLinkStore(paths),
      scope,
      (link) => link.planReviewPolicyId,
      (existing, id, now) => ({
        id,
        mode: payload.mode,
        allowReadonlyBeforeApproval: payload.allowReadonlyBeforeApproval ?? existing?.allowReadonlyBeforeApproval ?? true,
        requireForToolRiskLevels: required.length > 0 ? required : existing?.requireForToolRiskLevels ?? ['write', 'command', 'agent'],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? planReviewScopeLinkId(scope),
        ...scope,
        planReviewPolicyId: recordId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearPlanReviewPolicy(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      planReviewPolicyStore(paths), planReviewPolicyLinkStore(paths), scope, (link) => link.planReviewPolicyId
    ));
  }

  public setCheckpointPolicy(payload: CheckpointPolicyScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    return this.mutate((paths) => this.setScoped(
      checkpointPolicyStore(paths),
      checkpointPolicyLinkStore(paths),
      scope,
      (link) => link.checkpointPolicyId,
      (existing, id, now) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultPolicyName('存档点', scope.scopeKind),
        enabled: payload.enabled ?? existing?.enabled ?? true,
        initialSnapshotMaxBytes: positiveInteger(payload.initialSnapshotMaxBytes, existing?.initialSnapshotMaxBytes ?? 50 * 1024 * 1024),
        preserveEmptyDirectories: payload.preserveEmptyDirectories ?? existing?.preserveEmptyDirectories ?? true,
        useGitignore: payload.useGitignore ?? existing?.useGitignore ?? true,
        skipPatterns: uniqueStrings(payload.skipPatterns ?? existing?.skipPatterns ?? ['node_modules/', 'dist/', 'out/', 'build/']),
        triggers: {
          ...(existing?.triggers ?? DEFAULT_CHECKPOINT_TRIGGERS),
          ...(payload.triggers ?? {})
        },
        toolTriggers: normalizeCheckpointToolTriggers(existing?.toolTriggers, payload.toolTriggers),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('checkpoint-policy', scope),
        ...scope,
        checkpointPolicyId: recordId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearCheckpointPolicy(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      checkpointPolicyStore(paths), checkpointPolicyLinkStore(paths), scope, (link) => link.checkpointPolicyId
    ));
  }

  public setWorkEnvironmentPolicy(payload: WorkEnvironmentPolicyScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    return this.mutate(async (paths) => {
      const configured = await loadStore(workEnvironmentStore(paths));
      const existingIds = new Set(configured.map((record) => record.id));
      const allowed = uniqueStrings(payload.allowedWorkEnvironmentIds).filter((id) => existingIds.has(id));
      const defaultId = normalizedOptionalText(payload.defaultWorkEnvironmentId);
      if (defaultId && !allowed.includes(defaultId)) throw new Error('默认工作环境必须包含在允许列表中。');
      await this.setScoped(
        workEnvironmentPolicyStore(paths),
        workEnvironmentPolicyLinkStore(paths),
        scope,
        (link) => link.workEnvironmentPolicyId,
        (existing, id, now) => ({
          id,
          name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultPolicyName('工作环境', scope.scopeKind),
          enabled: payload.enabled ?? existing?.enabled ?? false,
          allowedWorkEnvironmentIds: allowed,
          ...(defaultId ? { defaultWorkEnvironmentId: defaultId } : {}),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        }),
        (existing, recordId, now) => ({
          id: existing?.id ?? scopeLinkId('work-environment-policy', scope),
          ...scope,
          workEnvironmentPolicyId: recordId,
          role: 'active' as const,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        })
      );
    });
  }

  public clearWorkEnvironmentPolicy(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      workEnvironmentPolicyStore(paths), workEnvironmentPolicyLinkStore(paths), scope, (link) => link.workEnvironmentPolicyId
    ));
  }

  public async upsertWorkEnvironment(input: WorkEnvironmentRecord): Promise<WorkEnvironmentRecord> {
    return (await this.upsertWorkEnvironments([input]))[0];
  }

  public upsertWorkEnvironments(inputs: readonly WorkEnvironmentRecord[]): Promise<WorkEnvironmentRecord[]> {
    return this.mutate(async (paths) => {
      const spec = workEnvironmentStore(paths);
      let records = await loadStore(spec);
      const saved: WorkEnvironmentRecord[] = [];
      for (const input of inputs) {
        const record = normalizeWorkEnvironmentRecord(input, records.find((candidate) => candidate.id === input.id));
        records = upsert(records, record);
        saved.push(record);
      }
      await saveStore(spec, records);
      return saved;
    });
  }

  public removeWorkEnvironment(workEnvironmentIdInput: string): Promise<void> {
    return this.mutate(async (paths) => {
      const workEnvironmentId = requireId(workEnvironmentIdInput, 'workEnvironmentId');
      const spec = workEnvironmentStore(paths);
      const records = await loadStore(spec);
      const record = records.find((candidate) => candidate.id === workEnvironmentId);
      if (!record) return;
      if (!canRemoveWorkEnvironment(record)) throw new Error('系统管理的工作环境不能删除。');
      await saveStore(spec, records.filter((candidate) => candidate.id !== workEnvironmentId));

      // Keep explicit selections and policy identities. A deleted selected/default environment
      // must remain a visible error until the user chooses another root, never become implicit A.
    });
  }

  public selectConversationWorkEnvironment(conversationIdInput: string, workEnvironmentIdInput: string): Promise<void> {
    return this.mutate(async (paths) => {
      const conversationId = requireId(conversationIdInput, 'conversationId');
      const workEnvironmentId = requireId(workEnvironmentIdInput, 'workEnvironmentId');
      const environment = (await loadStore(workEnvironmentStore(paths))).find((record) => record.id === workEnvironmentId);
      if (!environment?.available) throw new Error(`工作环境不可用：${workEnvironmentId}`);
      const spec = conversationWorkEnvironmentLinkStore(paths);
      const records = await loadStore(spec);
      const existing = latest(records.filter((record) => record.conversationId === conversationId && record.role === 'active'));
      const now = Date.now();
      const record: ConversationWorkEnvironmentLinkRecord = {
        id: existing?.id ?? `conversation-work-environment:${conversationId}`,
        conversationId,
        workEnvironmentId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      await saveStore(
        spec,
        upsert(records.filter((candidate) => !(candidate.conversationId === conversationId && candidate.role === 'active')), record)
      );
    });
  }

  /**
   * Seeds a newly created Conversation's work environment. An existing selection is authoritative,
   * so replaying the seed never overwrites a later user choice.
   */
  public initializeConversationWorkEnvironment(
    conversationIdInput: string,
    workEnvironmentIdInput: string
  ): Promise<{ created: boolean }> {
    return this.mutate(async (paths) => {
      const conversationId = requireId(conversationIdInput, 'conversationId');
      const workEnvironmentId = requireId(workEnvironmentIdInput, 'workEnvironmentId');
      const spec = conversationWorkEnvironmentLinkStore(paths);
      const records = await loadStore(spec);
      if (records.some((record) => record.conversationId === conversationId && record.role === 'active')) {
        return { created: false };
      }
      const environment = (await loadStore(workEnvironmentStore(paths))).find((record) => record.id === workEnvironmentId);
      if (!environment?.available) throw new Error(`工作环境不可用：${workEnvironmentId}`);
      const now = Date.now();
      const record: ConversationWorkEnvironmentLinkRecord = {
        id: `conversation-work-environment:${conversationId}`,
        conversationId,
        workEnvironmentId,
        role: 'active' as const,
        createdAt: now,
        updatedAt: now
      };
      await saveStore(spec, upsert(records, record));
      return { created: true };
    });
  }

  /**
   * Copies every Conversation-layer selection that defines a fork's execution identity: all scoped
   * record/link pairs, the workflow selection and the work-environment link. Only empty target
   * slots are filled, so repeating an interrupted copy never overwrites what the target already
   * owns. Global, Agent and Workflow layers are neither read nor written.
   */
  public copyConversationConfiguration(
    sourceConversationIdInput: string,
    targetConversationIdInput: string
  ): Promise<void> {
    const sourceConversationId = requireId(sourceConversationIdInput, 'sourceConversationId');
    const targetConversationId = requireId(targetConversationIdInput, 'targetConversationId');
    if (sourceConversationId === targetConversationId) {
      throw new TypeError('Conversation configuration fork requires different source and target ids.');
    }
    return this.mutate(async (paths) => {
      const source: ScopeRef = { scopeKind: 'conversation', scopeId: sourceConversationId };
      const target: ScopeRef = { scopeKind: 'conversation', scopeId: targetConversationId };
      await this.copyScoped(modelProfileStore(paths), modelProfileLinkStore(paths), source, target,
        (link) => link.modelProfileId,
        (link, modelProfileId, now) => ({ ...link, id: scopeLinkId('model-profile', target), ...target, modelProfileId, createdAt: now, updatedAt: now }));
      await this.copyScoped(planReviewPolicyStore(paths), planReviewPolicyLinkStore(paths), source, target,
        (link) => link.planReviewPolicyId,
        (link, planReviewPolicyId, now) => ({ ...link, id: planReviewScopeLinkId(target), ...target, planReviewPolicyId, createdAt: now, updatedAt: now }));
      await this.copyScoped(toolPolicyStore(paths), toolPolicyLinkStore(paths), source, target,
        (link) => link.toolPolicyId,
        (link, toolPolicyId, now) => ({ ...link, id: scopeLinkId('tool-policy', target), ...target, toolPolicyId, createdAt: now, updatedAt: now }));
      await this.copyScoped(skillPolicyStore(paths), skillPolicyLinkStore(paths), source, target,
        (link) => link.skillPolicyId,
        (link, skillPolicyId, now) => ({ ...link, id: scopeLinkId('skill-policy', target), ...target, skillPolicyId, createdAt: now, updatedAt: now }));
      await this.copyScoped(systemPromptStore(paths), systemPromptLinkStore(paths), source, target,
        (link) => link.systemPromptId,
        (link, systemPromptId, now) => ({ ...link, id: scopeLinkId('system-prompt', target), ...target, systemPromptId, createdAt: now, updatedAt: now }));
      await this.copyScoped(runtimeContextStore(paths), runtimeContextLinkStore(paths), source, target,
        (link) => link.runtimeContextId,
        (link, runtimeContextId, now) => ({ ...link, id: scopeLinkId('runtime-context', target), ...target, runtimeContextId, createdAt: now, updatedAt: now }));
      await this.copyScoped(workEnvironmentPolicyStore(paths), workEnvironmentPolicyLinkStore(paths), source, target,
        (link) => link.workEnvironmentPolicyId,
        (link, workEnvironmentPolicyId, now) => ({ ...link, id: scopeLinkId('work-environment-policy', target), ...target, workEnvironmentPolicyId, createdAt: now, updatedAt: now }));
      await this.copyScoped(checkpointPolicyStore(paths), checkpointPolicyLinkStore(paths), source, target,
        (link) => link.checkpointPolicyId,
        (link, checkpointPolicyId, now) => ({ ...link, id: scopeLinkId('checkpoint-policy', target), ...target, checkpointPolicyId, createdAt: now, updatedAt: now }));

      const workflowStore = conversationWorkflowSelectionStore(paths);
      const workflowSelections = await loadStore(workflowStore);
      const sourceWorkflow = latest(workflowSelections.filter((record) =>
        record.conversationId === sourceConversationId && record.role === 'active'
      ));
      const targetWorkflow = latest(workflowSelections.filter((record) =>
        record.conversationId === targetConversationId && record.role === 'active'
      ));
      if (sourceWorkflow && !targetWorkflow) {
        const now = Date.now();
        const copy: ConversationWorkflowSelectionRecord = {
          ...plainClone(sourceWorkflow),
          id: sourceWorkflow.scopeKind === 'global'
            ? `conversation-workflow:global:${targetConversationId}`
            : `conversation-workflow:workflow:${targetConversationId}:${sourceWorkflow.workflowId}`,
          conversationId: targetConversationId,
          createdAt: now,
          updatedAt: now
        };
        await saveStore(workflowStore, upsert(workflowSelections, copy));
      }

      const environmentStore = conversationWorkEnvironmentLinkStore(paths);
      const environmentLinks = await loadStore(environmentStore);
      const sourceEnvironment = latest(environmentLinks.filter((record) =>
        record.conversationId === sourceConversationId && record.role === 'active'
      ));
      const targetEnvironment = latest(environmentLinks.filter((record) =>
        record.conversationId === targetConversationId && record.role === 'active'
      ));
      if (sourceEnvironment && !targetEnvironment) {
        const now = Date.now();
        const copy: ConversationWorkEnvironmentLinkRecord = {
          ...plainClone(sourceEnvironment),
          id: `conversation-work-environment:${targetConversationId}`,
          conversationId: targetConversationId,
          createdAt: now,
          updatedAt: now
        };
        await saveStore(environmentStore, upsert(environmentLinks, copy));
      }
    });
  }

  /**
   * Removes every Conversation-layer selection of a Conversation id that will never exist, such as
   * a permanently rejected fork target: exactly what copyConversationConfiguration can write (the
   * scoped record/link pairs, the workflow selection and the work-environment link). Global, Agent
   * and Workflow layers are neither read nor written.
   */
  public clearConversationConfiguration(conversationIdInput: string): Promise<void> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    return this.mutate(async (paths) => {
      await this.clearOwnerScopes(paths, 'conversation', conversationId);
      const workflowStore = conversationWorkflowSelectionStore(paths);
      const workflowSelections = await loadStore(workflowStore);
      if (workflowSelections.some((record) => record.conversationId === conversationId)) {
        await saveStore(workflowStore, workflowSelections.filter((record) => record.conversationId !== conversationId));
      }
      const environmentStore = conversationWorkEnvironmentLinkStore(paths);
      const environmentLinks = await loadStore(environmentStore);
      if (environmentLinks.some((record) => record.conversationId === conversationId)) {
        await saveStore(environmentStore, environmentLinks.filter((record) => record.conversationId !== conversationId));
      }
    });
  }

  private mutate<T>(action: (paths: StoragePaths) => Promise<T>): Promise<T> {
    const paths = this.getPaths();
    const lockUri = vscode.Uri.joinPath(paths.settingsRootUri, CONFIGURATION_MUTATION_LOCK);
    return withRecordStoreTransaction(lockUri, () => action(paths));
  }

  private async workflowExists(paths: StoragePaths, workflowId: string): Promise<boolean> {
    return !!builtinWorkflow(workflowId)
      || (await loadStore(workflowStore(paths))).some((record) => record.id === workflowId);
  }

  private async clearOwnerScopes(paths: StoragePaths, scopeKind: ScopeKind, scopeId: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    await this.clearScoped(modelProfileStore(paths), modelProfileLinkStore(paths), scope, (link) => link.modelProfileId);
    await this.clearScoped(planReviewPolicyStore(paths), planReviewPolicyLinkStore(paths), scope, (link) => link.planReviewPolicyId);
    await this.clearScoped(toolPolicyStore(paths), toolPolicyLinkStore(paths), scope, (link) => link.toolPolicyId);
    await this.clearScoped(skillPolicyStore(paths), skillPolicyLinkStore(paths), scope, (link) => link.skillPolicyId);
    await this.clearScoped(systemPromptStore(paths), systemPromptLinkStore(paths), scope, (link) => link.systemPromptId);
    await this.clearScoped(runtimeContextStore(paths), runtimeContextLinkStore(paths), scope, (link) => link.runtimeContextId);
    await this.clearScoped(workEnvironmentPolicyStore(paths), workEnvironmentPolicyLinkStore(paths), scope, (link) => link.workEnvironmentPolicyId);
    await this.clearScoped(checkpointPolicyStore(paths), checkpointPolicyLinkStore(paths), scope, (link) => link.checkpointPolicyId);
  }

  /** Copies one scope's active record/link pair into an empty target scope as the target's own record. */
  private async copyScoped<
    TRecord extends { id: string },
    TLink extends ScopeLinkBase,
    TRecordKey extends string,
    TLinkKey extends string
  >(
    recordStore: StoreSpec<TRecord, TRecordKey>,
    linkStore: StoreSpec<TLink, TLinkKey>,
    source: ScopeRef,
    target: ScopeRef,
    linkedRecordId: (link: TLink) => string,
    buildLink: (source: TLink, recordId: string, now: number) => TLink
  ): Promise<void> {
    const [records, links] = await Promise.all([loadStore(recordStore), loadStore(linkStore)]);
    const sourceLink = latest(links.filter((link) => scopeMatches(link, source)));
    if (!sourceLink || links.some((link) => scopeMatches(link, target))) return;
    const sourceRecord = records.find((record) => record.id === linkedRecordId(sourceLink));
    if (!sourceRecord) throw new Error(`配置 Link ${sourceLink.id} 指向不存在的记录。`);
    const recordId = scopeRecordId(recordStore.idPrefix, target);
    await saveStore(recordStore, upsert(records, { ...plainClone(sourceRecord), id: recordId }));
    await saveStore(linkStore, upsert(links, buildLink(plainClone(sourceLink), recordId, Date.now())));
  }

  private async setScoped<
    TRecord extends { id: string },
    TLink extends ScopeLinkBase,
    TRecordKey extends string,
    TLinkKey extends string
  >(
    recordStore: StoreSpec<TRecord, TRecordKey>,
    linkStore: StoreSpec<TLink, TLinkKey>,
    scope: ScopeRef,
    linkedRecordId: (link: TLink) => string,
    buildRecord: (existing: TRecord | undefined, id: string, now: number) => TRecord,
    buildLink: (existing: TLink | undefined, recordId: string, now: number) => TLink,
    guard: () => void = () => undefined
  ): Promise<void> {
    const [records, links] = await Promise.all([loadStore(recordStore), loadStore(linkStore)]);
    const matching = links.filter((link) => scopeMatches(link, scope));
    const existingLink = latest(matching);
    const recordId = existingLink ? linkedRecordId(existingLink) : scopeRecordId(recordStore.idPrefix, scope);
    const existingRecord = records.find((record) => record.id === recordId);
    const now = Date.now();
    const record = buildRecord(existingRecord, recordId, now);
    guard();
    await saveStore(recordStore, upsert(records, record));
    const link = buildLink(existingLink, record.id, now);
    guard();
    await saveStore(linkStore, upsert(links.filter((candidate) => !scopeMatches(candidate, scope)), link));
  }

  private async clearScoped<
    TRecord extends { id: string },
    TLink extends ScopeLinkBase,
    TRecordKey extends string,
    TLinkKey extends string
  >(
    recordStore: StoreSpec<TRecord, TRecordKey>,
    linkStore: StoreSpec<TLink, TLinkKey>,
    scope: ScopeRef,
    linkedRecordId: (link: TLink) => string,
    guard: () => void = () => undefined
  ): Promise<void> {
    const [records, links] = await Promise.all([loadStore(recordStore), loadStore(linkStore)]);
    const removed = links.filter((link) => scopeMatches(link, scope));
    if (removed.length === 0) return;
    const nextLinks = links.filter((link) => !scopeMatches(link, scope));
    guard();
    await saveStore(linkStore, nextLinks);
    const stillReferenced = new Set(nextLinks.map(linkedRecordId));
    const removedRecordIds = new Set(removed.map(linkedRecordId));
    guard();
    await saveStore(recordStore, records.filter((record) => !removedRecordIds.has(record.id) || stillReferenced.has(record.id)));
  }

}

function agentStore(paths: StoragePaths): StoreSpec<AgentRecord, 'agent'> {
  return { root: paths.agentsRootUri, index: paths.agentsIndexUri, key: 'agent', idPrefix: 'agent', label: (record) => record.name };
}

function workflowStore(paths: StoragePaths): StoreSpec<WorkflowRecord, 'workflow'> {
  return { root: paths.workflowsRootUri, index: paths.workflowsIndexUri, key: 'workflow', idPrefix: 'workflow', label: (record) => record.name };
}

function modelProfileStore(paths: StoragePaths): StoreSpec<ModelProfileRecord, 'modelProfile'> {
  return {
    root: paths.modelProfilesRootUri, index: paths.modelProfilesIndexUri, key: 'modelProfile', idPrefix: 'model-profile',
    label: (record) => record.name, normalize: canonicalModelProfile
  };
}

function modelProfileLinkStore(paths: StoragePaths): StoreSpec<ModelProfileScopeLinkRecord, 'link'> {
  return { root: paths.modelProfileScopeLinksRootUri, index: paths.modelProfileScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function planReviewPolicyStore(paths: StoragePaths): StoreSpec<PlanReviewPolicyRecord, 'policy'> {
  return { root: paths.planReviewPoliciesRootUri, index: paths.planReviewPoliciesIndexUri, key: 'policy', idPrefix: 'plan-review-policy', label: (record) => record.id };
}

function planReviewPolicyLinkStore(paths: StoragePaths): StoreSpec<PlanReviewPolicyScopeLinkRecord, 'link'> {
  return { root: paths.planReviewPolicyScopeLinksRootUri, index: paths.planReviewPolicyScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function toolPolicyStore(paths: StoragePaths): StoreSpec<ToolPolicyRecord, 'toolPolicy'> {
  return { root: paths.toolPoliciesRootUri, index: paths.toolPoliciesIndexUri, key: 'toolPolicy', idPrefix: 'tool-policy', label: (record) => record.name };
}

function toolPolicyLinkStore(paths: StoragePaths): StoreSpec<ToolPolicyScopeLinkRecord, 'link'> {
  return { root: paths.toolPolicyScopeLinksRootUri, index: paths.toolPolicyScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function skillPolicyStore(paths: StoragePaths): StoreSpec<SkillPolicyRecord, 'skillPolicy'> {
  return { root: paths.skillPoliciesRootUri, index: paths.skillPoliciesIndexUri, key: 'skillPolicy', idPrefix: 'skill-policy', label: (record) => record.name };
}

function skillPolicyLinkStore(paths: StoragePaths): StoreSpec<SkillPolicyScopeLinkRecord, 'link'> {
  return { root: paths.skillPolicyScopeLinksRootUri, index: paths.skillPolicyScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function systemPromptStore(paths: StoragePaths): StoreSpec<SystemPromptRecord, 'systemPrompt'> {
  return { root: paths.systemPromptsRootUri, index: paths.systemPromptsIndexUri, key: 'systemPrompt', idPrefix: 'system-prompt', label: (record) => record.name };
}

function systemPromptLinkStore(paths: StoragePaths): StoreSpec<SystemPromptScopeLinkRecord, 'link'> {
  return { root: paths.systemPromptScopeLinksRootUri, index: paths.systemPromptScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function runtimeContextStore(paths: StoragePaths): StoreSpec<RuntimeContextRecord, 'runtimeContext'> {
  return { root: paths.runtimeContextsRootUri, index: paths.runtimeContextsIndexUri, key: 'runtimeContext', idPrefix: 'runtime-context', label: (record) => record.name };
}

function runtimeContextLinkStore(paths: StoragePaths): StoreSpec<RuntimeContextScopeLinkRecord, 'link'> {
  return { root: paths.runtimeContextScopeLinksRootUri, index: paths.runtimeContextScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function workEnvironmentStore(paths: StoragePaths): StoreSpec<WorkEnvironmentRecord, 'workEnvironment'> {
  return { root: paths.workEnvironmentsRootUri, index: paths.workEnvironmentsIndexUri, key: 'workEnvironment', idPrefix: 'work-environment', label: (record) => record.name };
}

function workEnvironmentPolicyStore(paths: StoragePaths): StoreSpec<WorkEnvironmentPolicyRecord, 'policy'> {
  return { root: paths.workEnvironmentPoliciesRootUri, index: paths.workEnvironmentPoliciesIndexUri, key: 'policy', idPrefix: 'work-environment-policy', label: (record) => record.name };
}

function workEnvironmentPolicyLinkStore(paths: StoragePaths): StoreSpec<WorkEnvironmentPolicyScopeLinkRecord, 'link'> {
  return { root: paths.workEnvironmentPolicyScopeLinksRootUri, index: paths.workEnvironmentPolicyScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function checkpointPolicyStore(paths: StoragePaths): StoreSpec<CheckpointPolicyRecord, 'policy'> {
  return { root: paths.checkpointPoliciesRootUri, index: paths.checkpointPoliciesIndexUri, key: 'policy', idPrefix: 'checkpoint-policy', label: (record) => record.name };
}

function checkpointPolicyLinkStore(paths: StoragePaths): StoreSpec<CheckpointPolicyScopeLinkRecord, 'link'> {
  return { root: paths.checkpointPolicyScopeLinksRootUri, index: paths.checkpointPolicyScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function conversationWorkflowSelectionStore(paths: StoragePaths): StoreSpec<ConversationWorkflowSelectionRecord, 'selection'> {
  return {
    root: paths.conversationWorkflowSelectionsRootUri,
    index: paths.conversationWorkflowSelectionsIndexUri,
    key: 'selection',
    idPrefix: 'conversation-workflow',
    label: (record) => record.id
  };
}

function conversationWorkEnvironmentLinkStore(paths: StoragePaths): StoreSpec<ConversationWorkEnvironmentLinkRecord, 'link'> {
  return {
    root: paths.conversationWorkEnvironmentLinksRootUri,
    index: paths.conversationWorkEnvironmentLinksIndexUri,
    key: 'link',
    idPrefix: 'conversation-work-environment',
    label: (record) => record.id
  };
}

async function loadStore<TRecord extends { id: string }, TKey extends string>(
  spec: StoreSpec<TRecord, TKey>
): Promise<TRecord[]> {
  const records = (await loadRecordStore<TRecord, TKey>(spec.root, spec.index, spec.key)) ?? [];
  return spec.normalize ? records.map((record) => spec.normalize!(record)) : records;
}

async function saveStore<TRecord extends { id: string }, TKey extends string>(
  spec: StoreSpec<TRecord, TKey>,
  records: TRecord[]
): Promise<void> {
  await saveRecordStore(spec.root, spec.index, records, spec.key, spec.label, { pruneMissing: true });
}

function normalizeScope(scopeKind: ScopeKind, scopeIdInput?: string): ScopeRef {
  if (!['global', 'conversation', 'agent', 'workflow', 'run'].includes(scopeKind)) {
    throw new TypeError(`不支持的配置作用域：${String(scopeKind)}`);
  }
  if (scopeKind === 'global') return { scopeKind };
  return { scopeKind, scopeId: requireId(scopeIdInput, `${scopeKind} scopeId`) };
}

function scopeMatches(link: ScopeLinkBase, scope: ScopeRef): boolean {
  return link.role === 'active'
    && link.scopeKind === scope.scopeKind
    && (scope.scopeKind === 'global' ? link.scopeId === undefined : link.scopeId === scope.scopeId);
}

function scopeRecordId(prefix: string, scope: ScopeRef): string {
  return `${prefix}:${scope.scopeKind}:${scope.scopeId ?? 'global'}`;
}

function scopeLinkId(prefix: string, scope: ScopeRef): string {
  return `${prefix}-scope:${scope.scopeKind}:${scope.scopeId ?? 'global'}`;
}

function planReviewScopeLinkId(scope: ScopeRef): string {
  return scope.scopeKind === 'global'
    ? 'plan-review-policy-link:global'
    : `plan-review-policy-link:${scope.scopeKind}:${scope.scopeId}`;
}

function defaultScopeName(kind: string, scope: ScopeRef): string {
  return `${scope.scopeKind === 'global' ? 'Global' : scope.scopeKind} ${kind}`;
}

function defaultPolicyName(domain: string, scopeKind: ScopeKind): string {
  const prefix = scopeKind === 'global'
    ? '全局默认'
    : scopeKind === 'conversation'
      ? '对话'
      : scopeKind === 'agent'
        ? 'Agent '
        : scopeKind === 'workflow'
          ? '工作流'
          : '运行';
  return `${prefix}${domain}策略`;
}

function upsert<T extends { id: string }>(records: T[], record: T): T[] {
  return [...records.filter((candidate) => candidate.id !== record.id), record];
}

function latest<T extends { id: string; createdAt: number; updatedAt: number }>(records: T[]): T | undefined {
  return [...records].sort((left, right) =>
    right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  )[0];
}

function sameWorkspaceEnvironment(left: WorkEnvironmentRecord, right: WorkEnvironmentRecord): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.source === right.source
    && left.name === right.name
    && left.uri === right.uri
    && left.rootPath === right.rootPath
    && left.displayPath === right.displayPath
    && left.index === right.index
    && left.available === right.available;
}

function builtinAgent(id: string): AgentRecord | undefined {
  const definition = BLUEPRINTS.agents[id] ?? Object.values(BLUEPRINTS.agents).find((candidate) => candidate.id === id);
  return definition ? {
    id: definition.id,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    kind: definition.kind,
    source: 'builtin',
    status: 'idle'
  } : undefined;
}

function builtinWorkflow(id: string): WorkflowRecord | undefined {
  const definition = BLUEPRINTS.workflows[id] ?? Object.values(BLUEPRINTS.workflows).find((candidate) => candidate.id === id);
  return definition ? {
    id: definition.id,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    source: 'builtin',
    ...(definition.icon ? { icon: definition.icon } : {}),
    createdAt: 0,
    updatedAt: 0
  } : undefined;
}

function normalizeWorkEnvironmentRecord(input: WorkEnvironmentRecord, existing: WorkEnvironmentRecord | undefined): WorkEnvironmentRecord {
  const id = requireId(input.id, 'workEnvironment.id');
  const now = Date.now();
  if (isRemoteServerWorkEnvironment(input)) {
    return createRemoteServerWorkEnvironmentRecord({
      ...plainClone(input),
      id,
      host: requireText(input.host ?? input.name, 'workEnvironment.host'),
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now
    }, now);
  }
  if (isLocalFolderWorkEnvironment(input)) {
    return createLocalFolderWorkEnvironmentRecord({
      ...plainClone(input),
      id,
      name: normalizedName(input.name, existing?.name ?? id),
      uri: requireText(input.uri, 'workEnvironment.uri'),
      rootPath: requireText(input.rootPath, 'workEnvironment.rootPath'),
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now
    }, now);
  }
  return {
    ...plainClone(input),
    id,
    name: normalizedName(input.name, existing?.name ?? id),
    available: input.available !== false,
    capabilities: workEnvironmentCapabilities(input),
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now
  };
}

function normalizeCheckpointToolTriggers(
  current: CheckpointPolicyRecord['toolTriggers'] | undefined,
  input: CheckpointPolicyScopeSetPayload['toolTriggers']
): CheckpointPolicyRecord['toolTriggers'] {
  const result: CheckpointPolicyRecord['toolTriggers'] = plainClone(current ?? {});
  for (const [name, config] of Object.entries(input ?? {})) {
    const key = name.trim();
    if (!key) continue;
    result[key] = {
      before: config.before ?? result[key]?.before ?? false,
      after: config.after ?? result[key]?.after ?? false
    };
  }
  return result;
}

function uniqueRiskLevels(
  input: PlanReviewPolicyScopeSetPayload['requireForToolRiskLevels']
): PlanReviewPolicyRecord['requireForToolRiskLevels'] {
  return [...new Set((input ?? []).filter((level) => level === 'write' || level === 'command' || level === 'agent'))];
}

function uniqueStrings(input: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of input) {
    const normalized = value.trim();
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizedName(input: unknown, fallback: string): string {
  return normalizedOptionalText(input)?.replace(/\s+/g, ' ') ?? fallback;
}

function normalizedOptionalText(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}

function requireId(input: unknown, label: string): string {
  const value = normalizedOptionalText(input);
  if (!value) throw new TypeError(`${label} 必须是非空字符串。`);
  return value;
}

function requireText(input: unknown, label: string): string {
  return requireId(input, label);
}

function positiveInteger(input: unknown, fallback: number): number {
  return typeof input === 'number' && Number.isFinite(input) && input > 0 ? Math.floor(input) : fallback;
}

function finiteInteger(input: unknown, fallback: number): number {
  return typeof input === 'number' && Number.isFinite(input) ? Math.floor(input) : fallback;
}

function plainClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
