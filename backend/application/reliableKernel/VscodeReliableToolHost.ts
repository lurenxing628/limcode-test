import * as path from 'node:path';
import type * as vscode from 'vscode';
import type {
  CommandCapability,
  CommandOutputLimits,
  CommandRunArgs,
  CommandRunObserver,
  CommandRunResult,
  WorkEnvironmentCapabilityOptions
} from '../../capabilities/types';
import { createSkillCatalogCapability } from '../../capabilities/skillCatalog';
import { createRulesCatalogCapability } from '../../capabilities/rulesCatalog';
import { createVsCodeFsCapability } from '../../capabilities/vscodeFs';
import { createWorkEnvironmentRuntimeCapability } from '../../capabilities/workEnvironmentTransfer';
import { McpRuntimeManager, dedupeMcpToolNames } from '../mcpRuntimeManager';
import { proxyForShellAndMcp } from './proxyEnvironment';
import { createBuiltinToolDefinitions } from '../../world/modules/tools/definitions';
import {
  toolDefinitionRecord,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResultOut,
  type ToolRuntimeEvent
} from '../../world/modules/tools/registry';
import type { GlobalSettingsRecord, RuleFileRecord, RuleScope, SkillDefinitionRecord, ToolDefinitionRecord, WorkEnvironmentRecord } from '../../../shared/protocol';
import type {
  ReliableAgentToolDispatchInput,
  ReliableAgentToolPause,
  ReliableAgentToolSettled
} from '../../reliableKernel/agentLoop';
import {
  LocalFileToolPlanner,
  resolvePathInsideBoundary,
  type ResolvedLocalToolPath
} from '../../reliableKernel/localFileToolPlanner';
import type { ToolTerminalResult } from '../../reliableKernel/effectControlPlane';
import type {
  ReliableToolDispatchAuthority,
  ReliableSpecialToolAdmission,
  ReliableToolDispatcherHost
} from '../../reliableKernel/toolDispatcher';
import { VscodeConfigurationAuthority } from '../../reliableKernel/vscodeConfigurationAuthority';
import type { PlainJsonValue } from '../../reliableKernel/plainJson';
import { resolveFrozenWorkEnvironmentBoundary } from '../../reliableKernel/workEnvironmentBoundary';
import type { ExecutionHandoffError } from '../../reliableKernel/executionLeaseFence';

export interface VscodeReliableToolHostOptions {
  dispatchSpecial?: (
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    signal: AbortSignal,
    admission?: ReliableSpecialToolAdmission
  ) => Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled | undefined>;
  cancelTurnWaits?: (input: { turnId: string; reason: string }) => Promise<void>;
  quiesce?: (reason: ExecutionHandoffError) => Promise<void>;
  resolveAttachmentReference?: (attachmentId: string) => Promise<import('../../../shared/protocol').InlineDataPart>;
  resolveAttachmentContent?: (attachmentId: string) => Promise<import('../../../shared/protocol').InlineDataPart>;
}

/** VS Code capability adapter only; Runtime lifecycle remains owned by ReliableToolDispatcher. */
export class VscodeReliableToolHost implements ReliableToolDispatcherHost {
  public readonly mcp: McpRuntimeManager;
  private readonly fs = createVsCodeFsCapability();
  private readonly skills;
  private readonly rules;
  private readonly workEnvironment = createWorkEnvironmentRuntimeCapability();
  private readonly commandDeclaration = commandDeclarationCapability();
  private readonly builtins: ToolDefinition[];
  private readonly filePlanner: LocalFileToolPlanner;
  private initialization: Promise<void> | undefined;
  private mcpInitialization: Promise<void> | undefined;
  private onStateChange: (() => void) | undefined;

  public constructor(
    context: vscode.ExtensionContext,
    private readonly configuration: VscodeConfigurationAuthority,
    private readonly options: VscodeReliableToolHostOptions = {}
  ) {
    this.skills = createSkillCatalogCapability(context);
    this.rules = createRulesCatalogCapability(context);
    this.mcp = new McpRuntimeManager({
      loadGlobalSettings: (section) => configuration.loadGlobalSettings(section),
      resolveProxySetting: async () =>
        proxyForShellAndMcp((await configuration.loadGlobalSettings('common')).settings as GlobalSettingsRecord)
    });
    this.mcp.setStateChangeListener(() => this.notifyStateChange());
    this.builtins = createBuiltinToolDefinitions({ command: this.commandDeclaration });
    this.filePlanner = new LocalFileToolPlanner((inputPath, authority) => this.resolveFilePath(inputPath, authority));
  }

