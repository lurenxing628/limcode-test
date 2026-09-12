import type * as vscode from 'vscode';
import type {
  AgentRecord,
  ChatModelOverrideRecord,
  CheckpointPolicyRecord,
  CheckpointPolicyScopeLinkRecord,
  ClientState,
  ConfigScopeKind,
  ConversationWorkflowSelectionRecord,
  ConversationWorkEnvironmentLinkRecord,
  GlobalSettingsRecord,
  GlobalSettingsSection,
  GlobalSettingsSectionValue,
  LlmCompressionConfigsRecord,
  LlmCompressionConfigRecord,
  LlmCompressionSettingsRecord,
  LlmProviderConfigRecord,
  LlmProviderConfigsRecord,
  LlmSettingsRecord,
  McpServersSettingsRecord,
  ModelProfileRecord,
  ModelProfileScopeLinkRecord,
  PlanReviewPolicyRecord,
  PlanReviewPolicyScopeLinkRecord,
  RuleFileRecord,
  RuleScope,
  RuntimeContextRecord,
  RuntimeContextScopeLinkRecord,
  SkillPolicyRecord,
  SkillPolicyScopeLinkRecord,
  SystemPromptRecord,
  SystemPromptScopeLinkRecord,
  ToolPolicyRecord,
  ToolPolicyScopeLinkRecord,
  WorkEnvironmentPolicyRecord,
  WorkEnvironmentPolicyScopeLinkRecord,
  WorkEnvironmentRecord,
  WorkflowRecord
} from '../../shared/protocol';
import { normalizePlainJson } from './plainJson';
import type { RequestCompressionSettings } from './requestCompressionSettings';
import {
  DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS,
  DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS,
  MAX_LLM_RETRY_DELAY_SECONDS,
  MAX_RELIABLE_PROVIDER_RETRY_ATTEMPTS
} from '../../shared/protocol';
import { createEmptyClientState } from '../../shared/clientStateSchema';
import { normalizeOpenAIResponsesNativeSettings } from '../../shared/openAIResponsesCapabilities';
import { resolveToolPolicyLayers, type ToolPolicyLayer } from '../../shared/toolPolicyResolution';
import {
  createLocalFolderWorkEnvironmentRecord,
  isLocalFolderWorkEnvironment,
  workEnvironmentIdFromUri
} from '../../shared/workEnvironmentCatalog';
import type { FrozenWorkEnvironmentBoundaryPolicy } from './workEnvironmentBoundary';
import { loadGlobalSettingsFile, writeGlobalSettingsFile } from '../capabilities/vscodeStorage/globalSettings';
import {
  loadLlmCompressionConfigsSettings,
  normalizeLlmCompressionSettings,
  saveLlmCompressionConfigsSettings
} from '../capabilities/vscodeStorage/llmCompressionConfigs';
import {
  loadLlmProviderConfigsSettings,
  saveLlmProviderConfigsSettings
} from '../capabilities/vscodeStorage/llmProviderConfigs';
import { loadMcpServersSettings, saveMcpServersSettings } from '../capabilities/vscodeStorage/mcpServers';
import {
  createGlobalSettingsRecord,
  globalStatusFileUri,
  globalStatusRevision,
  LIMCODE_GLOBAL_STATUS_LABEL,
  loadCommittedGlobalStatus,
  saveGlobalStatusExpected,
  resolveDataRootUri
} from '../capabilities/vscodeStorage/globalStatus';
import type { StoragePaths } from '../capabilities/vscodeStorage/paths';
import {
  composeRuntimeContextRuleParts,
  renderReliableRuntimeContextTemplate,
  renderReliableSystemPromptTemplate,
  type ReliablePromptRenderContext
} from './runtimeContextRendering';
import { loadRecordStore } from '../capabilities/vscodeStorage/recordStore';
import {
  createDefaultAgentBlueprints
} from '../world/modules/agent/blueprints';
import { composeSystemInstruction, type SystemPromptTextPart } from '../world/modules/chat/systemPromptText';
import { VscodeConfigurationMutations } from './vscodeConfigurationMutations';
import type { AttachmentSettingsAuthority } from './attachmentIngest';
import type {
  CompiledTurnAuthority,
  TurnAuthorityCompilationRequest,
  TurnAuthorityCompiler
} from './turnControlPlane';

const BUILTIN_BLUEPRINTS = createDefaultAgentBlueprints();
const BUILTIN_AGENT_DEFINITIONS = BUILTIN_BLUEPRINTS.agents;
const BUILTIN_WORKFLOW_DEFINITIONS = BUILTIN_BLUEPRINTS.workflows;

interface ConfigurationRecords {
  agents: AgentRecord[];
  workflows: WorkflowRecord[];
  modelProfiles: ModelProfileRecord[];
  modelProfileScopeLinks: ModelProfileScopeLinkRecord[];
  planReviewPolicies: PlanReviewPolicyRecord[];
  planReviewPolicyScopeLinks: PlanReviewPolicyScopeLinkRecord[];
  toolPolicies: ToolPolicyRecord[];
  toolPolicyScopeLinks: ToolPolicyScopeLinkRecord[];
  skillPolicies: SkillPolicyRecord[];
  skillPolicyScopeLinks: SkillPolicyScopeLinkRecord[];
  systemPrompts: SystemPromptRecord[];
  systemPromptScopeLinks: SystemPromptScopeLinkRecord[];
  runtimeContexts: RuntimeContextRecord[];
  runtimeContextScopeLinks: RuntimeContextScopeLinkRecord[];
  workEnvironments: WorkEnvironmentRecord[];
  workEnvironmentPolicies: WorkEnvironmentPolicyRecord[];
  workEnvironmentPolicyScopeLinks: WorkEnvironmentPolicyScopeLinkRecord[];
  checkpointPolicies: CheckpointPolicyRecord[];
  checkpointPolicyScopeLinks: CheckpointPolicyScopeLinkRecord[];
  conversationWorkflowSelections: ConversationWorkflowSelectionRecord[];
  conversationWorkEnvironmentLinks: ConversationWorkEnvironmentLinkRecord[];
  providerConfigs: LlmProviderConfigRecord[];
  activeProviderConfigId: string;
  compressionConfigs: LlmCompressionConfigRecord[];
  compressionSettings: LlmCompressionSettingsRecord;
}

type ConfigurationClientRecords = Omit<ConfigurationRecords,
  'providerConfigs' | 'activeProviderConfigId' | 'compressionConfigs' | 'compressionSettings'>;

interface CurrentWorkspaceFolder {
  uri: string;
  name: string;
  rootPath: string;
  index: number;
}

/** 每次 operation 重新经 getPaths 解析 settings authority；不读取或写入 Runtime SQLite。 */
export class VscodeConfigurationAuthority implements TurnAuthorityCompiler, AttachmentSettingsAuthority {
  public readonly mutations: VscodeConfigurationMutations;
  /** Host-local workspace presence; shared WorkEnvironment records must not encode another Host's view. */
  private currentWorkspaceFolderIds = new Set<string>();
  private currentWorkspaceFolderRecords = new Map<string, WorkEnvironmentRecord>();
  private currentWorkspaceFolders: readonly CurrentWorkspaceFolder[] = [];

  public constructor(
    private readonly getPaths: () => StoragePaths,
    private readonly context?: vscode.ExtensionContext,
    currentWorkspaceFolders: readonly CurrentWorkspaceFolder[] = []
  ) {
    this.mutations = new VscodeConfigurationMutations(getPaths);
    this.setCurrentWorkspaceFolders(currentWorkspaceFolders);
  }