  public initialize(): Promise<void> {
    this.initialization ??= Promise.all([
      this.skills.refresh(),
      this.rules.refresh()
    ]).then(() => { this.notifyStateChange(); });
    // Start discovery alongside the core catalogs, but do not make builtin Turn admission wait for
    // a remote MCP initialize/listTools round trip. A completed refresh naturally changes the tool
    // definitions frozen by the next ModelRequest.
    this.mcpInitialization ??= this.mcp.refreshFromSettings({ discover: true })
      .then(() => { this.notifyStateChange(); })
      .catch((error) => {
        console.warn('[LimCode] MCP background discovery failed.', error);
      });
    return this.initialization;
  }

  public setStateChangeListener(listener: (() => void) | undefined): void {
    this.onStateChange = listener;
  }

  public async dispose(): Promise<void> {
    await this.mcp.dispose();
  }

  public definitions(): ToolDefinition[] {
    return [
      ...this.builtins,
      ...dedupeMcpToolNames(this.mcp.runtimeTools(), this.builtins.map((definition) => definition.declaration.name))
    ];
  }

  public definitionRecords(): ToolDefinitionRecord[] {
    return this.definitions().map(toolDefinitionRecord);
  }

  public skillDefinitions(): SkillDefinitionRecord[] {
    return this.skills.list().map((skill) => ({ ...skill }));
  }

  public ruleFiles(): RuleFileRecord[] {
    return this.rules.list().map((rule) => ({ ...rule }));
  }

  public async refreshSkillCatalog(): Promise<void> {
    await this.skills.refresh();
    this.notifyStateChange();
  }

  public async refreshRulesCatalog(): Promise<void> {
    await this.rules.refresh();
    this.notifyStateChange();
  }

  public async saveRulesFile(scope: RuleScope, content: string): Promise<void> {
    await this.rules.writeAgents(scope, content);
    await this.rules.refresh();
    this.notifyStateChange();
  }

  public async executeNoEffect(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    emit: (event: ToolRuntimeEvent) => void,
    signal: AbortSignal
  ): Promise<ToolResultOut> {
    if (definition.execution !== 'runtime') throw new Error(`Tool ${definition.declaration.name} is not a runtime definition.`);
    if (!['read', 'skills'].includes(definition.declaration.name)) {
      throw new Error(`Tool ${definition.declaration.name} is not classified as a repeatable no-effect capability.`);
    }
    const environments = await this.resolveEnvironments(authority);
    const context: ToolExecutionContext = {
      toolCallId: input.toolCallId,
      conversationId: authorityConversationId(authority.document),
      ...(authority.toolConfig?.config ? { config: plainClone(authority.toolConfig.config) } : {}),
      settingsSnapshot: {
        enableMultimodalTools: authorityMultimodalEnabled(authority.document)
      },
      ...(environments.active ? { workEnvironment: environments.active } : {}),
      workEnvironments: environments.allowed,
      accessibleWorkEnvironments: environments.allowed,
      ...(definition.declaration.name === 'read' && !reliableReadAttachmentId(input.arguments)
        ? { attachmentMaxBytes: await this.loadAttachmentMaxBytes() }
        : {}),
      signal,
      emit
    };
    return definition.execute(input.arguments, {
      fs: this.fs,
      command: this.commandDeclaration,
      workEnvironment: this.workEnvironment,
      skills: this.skills,
      ...(this.options.resolveAttachmentReference ? {
        attachments: {
          reference: this.options.resolveAttachmentReference,
          ...(this.options.resolveAttachmentContent ? { resolve: this.options.resolveAttachmentContent } : {})
        }
      } : {})
    }, context);
  }