  public async compile(request: TurnAuthorityCompilationRequest): Promise<CompiledTurnAuthority> {
    const records = await this.loadRecords();
    const agentId = requireId(request.executorAgentId, 'executorAgentId');
    const agent = records.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`配置 authority 中不存在 executor Agent：${agentId}`);
    const builtinAgent = BUILTIN_AGENT_DEFINITIONS[agent.kind] ?? BUILTIN_AGENT_DEFINITIONS[agent.id];
    const workflowSelection = latestScopedSelection(
      records.conversationWorkflowSelections.filter((selection) =>
        selection.conversationId === request.conversationId && selection.role === 'active'
      )
    );
    const workflowId = workflowSelection?.scopeKind === 'workflow' ? workflowSelection.workflowId : undefined;
    const workflow = workflowId ? records.workflows.find((candidate) => candidate.id === workflowId) : undefined;
    const builtinWorkflow = workflow
      ? BUILTIN_WORKFLOW_DEFINITIONS[workflow.id]
        ?? Object.values(BUILTIN_WORKFLOW_DEFINITIONS).find((candidate) => candidate.id === workflow.id)
      : undefined;
    const scopesLowToHigh: ScopeReference[] = [
      { scopeKind: 'global' },
      { scopeKind: 'agent', scopeId: agentId },
      ...(workflowId ? [{ scopeKind: 'workflow' as const, scopeId: workflowId }] : []),
      { scopeKind: 'conversation', scopeId: request.conversationId },
      { scopeKind: 'run', scopeId: request.turnId }
    ];
    const scopesHighToLow = [...scopesLowToHigh].reverse();

    const inheritedModelFallback = request.modelFallback;
    const nonGlobalModelProfile = inheritedModelFallback
      ? resolveScopedRecord(
          records.modelProfileScopeLinks,
          records.modelProfiles,
          scopesHighToLow.filter((scope) => scope.scopeKind !== 'global'),
          (link) => link.modelProfileId
        )
      : undefined;
    const globalModelProfile = inheritedModelFallback
      ? resolveRecordAtScope(
          records.modelProfileScopeLinks,
          records.modelProfiles,
          { scopeKind: 'global' },
          (link) => link.modelProfileId
        )
      : undefined;
    const modelProfile = inheritedModelFallback
      ? nonGlobalModelProfile
      : resolveScopedRecord(
          records.modelProfileScopeLinks,
          records.modelProfiles,
          scopesHighToLow,
          (link) => link.modelProfileId
        );
    const builtinModel = builtinWorkflow?.model ?? builtinAgent?.model;
    const requestedModel = request.modelOverride;
    const selectedModel: {
      providerConfigId?: string;
      provider?: LlmProviderConfigRecord['provider'];
      model: string;
    } | undefined = requestedModel
      ?? modelProfile
      ?? builtinModel
      ?? inheritedModelFallback
      ?? globalModelProfile;
    const providerConfigId = selectedModel?.providerConfigId?.trim() || records.activeProviderConfigId;
    const provider = resolveRequestedProvider(records.providerConfigs, {
      providerConfigId,
      providerKind: selectedModel?.provider,
      modelId: selectedModel?.model
    });
    if (!provider) throw new Error('没有可用的 LLM Provider 配置。');
    const modelId = selectedModel?.model?.trim() || provider.model?.trim();
    if (!modelId) throw new Error(`Provider ${provider.id} 没有可用模型。`);
    if (!providerContainsModel(provider, modelId)) {
      throw new Error(`Provider ${provider.id} 不包含 ModelProfile 冻结的模型 ${modelId}。`);
    }

    const planReviewPolicy = resolveScopedRecord(
      records.planReviewPolicyScopeLinks,
      records.planReviewPolicies,
      scopesHighToLow,
      (link) => link.planReviewPolicyId
    );
    const builtinPlanReviewPolicy = builtinWorkflow?.planReviewPolicy;
    const toolPolicyLayers: ToolPolicyLayer[] = [];
    for (const scope of scopesLowToHigh) {
      const configured = resolveRecordAtScope(
        records.toolPolicyScopeLinks,
        records.toolPolicies,
        scope,
        (link) => link.toolPolicyId
      );
      if (configured) {
        toolPolicyLayers.push({ scopeKind: scope.scopeKind, policy: configured });
        continue;
      }
      const builtin = scope.scopeKind === 'agent'
        ? builtinAgent?.toolPolicy
        : scope.scopeKind === 'workflow'
          ? builtinWorkflow?.toolPolicy
          : undefined;
      if (builtin) {
        toolPolicyLayers.push({
          scopeKind: scope.scopeKind,
          policy: {
            allowedTools: builtin.allowedTools,
            toolConfigs: builtin.toolConfigs
          }
        });
      }
    }
    const toolPolicy = resolveToolPolicyLayers(toolPolicyLayers);
    const skillPolicy = resolveScopedRecord(
      records.skillPolicyScopeLinks,
      records.skillPolicies,
      scopesHighToLow,
      (link) => link.skillPolicyId
    );
    const systemPrompts = resolveScopedRecords(
      records.systemPromptScopeLinks,
      records.systemPrompts,
      scopesLowToHigh,
      (link) => link.systemPromptId
    );
    const agentPrompt = resolveRecordAtScope(
      records.systemPromptScopeLinks,
      records.systemPrompts,
      { scopeKind: 'agent', scopeId: agentId },
      (link) => link.systemPromptId
    );
    const workflowPrompt = workflowId ? resolveRecordAtScope(
      records.systemPromptScopeLinks,
      records.systemPrompts,
      { scopeKind: 'workflow', scopeId: workflowId },
      (link) => link.systemPromptId
    ) : undefined;
    const globalPrompt = resolveRecordAtScope(
      records.systemPromptScopeLinks,
      records.systemPrompts,
      { scopeKind: 'global' },
      (link) => link.systemPromptId
    );
    const orderedPromptParts = [
      globalPrompt,
      agentPrompt ?? builtinSystemPromptPart(builtinAgent?.systemPrompt),
      workflowPrompt ?? builtinSystemPromptPart(builtinWorkflow?.systemPrompt),
      ...systemPrompts.filter((prompt) =>
        prompt !== globalPrompt && prompt !== agentPrompt && prompt !== workflowPrompt
      )
    ].filter((part): part is SystemPromptTextPart => !!part?.text.trim());
    const systemPrompt = systemPrompts[systemPrompts.length - 1];
    const runtimeContexts = resolveScopedRecords(
      records.runtimeContextScopeLinks,
      records.runtimeContexts,
      scopesLowToHigh,
      (link) => link.runtimeContextId
    );
    const runtimeContext = runtimeContexts[runtimeContexts.length - 1];
    const workEnvironmentPolicy = resolveScopedRecord(
      records.workEnvironmentPolicyScopeLinks,
      records.workEnvironmentPolicies,
      scopesHighToLow,
      (link) => link.workEnvironmentPolicyId
    );
    const selectedModelConfig = provider.modelConfigs.find((candidate) => candidate.modelId === modelId);
    const systemPromptPrefix = selectedModelConfig?.systemPromptPrefix ?? provider.systemPromptPrefix;
    const contextWindow = resolveContextWindow(provider, modelId);
    const primaryGenerationConfig = selectedModelConfig?.generationConfig ?? provider.generationConfig;
    const maxOutputTokens = positiveSafeIntegerOrUndefined(primaryGenerationConfig?.maxOutputTokens)
      ?? DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS;
    const enableMultimodalTools = selectedModelConfig?.enableMultimodalTools ?? provider.enableMultimodalTools;
    // Native facts freeze with the Turn: the kernel capability gate must replay identically after
    // recovery even if the editable channel settings change mid-request.
    const nativeResponses = normalizeOpenAIResponsesNativeSettings(
      selectedModelConfig?.nativeResponses ?? provider.nativeResponses
    );
    const compression = resolveFrozenCompression(records, provider, modelId, contextWindow);
    const compressionThresholdTokens = compression.thresholdTokens;
    const allowedTools = toolPolicy.allowedTools;
    const availableWorkEnvironmentIds = records.workEnvironments
      .filter((environment) => environment.available)
      .map((environment) => environment.id);
    const allowedWorkEnvironmentIds = [...new Set(
      workEnvironmentPolicy?.allowedWorkEnvironmentIds ?? availableWorkEnvironmentIds
    )]
      .filter((id) => availableWorkEnvironmentIds.includes(id))
      .sort();
    const { allowedWorkEnvironmentIds: effectiveAllowedWorkEnvironmentIds, inheritedDefaultWorkEnvironmentId } =
      applyInheritedWorkEnvironmentBoundary(
        allowedWorkEnvironmentIds,
        request.inheritedWorkEnvironmentPolicy,
        availableWorkEnvironmentIds
      );
    const promptWorkEnvironments = workEnvironmentPolicy?.enabled === true
      || request.inheritedWorkEnvironmentPolicy !== undefined
      ? effectiveAllowedWorkEnvironmentIds
        .map((id) => records.workEnvironments.find((environment) => environment.id === id))
        .filter((environment): environment is WorkEnvironmentRecord => !!environment)
      // 与旧 ECS runtimeContextWorkEnvironmentsForConversation 一致：策略停用时只暴露本地 folder，
      // 不把不可通过工具使用的 SSH/远程环境写进模型上下文。
      : records.workEnvironments.filter((environment) =>
          environment.available !== false && isLocalFolderWorkEnvironment(environment));
    const promptRenderContext: ReliablePromptRenderContext = {
      now: new Date(),
      platform: process.platform,
      ...(request.workspace ? { workspace: request.workspace } : {}),
      workEnvironments: promptWorkEnvironments,
      agentName: agent.name,
      ...(agent.description ? { agentDescription: agent.description } : {}),
      ...(workflow
        ? { workflowName: workflow.name, ...(workflow.description ? { workflowDescription: workflow.description } : {}) }
        : {})
    };
    const ruleFiles = await this.loadRuleFiles(request.workspace);
    const renderedRuntimeContextParts = runtimeContexts
      .map((context) => {
        const text = renderReliableRuntimeContextTemplate(context.template, promptRenderContext).trim();
        if (!text) return '';
        const name = context.name.trim();
        return name ? `[${name}]\n${text}` : text;
      })
      .filter(Boolean);
    // 与旧 ECS RuntimeContextSnapshotSystem 一致：渲染后的运行时上下文在前，规则区域原样追加在后。
    const runtimeContextText = [...renderedRuntimeContextParts, ...composeRuntimeContextRuleParts(ruleFiles)].join('\n\n');
    const selectedEnvironment = latestScopedSelection(records.conversationWorkEnvironmentLinks.filter((link) =>
      link.conversationId === request.conversationId && link.role === 'active'
    ));
    const preferredWorkEnvironmentId = selectedEnvironment?.workEnvironmentId
      && effectiveAllowedWorkEnvironmentIds.includes(selectedEnvironment.workEnvironmentId)
      ? selectedEnvironment.workEnvironmentId
      : workEnvironmentPolicy?.defaultWorkEnvironmentId ?? inheritedDefaultWorkEnvironmentId ?? undefined;
    const defaultWorkEnvironmentId = preferredWorkEnvironmentId
      && effectiveAllowedWorkEnvironmentIds.includes(preferredWorkEnvironmentId)
      ? preferredWorkEnvironmentId
      : effectiveAllowedWorkEnvironmentIds[0] ?? null;

    const executionPreset = {
      kind: 'turn-execution-preset',
      turnId: request.turnId,
      executorAgentId: agentId,
      providerConfigId: provider.id,
      modelId,
      allowedTools,
      defaultWorkEnvironmentId
    };
    const authoritySnapshot = {
      kind: 'effective-turn-authority',
      turnId: request.turnId,
      conversationId: request.conversationId,
      executorAgentId: agentId,
      intentKind: request.intentKind,
      ...(request.sourceTurnId ? { sourceTurnId: request.sourceTurnId } : {}),
      model: {
        providerConfigId: provider.id,
        provider: provider.provider,
        modelId,
        baseUrl: provider.baseUrl,
        openaiResponsesTransport: provider.openaiResponsesTransport,
        enableMultimodalTools,
        systemPromptPrefix,
        maxOutputTokens,
        ...(primaryGenerationConfig?.thinkingConfig
          ? { thinkingConfig: clonePlain(primaryGenerationConfig.thinkingConfig) }
          : {}),
        ...(nativeResponses ? { nativeResponses } : {}),
        retryPolicy: frozenProviderRetryPolicy(provider, modelId)
      },
      modelProfile: {
        id: modelProfile?.id ?? null,
        compressionThresholdTokens,
        contextWindowTokens: contextWindow,
        tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
      },
      compression: compression.snapshot,
      planReviewPolicy: {
        id: planReviewPolicy?.id ?? builtinPlanReviewPolicy?.id ?? null,
        mode: planReviewPolicy?.mode ?? builtinPlanReviewPolicy?.mode ?? 'off',
        allowReadonlyBeforeApproval: planReviewPolicy?.allowReadonlyBeforeApproval ?? builtinPlanReviewPolicy?.allowReadonlyBeforeApproval ?? true,
        requireForToolRiskLevels: [...(planReviewPolicy?.requireForToolRiskLevels ?? builtinPlanReviewPolicy?.requireForToolRiskLevels ?? [])]
      },
      toolPolicy: {
        id: toolPolicy.id,
        allowedTools,
        preset: toolPolicy.preset,
        toolConfigs: toolPolicy.toolConfigs,
        sourceConfigs: toolPolicy.sourceConfigs
      },
      skillPolicy: {
        id: skillPolicy?.id ?? null,
        sourceConfigs: clonePlainRecord(skillPolicy?.sourceConfigs)
      },
      systemPrompt: {
        id: systemPrompt?.id ?? (builtinWorkflow ? `builtin-system-prompt:${workflow?.id}` : builtinAgent ? `builtin-system-prompt:${agentId}` : null),
        text: renderReliableSystemPromptTemplate(composeSystemInstruction(orderedPromptParts), promptRenderContext)
      },
      runtimeContext: {
        id: runtimeContext?.id ?? null,
        name: runtimeContexts.map((context) => context.name.trim()).filter(Boolean).join(' + '),
        template: runtimeContexts.map((context) => context.template.trim()).filter(Boolean).join('\n\n'),
        // 占位符已渲染 + 规则区域注入后的模型可见文本；适配器优先使用，template 保留原文供编辑。
        ...(runtimeContextText ? { text: runtimeContextText } : {})
      },
      workEnvironmentPolicy: {
        id: workEnvironmentPolicy?.id ?? null,
        enabled: workEnvironmentPolicy?.enabled ?? false,
        allowedWorkEnvironmentIds: effectiveAllowedWorkEnvironmentIds,
        defaultWorkEnvironmentId
      }
    };
    return {
      turnId: request.turnId,
      executorAgentId: agentId,
      executionPreset: {
        content: JSON.stringify(executionPreset),
        contentType: 'application/vnd.limcode.turn-execution-preset+json'
      },
      authoritySnapshot: {
        content: JSON.stringify(authoritySnapshot),
        contentType: 'application/vnd.limcode.turn-authority-snapshot+json'
      }
    };
  }

  public async agents(): Promise<AgentRecord[]> {
    // Sidebar/history labels need only Agent records. Do not make that projection depend on every
    // unrelated settings section (for example a deliberately hard-cut compression schema).
    const paths = this.getPaths();
    const agents = await loadRecordStore<AgentRecord, 'agent'>(
      paths.agentsRootUri,
      paths.agentsIndexUri,
      'agent'
    );
    return mergeAgentsWithBuiltins(agents ?? []).map((agent) => ({ ...agent }));
  }

  public async workflow(workflowIdInput: string): Promise<WorkflowRecord> {
    const workflowId = requireId(workflowIdInput, 'workflowId');
    const paths = this.getPaths();
    const stored = await loadRecordStore<WorkflowRecord, 'workflow'>(
      paths.workflowsRootUri,
      paths.workflowsIndexUri,
      'workflow'
    );
    const workflow = mergeWorkflowsWithBuiltins(stored ?? []).find((candidate) => candidate.id === workflowId);
    if (!workflow) throw new Error(`Workflow 不存在：${workflowId}`);
    return { ...workflow };
  }

  /**
   * 读取全局（<dataRoot>）与会话绑定项目目录的 AGENTS.md / CLAUDE.md。
   * 与 capabilities/rulesCatalog 的路径约定一致；无 ExtensionContext（测试隔离 authority）时返回空。
   */
  private async loadRuleFiles(workspace?: { uri: string }): Promise<RuleFileRecord[]> {
    if (!this.context) return [];
    // 使用 VS Code FS API，远程 workspace / 非 file scheme 与 rulesCatalog 行为一致。
    const { Uri, workspace: vscodeWorkspace } = await import('vscode');
    const roots: Array<{ scope: RuleScope; rootUri: vscode.Uri | undefined }> = [
      { scope: 'global', rootUri: resolveDataRootUri(this.context) },
      { scope: 'project', rootUri: workspace ? Uri.parse(workspace.uri) : undefined }
    ];
    const rules: RuleFileRecord[] = [];
    for (const { scope, rootUri } of roots) {
      if (!rootUri) continue;
      for (const kind of ['AGENTS', 'CLAUDE'] as const) {
        const fileUri = Uri.joinPath(rootUri, kind === 'AGENTS' ? 'AGENTS.md' : 'CLAUDE.md');
        let content = '';
        let exists = false;
        try {
          content = Buffer.from(await vscodeWorkspace.fs.readFile(fileUri)).toString('utf8');
          exists = true;
        } catch {
          // 规则文件未创建（或不可读）时按「不存在」处理。
        }
        rules.push({
          id: `rule:${scope}:${kind}`,
          scope,
          kind,
          editable: kind === 'AGENTS',
          path: fileUri.fsPath,
          exists,
          content
        });
      }
    }
    return rules;
  }

  public async synchronizeWorkspaceFolders(
    folders: readonly CurrentWorkspaceFolder[]
  ): Promise<void> {
    this.setCurrentWorkspaceFolders(folders);
    await this.mutations.synchronizeWorkspaceFolders(folders);
  }

  /** Configuration-only projection. Runtime facts remain exclusively on the bounded reliable Feed. */
  public async configurationClientState(): Promise<ClientState> {
    // The client-state tables do not contain provider or compression settings. Keep those independently
    // versioned settings stores out of bridge bootstrap so one invalid section cannot strand every tab.
    const records = await this.loadConfigurationClientRecords();
    return Object.assign(createEmptyClientState(), {
      agents: records.agents.map(clonePlain),
      workflows: records.workflows.map(clonePlain),
      modelProfiles: records.modelProfiles.map(clonePlain),
      modelProfileScopeLinks: records.modelProfileScopeLinks.map(clonePlain),
      planReviewPolicies: records.planReviewPolicies.map(clonePlain),
      planReviewPolicyScopeLinks: records.planReviewPolicyScopeLinks.map(clonePlain),
      toolPolicies: records.toolPolicies.map(clonePlain),
      toolPolicyScopeLinks: records.toolPolicyScopeLinks.map(clonePlain),
      skillPolicies: records.skillPolicies.map(clonePlain),
      skillPolicyScopeLinks: records.skillPolicyScopeLinks.map(clonePlain),
      systemPrompts: records.systemPrompts.map(clonePlain),
      systemPromptScopeLinks: records.systemPromptScopeLinks.map(clonePlain),
      runtimeContexts: records.runtimeContexts.map(clonePlain),
      runtimeContextScopeLinks: records.runtimeContextScopeLinks.map(clonePlain),
      workEnvironments: records.workEnvironments.map(clonePlain),
      workEnvironmentPolicies: records.workEnvironmentPolicies.map(clonePlain),
      workEnvironmentPolicyScopeLinks: records.workEnvironmentPolicyScopeLinks.map(clonePlain),
      checkpointPolicies: records.checkpointPolicies.map(clonePlain),
      checkpointPolicyScopeLinks: records.checkpointPolicyScopeLinks.map(clonePlain),
      conversationWorkflowSelections: records.conversationWorkflowSelections.map(clonePlain),
      conversationWorkEnvironmentLinks: records.conversationWorkEnvironmentLinks.map(clonePlain)
    });
  }

  public async resolveAgent(input: { agentId?: string; agentType?: string }): Promise<{
    agentId: string;
    agentType: string;
    title: string;
  }> {
    const agents = await this.agents();
    const requestedId = input.agentId?.trim();
    const requestedType = input.agentType?.trim() || 'worker';
    const selected = requestedId
      ? agents.find((agent) => agent.id === requestedId)
      : agents.find((agent) => agent.id === requestedType)
        ?? agents.find((agent) => agent.kind === requestedType);
    if (!selected) {
      throw new Error(`未知 Agent：${requestedId || requestedType}。可用类型：${agents.map((agent) => agent.kind).join(', ')}`);
    }
    return {
      agentId: selected.id,
      agentType: selected.kind,
      title: selected.name
    };
  }

  public async providerConfig(providerConfigId: string): Promise<LlmProviderConfigRecord> {
    const configs = (await loadLlmProviderConfigsSettings(this.getPaths())).settings.configs;
    const id = requireId(providerConfigId, 'providerConfigId');
    const config = configs.find((candidate) => candidate.id === id);
    if (!config) throw new Error(`LLM Provider 配置不存在：${id}`);
    return config;
  }

  public async activeProviderConfig(): Promise<LlmProviderConfigRecord> {
    const paths = this.getPaths();
    const [providerConfigs, llmSelection] = await Promise.all([
      loadLlmProviderConfigsSettings(paths),
      loadGlobalSettingsFile(paths.settingsRootUri, 'llm')
    ]);
    const configs = providerConfigs.settings.configs;
    const activeProviderConfigId = (llmSelection.settings as LlmSettingsRecord).activeProviderConfigId;
    const config = configs.find((candidate) => candidate.id === activeProviderConfigId) ?? configs[0];
    if (!config) throw new Error('没有可用的 LLM Provider 配置。');
    return config;
  }

  public async workEnvironment(workEnvironmentId: string): Promise<WorkEnvironmentRecord> {
    const id = requireId(workEnvironmentId, 'workEnvironmentId');
    const environment = (await this.loadWorkEnvironments()).find((candidate) => candidate.id === id);
    if (!environment) throw new Error(`工作环境配置不存在：${id}`);
    return { ...environment };
  }

  public async workEnvironments(): Promise<WorkEnvironmentRecord[]> {
    return (await this.loadWorkEnvironments()).map((environment) => ({ ...environment }));
  }

  public async loadGlobalSettings(section: GlobalSettingsSection): Promise<{
    section: GlobalSettingsSection;
    settings: GlobalSettingsSectionValue;
    filePath: string;
    revision: string;
  }> {
    if (section === 'common') {
      const context = this.requireContext();
      const status = await loadCommittedGlobalStatus(context);
      const settings = createGlobalSettingsRecord(context, status);
      return {
        section,
        settings,
        filePath: globalStatusFileUri(context).fsPath || LIMCODE_GLOBAL_STATUS_LABEL,
        revision: globalStatusRevision(status)
      };
    }
    const paths = this.getPaths();
    if (section === 'llm') return this.loadNormalizedLlmSettings(paths);
    if (section === 'llmProviderConfigs') {
      const stored = await loadLlmProviderConfigsSettings(paths);
      return { section, settings: stored.settings, filePath: stored.filePath, revision: stored.revision };
    }
    if (section === 'llmCompressionConfigs') {
      const stored = await loadLlmCompressionConfigsSettings(paths);
      return { section, settings: stored.settings, filePath: stored.filePath, revision: stored.revision };
    }
    if (section === 'llmCompression') {
      const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
      const stored = await loadGlobalSettingsFile(paths.settingsRootUri, section);
      const settings = normalizeLlmCompressionSettings(
        stored.settings as Partial<LlmCompressionSettingsRecord> | undefined,
        configs
      );
      return { section, settings, filePath: stored.filePath, revision: stored.revision };
    }
    if (section === 'mcpServers') {
      const stored = await loadMcpServersSettings(paths);
      return { section, settings: stored.settings, filePath: stored.filePath, revision: stored.revision };
    }
    return loadGlobalSettingsFile(paths.settingsRootUri, section);
  }

  public async saveGlobalSettings(
    section: GlobalSettingsSection,
    settings: GlobalSettingsSectionValue,
    expectedRevision: string
  ): Promise<{
    section: GlobalSettingsSection;
    settings: GlobalSettingsSectionValue;
    filePath: string;
    revision: string;
    previousSettings?: GlobalSettingsSectionValue;
  }> {
    if (section === 'common') {
      const context = this.requireContext();
      const currentStatus = await loadCommittedGlobalStatus(context);
      const current = createGlobalSettingsRecord(context, currentStatus);
      const input = settings as Partial<GlobalSettingsRecord>;
      const requestedDataRootPath = input.dataFilePath?.trim() ?? current.dataFilePath;
      if (requestedDataRootPath !== current.dataFilePath) {
        throw new Error('可靠 Runtime 运行期间不能切换 data root；如需清空开发数据，请通过受控重置命令归档重置并重载窗口。');
      }
      const committedStatus = await saveGlobalStatusExpected(
        context,
        current.dataFilePath,
        input.proxy ?? current.proxy,
        expectedRevision,
        input.proxyShellAndMcp ?? current.proxyShellAndMcp
      );
      const committed = createGlobalSettingsRecord(context, committedStatus.current);
      return {
        section,
        settings: committed,
        filePath: globalStatusFileUri(context).fsPath || LIMCODE_GLOBAL_STATUS_LABEL,
        revision: globalStatusRevision(committedStatus.current),
        previousSettings: createGlobalSettingsRecord(context, committedStatus.previous)
      };
    }
    const paths = this.getPaths();
    if (section === 'llm') {
      const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
      const input = settings as Partial<LlmSettingsRecord>;
      const active = configs.find((config) => config.id === input.activeProviderConfigId) ?? configs[0];
      const normalized: LlmSettingsRecord = { activeProviderConfigId: active?.id ?? '' };
      return writeGlobalSettingsFile(paths.settingsRootUri, section, normalized, expectedRevision);
    }
    if (section === 'llmProviderConfigs') {
      const stored = await saveLlmProviderConfigsSettings(
        paths,
        settings as Partial<LlmProviderConfigsRecord> | undefined,
        expectedRevision
      );
      await this.loadNormalizedLlmSettings(paths);
      return { section, ...stored };
    }
    if (section === 'llmCompressionConfigs') {
      const stored = await saveLlmCompressionConfigsSettings(
        paths,
        settings as Partial<LlmCompressionConfigsRecord> | undefined,
        expectedRevision
      );
      return { section, ...stored };
    }
    if (section === 'llmCompression') {
      const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
      const normalized = normalizeLlmCompressionSettings(
        settings as Partial<LlmCompressionSettingsRecord> | undefined,
        configs
      );
      return writeGlobalSettingsFile(paths.settingsRootUri, section, normalized, expectedRevision);
    }
    if (section === 'mcpServers') {
      const stored = await saveMcpServersSettings(
        paths,
        settings as Partial<McpServersSettingsRecord> | undefined,
        expectedRevision
      );
      return stored;
    }
    return writeGlobalSettingsFile(paths.settingsRootUri, section, settings, expectedRevision);
  }

  private async loadNormalizedLlmSettings(paths: StoragePaths): Promise<{
    section: 'llm';
    settings: LlmSettingsRecord;
    filePath: string;
    revision: string;
  }> {
    const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
    const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llm');
    const input = stored.settings as Partial<LlmSettingsRecord>;
    const active = configs.find((config) => config.id === input.activeProviderConfigId) ?? configs[0];
    const settings: LlmSettingsRecord = { activeProviderConfigId: active?.id ?? '' };
    return { section: 'llm', settings, filePath: stored.filePath, revision: stored.revision };
  }

  private requireContext(): vscode.ExtensionContext {
    if (!this.context) throw new Error('该配置操作需要 VS Code ExtensionContext。');
    return this.context;
  }

  private async loadWorkEnvironments(): Promise<WorkEnvironmentRecord[]> {
    const paths = this.getPaths();
    const records = (await loadRecordStore<WorkEnvironmentRecord, 'workEnvironment'>(
      paths.workEnvironmentsRootUri,
      paths.workEnvironmentsIndexUri,
      'workEnvironment'
    )) ?? [];
    const projected = new Map(records.map((record) => [
      record.id,
      record.source === 'workspaceFolder'
        ? { ...record, available: this.currentWorkspaceFolderIds.has(record.id) }
        : record
    ]));
    for (const [id, current] of this.currentWorkspaceFolderRecords) {
      const persisted = projected.get(id);
      projected.set(id, persisted
        ? { ...current, createdAt: persisted.createdAt, updatedAt: persisted.updatedAt }
        : current);
    }
    return [...projected.values()];
  }

  private setCurrentWorkspaceFolders(folders: readonly CurrentWorkspaceFolder[]): void {
    const observedAt = Date.now();
    const records = folders.map((folder) => createLocalFolderWorkEnvironmentRecord({
      id: workEnvironmentIdFromUri(folder.uri),
      name: folder.name || folder.rootPath,
      uri: folder.uri,
      rootPath: folder.rootPath,
      displayPath: folder.rootPath,
      index: folder.index,
      available: true,
      createdAt: observedAt,
      updatedAt: observedAt
    }, observedAt));
    this.currentWorkspaceFolderRecords = new Map(records.map((record) => [record.id, record]));
    this.currentWorkspaceFolderIds = new Set(this.currentWorkspaceFolderRecords.keys());
    this.currentWorkspaceFolders = folders;
  }

  private async loadConfigurationClientRecords(): Promise<ConfigurationClientRecords> {
    const paths = this.getPaths();
    const [
      agents,
      workflows,
      modelProfiles,
      modelProfileScopeLinks,
      planReviewPolicies,
      planReviewPolicyScopeLinks,
      toolPolicies,
      toolPolicyScopeLinks,
      skillPolicies,
      skillPolicyScopeLinks,
      systemPrompts,
      systemPromptScopeLinks,
      runtimeContexts,
      runtimeContextScopeLinks,
      workEnvironments,
      workEnvironmentPolicies,
      workEnvironmentPolicyScopeLinks,
      checkpointPolicies,
      checkpointPolicyScopeLinks,
      conversationWorkflowSelections,
      conversationWorkEnvironmentLinks
    ] = await Promise.all([
      loadRecordStore<AgentRecord, 'agent'>(paths.agentsRootUri, paths.agentsIndexUri, 'agent'),
      loadRecordStore<WorkflowRecord, 'workflow'>(paths.workflowsRootUri, paths.workflowsIndexUri, 'workflow'),
      loadRecordStore<ModelProfileRecord, 'modelProfile'>(
        paths.modelProfilesRootUri,
        paths.modelProfilesIndexUri,
        'modelProfile'
      ),
      loadRecordStore<ModelProfileScopeLinkRecord, 'link'>(
        paths.modelProfileScopeLinksRootUri,
        paths.modelProfileScopeLinksIndexUri,
        'link'
      ),
      loadRecordStore<PlanReviewPolicyRecord, 'policy'>(
        paths.planReviewPoliciesRootUri,
        paths.planReviewPoliciesIndexUri,
        'policy'
      ),
      loadRecordStore<PlanReviewPolicyScopeLinkRecord, 'link'>(
        paths.planReviewPolicyScopeLinksRootUri,
        paths.planReviewPolicyScopeLinksIndexUri,
        'link'
      ),
      loadRecordStore<ToolPolicyRecord, 'toolPolicy'>(paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri, 'toolPolicy'),
      loadRecordStore<ToolPolicyScopeLinkRecord, 'link'>(
        paths.toolPolicyScopeLinksRootUri,
        paths.toolPolicyScopeLinksIndexUri,
        'link'
      ),
      loadRecordStore<SkillPolicyRecord, 'skillPolicy'>(
        paths.skillPoliciesRootUri,
        paths.skillPoliciesIndexUri,
        'skillPolicy'
      ),
      loadRecordStore<SkillPolicyScopeLinkRecord, 'link'>(
        paths.skillPolicyScopeLinksRootUri,
        paths.skillPolicyScopeLinksIndexUri,
        'link'
      ),
      loadRecordStore<SystemPromptRecord, 'systemPrompt'>(
        paths.systemPromptsRootUri,
        paths.systemPromptsIndexUri,
        'systemPrompt'
      ),
      loadRecordStore<SystemPromptScopeLinkRecord, 'link'>(
        paths.systemPromptScopeLinksRootUri,
        paths.systemPromptScopeLinksIndexUri,
        'link'
      ),
      loadRecordStore<RuntimeContextRecord, 'runtimeContext'>(
        paths.runtimeContextsRootUri,
        paths.runtimeContextsIndexUri,
        'runtimeContext'
      ),
      loadRecordStore<RuntimeContextScopeLinkRecord, 'link'>(
        paths.runtimeContextScopeLinksRootUri,
        paths.runtimeContextScopeLinksIndexUri,
        'link'
      ),
      this.loadWorkEnvironments(),
      loadRecordStore<WorkEnvironmentPolicyRecord, 'policy'>(
        paths.workEnvironmentPoliciesRootUri,
        paths.workEnvironmentPoliciesIndexUri,
        'policy'
      ),
      loadRecordStore<WorkEnvironmentPolicyScopeLinkRecord, 'link'>(
        paths.workEnvironmentPolicyScopeLinksRootUri,
        paths.workEnvironmentPolicyScopeLinksIndexUri,
        'link'
      ),
      loadRecordStore<CheckpointPolicyRecord, 'policy'>(
        paths.checkpointPoliciesRootUri,
        paths.checkpointPoliciesIndexUri,
        'policy'
      ),
      loadRecordStore<CheckpointPolicyScopeLinkRecord, 'link'>(
        paths.checkpointPolicyScopeLinksRootUri,
        paths.checkpointPolicyScopeLinksIndexUri,
        'link'
      ),
      loadRecordStore<ConversationWorkflowSelectionRecord, 'selection'>(
        paths.conversationWorkflowSelectionsRootUri,
        paths.conversationWorkflowSelectionsIndexUri,
        'selection'
      ),
      loadRecordStore<ConversationWorkEnvironmentLinkRecord, 'link'>(
        paths.conversationWorkEnvironmentLinksRootUri,
        paths.conversationWorkEnvironmentLinksIndexUri,
        'link'
      )
    ]);
    const effectiveWorkEnvironmentPolicies = projectWorkEnvironmentPolicies(
      workEnvironmentPolicies ?? [],
      workEnvironments ?? [],
      this.currentWorkspaceFolderIds
    );
    return {
      agents: mergeAgentsWithBuiltins(agents ?? []),
      workflows: mergeWorkflowsWithBuiltins(workflows ?? []),
      modelProfiles: modelProfiles ?? [],
      modelProfileScopeLinks: modelProfileScopeLinks ?? [],
      planReviewPolicies: planReviewPolicies ?? [],
      planReviewPolicyScopeLinks: planReviewPolicyScopeLinks ?? [],
      toolPolicies: toolPolicies ?? [],
      toolPolicyScopeLinks: toolPolicyScopeLinks ?? [],
      skillPolicies: skillPolicies ?? [],
      skillPolicyScopeLinks: skillPolicyScopeLinks ?? [],
      systemPrompts: systemPrompts ?? [],
      systemPromptScopeLinks: systemPromptScopeLinks ?? [],
      runtimeContexts: runtimeContexts ?? [],
      runtimeContextScopeLinks: runtimeContextScopeLinks ?? [],
      workEnvironments: workEnvironments ?? [],
      workEnvironmentPolicies: effectiveWorkEnvironmentPolicies,
      workEnvironmentPolicyScopeLinks: workEnvironmentPolicyScopeLinks ?? [],
      checkpointPolicies: checkpointPolicies ?? [],
      checkpointPolicyScopeLinks: checkpointPolicyScopeLinks ?? [],
      conversationWorkflowSelections: conversationWorkflowSelections ?? [],
      conversationWorkEnvironmentLinks: conversationWorkEnvironmentLinks ?? []
    };
  }

  public async loadRequestCompressionSettings(
    model: ChatModelOverrideRecord
  ): Promise<RequestCompressionSettings> {
    const paths = this.getPaths();
    const [providers, configs, selection] = await Promise.all([
      loadLlmProviderConfigsSettings(paths),
      loadLlmCompressionConfigsSettings(paths),
      loadGlobalSettingsFile(paths.settingsRootUri, 'llmCompression')
    ]);
    const provider = providers.settings.configs.find((candidate) => candidate.id === model.providerConfigId);
    if (!provider || provider.provider !== model.provider || !providerContainsModel(provider, model.model)) {
      throw new Error('当前对话使用的模型渠道已删除或改变，请重新选择模型。');
    }
    const contextWindowTokens = resolveContextWindow(provider, model.model);
    const resolved = resolveFrozenCompression({
      compressionConfigs: configs.settings.configs,
      compressionSettings: normalizeLlmCompressionSettings(
        selection.settings as Partial<LlmCompressionSettingsRecord>, configs.settings.configs
      ),
      providerConfigs: providers.settings.configs
    }, provider, model.model, contextWindowTokens);
    return {
      model: { ...model },
      modelProfile: {
        contextWindowTokens,
        compressionThresholdTokens: resolved.thresholdTokens,
        tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
      },
      compression: normalizePlainJson(resolved.snapshot, '请求压缩配置')
    };
  }

  private async loadRecords(): Promise<ConfigurationRecords> {
    const paths = this.getPaths();
    const [
      clientRecords,
      providerConfigs,
      llmSelection,
      compressionConfigs,
      compressionSelection
    ] = await Promise.all([
      this.loadConfigurationClientRecords(),
      loadLlmProviderConfigsSettings(paths),
      loadGlobalSettingsFile(paths.settingsRootUri, 'llm'),
      loadLlmCompressionConfigsSettings(paths),
      loadGlobalSettingsFile(paths.settingsRootUri, 'llmCompression')
    ]);
    return {
      ...clientRecords,
      providerConfigs: providerConfigs.settings.configs,
      activeProviderConfigId: (llmSelection.settings as LlmSettingsRecord).activeProviderConfigId,
      compressionConfigs: compressionConfigs.settings.configs,
      compressionSettings: normalizeLlmCompressionSettings(
        compressionSelection.settings as Partial<LlmCompressionSettingsRecord> | undefined,
        compressionConfigs.settings.configs
      )
    };
  }

}