  public async executeWorkEnvironmentTransfer(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    emit: (event: ToolRuntimeEvent) => void,
    signal: AbortSignal
  ): Promise<ToolResultOut> {
    if (definition.execution !== 'runtime' || definition.declaration.name !== 'transfer') {
      throw new Error(`Tool ${definition.declaration.name} is not the reliable transfer capability.`);
    }
    const policy = authorityWorkEnvironmentPolicy(authority.document);
    if (!policy.enabled) throw new Error('冻结 WorkEnvironmentPolicy 已关闭 transfer。');
    const environments = await this.resolveEnvironments(authority);
    const context: ToolExecutionContext = {
      toolCallId: input.toolCallId,
      conversationId: authorityConversationId(authority.document),
      ...(authority.toolConfig?.config ? { config: plainClone(authority.toolConfig.config) } : {}),
      settingsSnapshot: {
        enableMultimodalTools: authorityMultimodalEnabled(authority.document)
      },
      ...(environments.active ? { workEnvironment: environments.active } : {}),
      workEnvironments: environments.allowed,
      accessibleWorkEnvironments: environments.allowed,
      signal,
      emit
    };
    return definition.execute(input.arguments, {
      fs: this.fs,
      command: this.commandDeclaration,
      workEnvironment: this.workEnvironment,
      skills: this.skills
    }, context);
  }

  public planFileMutation(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    signal: AbortSignal
  ) {
    return this.filePlanner.plan(definition, input, authority, signal);
  }