/**
 * Child executions inherit the parent Turn's frozen work-environment boundary: the child's own
 * scoped allow-list is intersected with the parent's, never widened. An empty intersection remains
 * empty so mutually exclusive policies fail closed instead of granting either side's environments.
 */
function applyInheritedWorkEnvironmentBoundary(
  allowed: readonly string[],
  inherited: FrozenWorkEnvironmentBoundaryPolicy | undefined,
  availableIds: readonly string[]
): { allowedWorkEnvironmentIds: string[]; inheritedDefaultWorkEnvironmentId: string | null } {
  if (!inherited) {
    return { allowedWorkEnvironmentIds: [...allowed], inheritedDefaultWorkEnvironmentId: null };
  }
  const inheritedAllowed = [...new Set(inherited.allowedWorkEnvironmentIds)]
    .filter((id) => availableIds.includes(id));
  const intersected = allowed.filter((id) => inheritedAllowed.includes(id));
  return {
    allowedWorkEnvironmentIds: [...new Set(intersected)].sort(),
    inheritedDefaultWorkEnvironmentId: inherited.defaultWorkEnvironmentId
  };
}

function projectWorkEnvironmentPolicies(
  policies: readonly WorkEnvironmentPolicyRecord[],
  environments: readonly WorkEnvironmentRecord[],
  currentWorkspaceFolderIds: ReadonlySet<string>
): WorkEnvironmentPolicyRecord[] {
  const availableIds = new Set(
    environments.filter((environment) => environment.available).map((environment) => environment.id)
  );
  // Each Host projects its own workspace folders into the allow-list and default without
  // publishing host-local facts into the shared policy store. Folder order follows environment index.
  const workspaceIds = environments
    .filter((environment) => environment.available && currentWorkspaceFolderIds.has(environment.id))
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0) || left.id.localeCompare(right.id))
    .map((environment) => environment.id);
  return policies.map((policy) => {
    // Workspace folders always join the projected allow-list so they appear checked in the editor
    // regardless of whether the shared policy already lists them.
    const allowedWorkEnvironmentIds = workspaceIds.length > 0
      ? [...new Set([...workspaceIds, ...policy.allowedWorkEnvironmentIds])]
      : [...policy.allowedWorkEnvironmentIds];
    const eligibleDefaultIds = allowedWorkEnvironmentIds.filter((id) => availableIds.has(id));
    // Prefer this Host's primary workspace folder as projected default when available;
    // fall back to the stored policy default if it remains eligible.
    const defaultWorkEnvironmentId = workspaceIds.length > 0
      ? workspaceIds[0]
      : policy.defaultWorkEnvironmentId && eligibleDefaultIds.includes(policy.defaultWorkEnvironmentId)
        ? policy.defaultWorkEnvironmentId
        : eligibleDefaultIds[0];
    const { defaultWorkEnvironmentId: _storedDefault, ...rest } = policy;
    return {
      ...rest,
      allowedWorkEnvironmentIds,
      ...(defaultWorkEnvironmentId ? { defaultWorkEnvironmentId } : {})
    };
  });
}

interface FrozenCompressionResolution {
  thresholdTokens: number;
  snapshot: Record<string, unknown>;
}

/** Resolves the exact model/provider/default binding once and freezes a credential-free replay document. */
function resolveFrozenCompression(
  records: Pick<ConfigurationRecords, 'compressionSettings' | 'compressionConfigs' | 'providerConfigs'>,
  primaryProvider: LlmProviderConfigRecord,
  primaryModelId: string,
  contextWindowTokens: number
): FrozenCompressionResolution {
  const modelBinding = latestUpdated(records.compressionSettings.modelBindings.filter((binding) =>
    binding.providerConfigId === primaryProvider.id && binding.modelId === primaryModelId
  ));
  const providerBinding = latestUpdated(records.compressionSettings.providerBindings.filter((binding) =>
    binding.providerConfigId === primaryProvider.id
  ));
  const compressionConfigId = modelBinding?.compressionConfigId
    ?? providerBinding?.compressionConfigId
    ?? records.compressionSettings.defaultConfigId;
  const config = records.compressionConfigs.find((candidate) => candidate.id === compressionConfigId)
    ?? records.compressionConfigs[0];
  if (!config) throw new Error('没有可用的 LLM 压缩配置。');

  const providerOverride = config.kind === 'openai_responses_compact'
    ? config.openaiResponsesCompact
    : config.llmSummary;
  const compressionProviderId = providerOverride?.providerConfigId?.trim() || primaryProvider.id;
  const compressionProvider = records.providerConfigs.find((candidate) => candidate.id === compressionProviderId);
  if (!compressionProvider) {
    throw new Error(`压缩配置 ${config.id} 引用了不存在的 Provider ${compressionProviderId}。`);
  }
  const compressionModelId = providerOverride?.model?.trim()
    || (compressionProvider.id === primaryProvider.id ? primaryModelId : compressionProvider.model.trim());
  if (!compressionModelId || !providerContainsModel(compressionProvider, compressionModelId)) {
    throw new Error(`压缩配置 ${config.id} 的 Provider ${compressionProvider.id} 不包含模型 ${compressionModelId || '(空)'}。`);
  }
  const trigger = clonePlain(config.trigger);
  const rawThreshold = trigger.thresholdUnit === 'tokens'
    ? trigger.thresholdTokens
    : trigger.thresholdUnit === 'percent'
      ? Math.floor(contextWindowTokens * (trigger.thresholdPercent ?? 90) / 100)
      : undefined;
  const thresholdTokens = Math.max(1, Math.min(
    contextWindowTokens,
    Number.isSafeInteger(rawThreshold) && (rawThreshold ?? 0) > 0
      ? rawThreshold!
      : Math.floor(contextWindowTokens * 0.9)
  ));
  const frozenConfig: LlmCompressionConfigRecord = clonePlain(config);
  const compressionContextWindowTokens = resolveContextWindow(compressionProvider, compressionModelId);
  const compressionMaxOutputTokens = resolveCompressionMaxOutputTokens(
    frozenConfig,
    compressionProvider,
    compressionModelId
  );
  if (frozenConfig.kind === 'openai_responses_compact') {
    frozenConfig.openaiResponsesCompact = {
      ...(frozenConfig.openaiResponsesCompact ?? {}),
      providerConfigId: compressionProvider.id,
      model: compressionModelId
    };
  } else if (!['disabled', 'deterministic_summary', 'manual_summary'].includes(frozenConfig.kind)) {
    frozenConfig.llmSummary = {
      ...(frozenConfig.llmSummary ?? {}),
      providerConfigId: compressionProvider.id,
      model: compressionModelId
    };
  }
  return {
    thresholdTokens,
    snapshot: {
      enabled: frozenConfig.kind !== 'disabled',
      binding: modelBinding
        ? { kind: 'model', id: modelBinding.id }
        : providerBinding
          ? { kind: 'provider', id: providerBinding.id }
          : { kind: 'default', id: records.compressionSettings.defaultConfigId ?? null },
      config: frozenConfig,
      methodKind: frozenConfig.kind,
      trigger,
      thresholdTokens,
      provider: {
        providerConfigId: compressionProvider.id,
        provider: compressionProvider.provider,
        modelId: compressionModelId,
        contextWindowTokens: compressionContextWindowTokens,
        maxOutputTokens: compressionMaxOutputTokens,
        retryPolicy: frozenProviderRetryPolicy(compressionProvider, compressionModelId)
      }
    }
  };
}