  public async resolveProcessCwd(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<string> {
    const environments = await this.resolveEnvironments(authority);
    const active = environments.active;
    if (!active?.rootPath || active.kind !== 'localFolder') {
      throw new Error('可靠进程工具首发只允许具有本地 rootPath 的 active work environment。');
    }
    const args = asRecord(input.arguments);
    const requested = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '.';
    const root = path.resolve(active.rootPath);
    const cwd = path.resolve(root, requested);
    assertInsideRoot(root, cwd, 'command cwd');
    return cwd;
  }

  public dispatchSpecial(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    signal: AbortSignal,
    admission?: ReliableSpecialToolAdmission
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled | undefined> {
    return this.options.dispatchSpecial
      ? this.options.dispatchSpecial(definition, input, authority, signal, admission)
      : Promise.resolve(undefined);
  }

  public async cancelTurnWaits(input: { turnId: string; reason: string }): Promise<void> {
    await this.options.cancelTurnWaits?.(input);
  }

  public async quiesce(reason: ExecutionHandoffError): Promise<void> {
    await this.options.quiesce?.(reason);
  }

  private notifyStateChange(): void {
    this.onStateChange?.();
  }

  private async resolveFilePath(
    inputPath: string,
    authority: ReliableToolDispatchAuthority
  ): Promise<ResolvedLocalToolPath> {
    const environments = await this.resolveEnvironments(authority);
    const local = environments.allowed.filter((environment) =>
      environment.available && environment.kind === 'localFolder' && !!environment.rootPath
    );
    if (local.length === 0) throw new Error('冻结 WorkEnvironmentPolicy 没有可用本地文件根。');
    if (path.isAbsolute(inputPath)) {
      const matches = local
        .map((environment) => ({ environment, root: path.resolve(environment.rootPath!) }))
        .filter(({ root }) => isInsideRoot(root, path.resolve(inputPath)))
        .sort((left, right) => right.root.length - left.root.length);
      const selected = matches[0];
      if (!selected) throw new Error(`绝对路径不属于冻结策略允许的本地工作环境：${inputPath}`);
      return resolvePathInsideBoundary(selected.environment.id, selected.root, inputPath);
    }
    const active = environments.active;
    if (!active?.rootPath || active.kind !== 'localFolder') {
      throw new Error('相对文件路径需要一个可用的默认本地工作环境。');
    }
    return resolvePathInsideBoundary(active.id, active.rootPath, inputPath);
  }

  /** 供 toolDispatcher 构建模型可见的 agent.type 列表；排除运行时镜像（mirror id 不是合法 agent.type）。 */
  public async agentTypeEntries(): Promise<{ id: string; label?: string }[]> {
    const agents = await this.configuration.agents();
    return agents
      .filter((agent) => agent.runtimeRole !== 'mirror')
      .map((agent) => ({ id: agent.id, label: agent.description?.trim() || agent.name.trim() }));
  }

  /** 供 toolDispatcher 构建模型可见的工作环境列表；与执行时路径边界共用本 Host 的实时目录投影。 */
  public async workEnvironmentsForAuthority(authority: ReliableToolDispatchAuthority): Promise<{
    active?: WorkEnvironmentRecord;
    allowed: WorkEnvironmentRecord[];
  }> {
    return this.resolveEnvironments(authority);
  }

  private async resolveEnvironments(authority: ReliableToolDispatchAuthority): Promise<{
    active?: WorkEnvironmentRecord;
    allowed: WorkEnvironmentRecord[];
  }> {
    const policy = authorityWorkEnvironmentPolicy(authority.document);
    const records = await this.configuration.workEnvironments();
    const boundary = resolveFrozenWorkEnvironmentBoundary(policy, records);
    return cloneEnvironmentBoundary(boundary);
  }

  private async loadAttachmentMaxBytes(): Promise<number> {
    const loaded = await this.configuration.loadGlobalSettings('attachments');
    const settings = asRecord(loaded.settings);
    const maxMb = Number(settings?.maxStoredInlineFileMb);
    if (!Number.isSafeInteger(maxMb) || maxMb < 1 || maxMb > 200) {
      throw new Error('附件大小设置无效。');
    }
    return maxMb * 1024 * 1024;
  }
}

function cloneEnvironmentBoundary(boundary: {
  active?: WorkEnvironmentRecord;
  allowed: WorkEnvironmentRecord[];
}): { active?: WorkEnvironmentRecord; allowed: WorkEnvironmentRecord[] } {
  return {
    ...(boundary.active ? { active: { ...boundary.active } } : {}),
    allowed: boundary.allowed.map((environment) => ({ ...environment }))
  };
}

function authorityWorkEnvironmentPolicy(document: PlainJsonValue): {
  enabled: boolean;
  allowedWorkEnvironmentIds: string[];
  defaultWorkEnvironmentId: string | null;
} {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  const policy = requireRecord(authority.workEnvironmentPolicy, 'AuthoritySnapshot.workEnvironmentPolicy');
  if (!Array.isArray(policy.allowedWorkEnvironmentIds)) {
    throw new TypeError('AuthoritySnapshot.workEnvironmentPolicy.allowedWorkEnvironmentIds must be an array.');
  }
  return {
    enabled: policy.enabled !== false,
    allowedWorkEnvironmentIds: policy.allowedWorkEnvironmentIds.map((id, index) =>
      requireText(id, `allowedWorkEnvironmentIds[${index}]`)),
    defaultWorkEnvironmentId: policy.defaultWorkEnvironmentId === null || policy.defaultWorkEnvironmentId === undefined
      ? null
      : requireText(policy.defaultWorkEnvironmentId, 'defaultWorkEnvironmentId')
  };
}

function authorityConversationId(document: PlainJsonValue): string | undefined {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  return typeof authority.conversationId === 'string' ? authority.conversationId : undefined;
}

function authorityMultimodalEnabled(document: PlainJsonValue): boolean {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  const model = requireRecord(authority.model, 'AuthoritySnapshot.model');
  return model.enableMultimodalTools !== false;
}

function commandDeclarationCapability(): CommandCapability {
  const toolName: 'shell' | 'bash' = process.platform === 'win32' ? 'shell' : 'bash';
  const unavailable = (): never => {
    throw new Error(`${toolName} execution must use reliable ProcessControlPlane.`);
  };
  return {
    toolName,
    executable: undefined,
    description: `${toolName === 'shell' ? 'Run a non-interactive PowerShell command' : 'Run a non-interactive Bash/Shell command'} in the project workspace. Returns stdout, stderr, and exitCode. Foreground wait moves a still-running process to the reliable detached wrapper; running results carry exitCode=null.`,
    run(_args: CommandRunArgs, _observer?: CommandRunObserver, _options?: WorkEnvironmentCapabilityOptions, _limits?: CommandOutputLimits): Promise<CommandRunResult> {
      return Promise.reject(unavailable());
    },
    backgroundForeground: unavailable,
    readOutput: unavailable,
    kill: unavailable,
    quiesce() {},
    dispose() {}
  } as CommandCapability;
}

function assertInsideRoot(root: string, target: string, label: string): void {
  if (!isInsideRoot(root, target)) throw new Error(`${label} escapes active work environment.`);
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function reliableReadAttachmentId(value: unknown): string | undefined {
  return typeof asRecord(value)?.attachmentId === 'string' && String(asRecord(value)?.attachmentId).trim()
    ? String(asRecord(value)?.attachmentId).trim()
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireRecord(value: PlainJsonValue | undefined, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function plainClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