function resolveCompressionMaxOutputTokens(
  config: LlmCompressionConfigRecord,
  provider: LlmProviderConfigRecord,
  modelId: string
): number {
  const providerGenerationConfig = provider.modelConfigs.find((candidate) => candidate.modelId === modelId)?.generationConfig
    ?? provider.generationConfig;
  const providerMaximum = positiveSafeIntegerOrUndefined(providerGenerationConfig?.maxOutputTokens);
  if (config.kind !== 'llm_summary' && config.kind !== 'segmented_summary') {
    return providerMaximum ?? DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS;
  }

  const methodMaximum = positiveSafeIntegerOrUndefined(config.llmSummary?.generationConfig?.maxOutputTokens);
  if (methodMaximum !== undefined) return methodMaximum;
  const configuredTarget = positiveSafeIntegerOrUndefined(config.llmSummary?.targetTokens)
    ?? DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS;
  const visibleTarget = Math.min(DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS, configuredTarget);
  return Math.max(2_048, Math.min(
    DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS,
    Math.ceil(visibleTarget * 2)
  ));
}

function positiveSafeIntegerOrUndefined(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function frozenProviderRetryPolicy(
  provider: LlmProviderConfigRecord,
  modelId: string
): { enabled: boolean; maxRetries: number; retryDelayMs: number } {
  const model = provider.modelConfigs.find((candidate) => candidate.modelId.trim() === modelId.trim());
  const enabled = model?.retryOnError ?? provider.retryOnError;
  const configured = model?.retryMaxAttempts ?? provider.retryMaxAttempts;
  const normalized = configured === -1
    ? MAX_RELIABLE_PROVIDER_RETRY_ATTEMPTS
    : Number.isSafeInteger(configured) && configured >= 0
      ? Math.min(configured, MAX_RELIABLE_PROVIDER_RETRY_ATTEMPTS)
      : 0;
  const configuredDelay = model?.retryDelaySeconds ?? provider.retryDelaySeconds;
  const retryDelaySeconds = Number.isSafeInteger(configuredDelay) && configuredDelay > 0
    ? Math.min(configuredDelay, MAX_LLM_RETRY_DELAY_SECONDS)
    : 0;
  return {
    enabled: enabled === true && normalized > 0,
    maxRetries: enabled === true ? normalized : 0,
    retryDelayMs: retryDelaySeconds * 1_000
  };
}

function latestUpdated<T extends { id: string; updatedAt: number; createdAt: number }>(items: readonly T[]): T | undefined {
  return [...items].sort((left, right) => right.updatedAt - left.updatedAt
    || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function mergeAgentsWithBuiltins(configured: AgentRecord[]): AgentRecord[] {
  const byId = new Map(configured.map((agent) => [agent.id, { ...agent }]));
  for (const definition of Object.values(BUILTIN_AGENT_DEFINITIONS)) {
    if (byId.has(definition.id)) continue;
    byId.set(definition.id, {
      id: definition.id,
      name: definition.name,
      ...(definition.description ? { description: definition.description } : {}),
      kind: definition.kind,
      source: 'builtin',
      status: 'idle'
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function mergeWorkflowsWithBuiltins(configured: WorkflowRecord[]): WorkflowRecord[] {
  const byId = new Map(configured.map((workflow) => [workflow.id, { ...workflow }]));
  for (const definition of Object.values(BUILTIN_WORKFLOW_DEFINITIONS)) {
    if (byId.has(definition.id)) continue;
    byId.set(definition.id, {
      id: definition.id,
      name: definition.name,
      ...(definition.description ? { description: definition.description } : {}),
      source: 'builtin',
      ...(definition.icon ? { icon: definition.icon } : {}),
      createdAt: 0,
      updatedAt: 0
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

interface ScopeReference {
  scopeKind: ConfigScopeKind;
  scopeId?: string;
}

function resolveScopedRecord<
  TLink extends { scopeKind: string; scopeId?: string; role: string; updatedAt: number; createdAt: number; id: string },
  TRecord extends { id: string }
>(
  links: TLink[],
  records: TRecord[],
  scopesHighToLow: readonly ScopeReference[],
  recordId: (link: TLink) => string
): TRecord | undefined {
  for (const scope of scopesHighToLow) {
    const record = resolveRecordAtScope(links, records, scope, recordId);
    if (record) return record;
  }
  return undefined;
}

function resolveScopedRecords<
  TLink extends { scopeKind: string; scopeId?: string; role: string; updatedAt: number; createdAt: number; id: string },
  TRecord extends { id: string }
>(
  links: TLink[],
  records: TRecord[],
  scopesLowToHigh: readonly ScopeReference[],
  recordId: (link: TLink) => string
): TRecord[] {
  const result: TRecord[] = [];
  const seen = new Set<string>();
  for (const scope of scopesLowToHigh) {
    const record = resolveRecordAtScope(links, records, scope, recordId);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    result.push(record);
  }
  return result;
}

function resolveRecordAtScope<
  TLink extends { scopeKind: string; scopeId?: string; role: string; updatedAt: number; createdAt: number; id: string },
  TRecord extends { id: string }
>(
  links: TLink[],
  records: TRecord[],
  scope: ScopeReference,
  recordId: (link: TLink) => string
): TRecord | undefined {
  const selected = links
    .filter((link) => link.role === 'active'
      && link.scopeKind === scope.scopeKind
      && (scope.scopeKind === 'global' ? link.scopeId === undefined : link.scopeId === scope.scopeId))
    .sort((left, right) => right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id))[0];
  return selected ? records.find((record) => record.id === recordId(selected)) : undefined;
}

function latestScopedSelection<T extends { id: string; createdAt: number; updatedAt: number }>(records: T[]): T | undefined {
  return [...records].sort((left, right) => right.updatedAt - left.updatedAt
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id))[0];
}

function resolveRequestedProvider(
  providers: readonly LlmProviderConfigRecord[],
  input: { providerConfigId?: string; providerKind?: LlmProviderConfigRecord['provider']; modelId?: string }
): LlmProviderConfigRecord | undefined {
  const providerConfigId = input.providerConfigId?.trim();
  if (providerConfigId) {
    const provider = providers.find((candidate) => candidate.id === providerConfigId);
    if (!provider) throw new Error(`LLM Provider 配置不存在：${providerConfigId}`);
    if (input.providerKind && provider.provider !== input.providerKind) {
      throw new Error(`LLM Provider ${providerConfigId} 的类型与请求的 ${input.providerKind} 不一致。`);
    }
    return provider;
  }

  const modelId = input.modelId?.trim();
  const matching = providers.filter((provider) =>
    (!input.providerKind || provider.provider === input.providerKind)
    && (!modelId || providerContainsModel(provider, modelId))
  );
  if (matching.length > 1 && (input.providerKind || modelId)) {
    throw new Error('模型选择匹配多个 Provider 配置；TurnStart 必须携带 providerConfigId。');
  }
  if (matching.length === 0 && (input.providerKind || modelId)) {
    throw new Error(`没有 Provider 配置支持请求的模型 ${modelId || '(未指定)'}。`);
  }
  return matching[0] ?? providers[0];
}

function resolveContextWindow(provider: LlmProviderConfigRecord, modelId: string): number {
  const modelConfig = provider.modelConfigs.find((candidate) => candidate.modelId === modelId);
  const value = modelConfig?.contextWindowTokens ?? provider.contextWindowTokens;
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : 128_000;
}

function providerContainsModel(provider: LlmProviderConfigRecord, modelId: string): boolean {
  return provider.model.trim() === modelId
    || provider.models.some((candidate) => candidate.id.trim() === modelId)
    || provider.modelConfigs.some((candidate) => candidate.modelId.trim() === modelId);
}

function builtinSystemPromptPart(text: string | undefined): SystemPromptTextPart | undefined {
  return text?.trim() ? { text } : undefined;
}

function clonePlainRecord<T>(value: Record<string, T> | undefined): Record<string, T> {
  if (!value) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, T>;
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}
