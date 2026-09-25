import type * as vscode from 'vscode';
import type { LlmCompactDryRunResult, LlmCompactRequest, LlmDryRunOptions, LlmDryRunResult, LlmResolveInvocationRequest, LlmStartRequest } from '../world/modules/llm/contracts';
import type { WorldEvent } from '../ecs/types';
import type { BackgroundProcessOriginDescriptor } from './backgroundProcessTypes';
import type {
  BridgeClientId,
  ClientState,
  ConversationHistoryPageRecord,
  ConversationHistoryPageRequest,
  ConversationSettingsSection,
  ConversationSettingsSectionValue,
  ExtensionToWebviewMessage,
  GlobalSettingsSection,
  GlobalSettingsSectionValue,
  LlmCompressionConfigRecord,
  LlmProviderConfigRecord,
  LlmProviderModelRecord,
  CheckpointRecord,
  CheckpointGitStatusRecord,
  CheckpointRestorePayload,
  ShadowCheckpointRestoreResult,
  ShadowRepositoryDiskStatRecord,
  CheckpointPolicyRecord,
  CheckpointTriggerKind,
  SkillDefinitionRecord,
  SkillSource,
  RuleFileRecord,
  RuleScope,
  WebviewClientMeta,
  WorkEnvironmentRecord
} from '../../shared/protocol';
import type { EditToolMode } from '../../shared/protocol';
import type { OpenAIResponsesNativeHooks } from './openAIResponsesNativeControl';

export type Emit = (event: WorldEvent) => void;

/**
 * Process-local per-request runtime controls. Never persisted, never serialized through the
 * Webview bridge. `native` carries Astra native hooks (controller registration) from the
 * reliable kernel dispatch; undefined on non-native paths.
 */
export interface LlmStartRuntimeControls {
  native?: OpenAIResponsesNativeHooks;
}

/** LLM 能力：无状态函数根据 request 启动流式执行，并通过 emit 回灌事件。 */
export interface LlmCapability {
  resolveInvocation(request: LlmResolveInvocationRequest, emit: Emit): void;
  start(request: LlmStartRequest, emit: Emit, controls?: LlmStartRuntimeControls): void;
  compact(request: LlmCompactRequest, emit: Emit): void;
  dryRun(request: LlmStartRequest, options?: LlmDryRunOptions): Promise<LlmDryRunResult>;
  dryRunCompact(request: LlmCompactRequest, options?: LlmDryRunOptions): Promise<LlmCompactDryRunResult>;
  listModels(config: LlmProviderConfigRecord): Promise<LlmProviderModelRecord[]>;
  cancelRetry(requestId: string): void;
  abort(requestId: string): void;
  dispose(): void;
}

/** 文件系统能力：隐藏 vscode.workspace.fs 等外部句柄。 */
export interface FsReadLine {
  line: number;
  text: string;
}

export interface FsReadFileResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: FsReadLine[];
  content: string;
}

export interface FsReadBinaryFileResult {
  path: string;
  name: string;
  mimeType: string;
  data: string;
  sizeBytes: number;
}

export interface FsFileDiffRecord {
  format: 'unified';
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

export interface FsHunkEditRequest {
  oldContent: string;
  newContent: string;
  replaceAll?: boolean;
}

export interface FsInsertEditRequest {
  line: number;
  content: string;
}

export interface FsDeleteEditRequest {
  startLine: number;
  endLine: number;
}

export type FsEditFileRequest =
  | { path: string; mode: 'hunk'; hunks: FsHunkEditRequest[] }
  | { path: string; mode: 'insert'; insert: FsInsertEditRequest }
  | { path: string; mode: 'delete'; delete: FsDeleteEditRequest };

export type FsFileWriteAction = 'created' | 'modified' | 'unchanged' | 'deleted';

export interface FsFileChangeRecord {
  path: string;
  action: FsFileWriteAction;
  added: number;
  removed: number;
  diff?: FsFileDiffRecord;
}

export interface FsWriteFileResult {
  kind: 'file_write.result';
  path: string;
  success: boolean;
  pending?: boolean;
  action: FsFileWriteAction;
  summary: string;
  changedFiles: string[];
  files: FsFileChangeRecord[];
  proposal?: FsPendingFileChangeProposal;
}

export type FsPendingFileChangeOperation = 'write' | 'edit';

export interface FsPendingFileChangeProposal {
  kind: 'file_change.proposal';
  operation: FsPendingFileChangeOperation;
  path: string;
  baseExisted: boolean;
  baseContent: string;
  targetContent: string;
  applyHunks: FsHunkEditRequest[];
  writeAction?: FsFileWriteAction;
  editMode?: EditToolMode;
  editResults?: unknown[];
  editFallbackMode?: string;
}

export interface FsPendingFileChangeDiffSaveEvent {
  toolCallId?: string;
  conversationId?: string;
  path: string;
  proposal: FsPendingFileChangeProposal;
}

export interface FsOpenPendingFileChangeDiffOptions extends WorkEnvironmentCapabilityOptions {
  toolCallId?: string;
  conversationId?: string;
  onSave?: (event: FsPendingFileChangeDiffSaveEvent) => void | Promise<void>;
}

export type FsDeletePathTargetType = 'file' | 'directory';

export interface FsDeletePathResult {
  inputPath: string;
  path: string;
  targetType: FsDeletePathTargetType;
}

export interface FsEditFileResult {
  kind: 'file_edit.result';
  mode: EditToolMode;
  path: string;
  success: boolean;
  pending?: boolean;
  action: Extract<FsFileWriteAction, 'modified' | 'unchanged'>;
  totalHunks: number;
  applied: number;
  failed: number;
  fallbackMode?: string;
  results: unknown[];
  summary: string;
  changedFiles: string[];
  files: FsFileChangeRecord[];
  proposal?: FsPendingFileChangeProposal;
}

export interface FsCapability {
  readFile(path: string, startLine?: number, endLine?: number, options?: WorkEnvironmentCapabilityOptions): Promise<FsReadFileResult>;
  readBinaryFile(path: string, mimeType: string, options?: WorkEnvironmentCapabilityOptions): Promise<FsReadBinaryFileResult>;
  writeFile(path: string, content: string, options?: WorkEnvironmentCapabilityOptions): Promise<FsWriteFileResult>;
  proposeWriteFile(path: string, content: string, options?: WorkEnvironmentCapabilityOptions): Promise<FsWriteFileResult>;
  editFile(request: FsEditFileRequest, options?: WorkEnvironmentCapabilityOptions): Promise<FsEditFileResult>;
  proposeEditFile(request: FsEditFileRequest, options?: WorkEnvironmentCapabilityOptions): Promise<FsEditFileResult>;
  applyPendingFileChange(proposal: FsPendingFileChangeProposal, options?: WorkEnvironmentCapabilityOptions): Promise<FsWriteFileResult | FsEditFileResult>;
  openPendingFileChangeDiff(proposal: FsPendingFileChangeProposal, options?: FsOpenPendingFileChangeDiffOptions): Promise<{ status: 'opened' | 'failed'; message: string }>;
  closePendingFileChangeDiff(toolCallId?: string, conversationId?: string): Promise<void>;
  deletePath(path: string, options?: WorkEnvironmentCapabilityOptions): Promise<FsDeletePathResult>;
}

export interface WorkEnvironmentCapabilityOptions {
  workEnvironment?: WorkEnvironmentRecord;
  signal?: AbortSignal;
  /**
   * 当前运行策略允许访问的工作环境集合。
   * 当 allowOutsideProjectPaths=false 时，本地绝对路径只要落在这些本地环境根目录内也应放行；
   * allowOutsideProjectPaths=true 仍然优先，表示不做项目/工作环境根目录限制。
   */
  accessibleWorkEnvironments?: WorkEnvironmentRecord[];
  allowOutsideProjectPaths?: boolean;
  /**
   * 本机上当前 Turn 可用技能的目录。读取落在其中的文件时不受项目根限制，远程工作环境下也从本机读取：
   * 技能的 references/、assets/ 等附带文件总是在扫描到它的这台机器上。
   */
  localReadOnlyRoots?: readonly string[];
  /** Optional caller-provided byte ceiling for binary attachment reads. */
  maxBytes?: number;
}

/**
 * 按名字查找技能的结果。`missing` 时若技能存在但被当前策略关掉，带上 `disabled`。
 */
export type SkillLookup =
  | { status: 'found'; skill: SkillDefinitionRecord }
  | { status: 'ambiguous'; candidates: SkillDefinitionRecord[] }
  | { status: 'missing'; disabled?: SkillDefinitionRecord };

/** 技能正文与它在 SKILL.md 中的起始行号（1 起算，frontmatter 与开头空行之后）。 */
export interface SkillBody {
  text: string;
  startLine: number;
}

/**
 * 技能目录扫描能力。
 * 扫描项目与用户主目录下各 Agent 工具的 skills 目录以及数据根 skills/ 中的 SKILL.md，
 * 产出 SkillDefinitionRecord 列表；skills 工具执行时按名字查找并读取正文。
 */
export interface SkillCatalogCapability {
  list(): SkillDefinitionRecord[];
  lookup(name: string, source?: SkillSource): SkillLookup;
  /** SKILL.md 去掉 frontmatter 后的正文；技能不在本目录（或被策略关掉）时抛错。 */
  readBody(skill: SkillDefinitionRecord): Promise<SkillBody>;
  refresh(): Promise<void>;
}

/**
 * 规则文件扫描能力。
 * 从项目根 <projectRoot>/{AGENTS,CLAUDE}.md 与数据根 <dataRoot>/{AGENTS,CLAUDE}.md 读取规则，
 * 产出 RuleFileRecord 列表；AGENTS.md 可写回，CLAUDE.md 只读兼容。
 */
export interface RulesCatalogCapability {
  list(): RuleFileRecord[];
  writeAgents(scope: RuleScope, content: string): Promise<void>;
  refresh(): Promise<void>;
}

export interface CommandRunEvent {
  kind: 'stdout' | 'stderr' | 'progress';
  delta?: string;
  payload?: unknown;
}

export interface CommandRunObserver {
  onEvent?: (event: CommandRunEvent) => void;
}

export interface CommandRunArgs {
  command?: string;
  cwd?: string;
  /** 前台等待预算（毫秒）：到点仍未结束则转后台；不是命令终止超时。 */
  foregroundWaitMs?: number;
  /** 硬执行截止时间；可靠 detached wrapper 在前台/后台都会强制执行。 */
  executionTimeoutMs?: number;
  /** stdout+stderr 原始字节总安全上限。 */
  maxOutputBytes?: number;
  /** 内部执行标识（通常为 toolCallId），用于在父 Run 中断前主动把前台命令转入后台。 */
  executionId?: string;
  /** Tool -> ProcessManager handoff 时持久化为独立 OriginLink 的来源关系快照。 */
  backgroundProcessOrigin?: BackgroundProcessOriginDescriptor;
  /** 仅控制仍属当前 Tool Attempt 的前台命令；转入独立后台进程后不再跟随该 signal。 */
  signal?: AbortSignal;
}

/** 返回给模型的 stdout/stderr 输出上限（保留末尾内容）。 */
export interface CommandOutputLimits {
  maxOutputLines: number;
  maxOutputChars: number;
}

/**
 * 命令执行/后台进程状态：
 * - completed：前台同步执行完毕。
 * - running：前台等待预算用尽后转入后台，进程仍在运行。
 * - exited：后台进程已自然退出（通过 output 读到）。
 * - killed：后台进程被 kill 终止。
 * - not_found：output/kill 指定的 processId 不存在（已清理或从未存在）。
 */
export type CommandRunStatus = 'completed' | 'running' | 'exited' | 'killed' | 'not_found';

export interface CommandRunResult {
  command: string;
  /** Running processes do not have an exit code yet; only terminal observations carry a number. */
  exitCode: number | null;
  killed: boolean;
  stdout: string;
  stderr: string;
  /** 执行/后台状态；旧调用方（如远程分支）可不填。 */
  status?: CommandRunStatus;
  /** 转入后台或针对后台进程操作时的进程 id。 */
  processId?: string;
  /** output 模式：进程当前是否仍在运行。 */
  running?: boolean;
  /** 因后台 buffer 上限被丢弃的字符数（>0 时提示模型有更早输出被截断）。 */
  droppedChars?: number;
  /** 模型 output 查询终态时的 durable revision owner；被 auto 接管时正文不会重复返回。 */
  terminalRevisionClaim?: 'model_poll' | 'auto_delivery';
}

export type WorkEnvironmentTransferKind = 'auto' | 'file' | 'directory';
export type WorkEnvironmentTransferVerifyMode = 'none' | 'size';

export interface WorkEnvironmentTransferItem {
  fromEnvironment: string;
  fromPath: string;
  toEnvironment: string;
  toPath: string;
  type?: WorkEnvironmentTransferKind;
  overwrite?: boolean;
  createDirs?: boolean;
}

export interface WorkEnvironmentTransferArgs {
  transfers?: WorkEnvironmentTransferItem[];
  verify?: WorkEnvironmentTransferVerifyMode;
}

export interface WorkEnvironmentTransferContext {
  activeWorkEnvironment?: WorkEnvironmentRecord;
  availableWorkEnvironments?: WorkEnvironmentRecord[];
  allowOutsideProjectPaths?: boolean;
  signal?: AbortSignal;
}

export interface WorkEnvironmentTransferEntryResult {
  success: boolean;
  index: number;
  type: WorkEnvironmentTransferKind;
  from: { environment: string; path: string };
  to: { environment: string; path: string };
  files?: number;
  dirs?: number;
  bytes?: number;
  verify?: { mode: WorkEnvironmentTransferVerifyMode; ok: boolean };
  error?: string;
  durationMs: number;
}

export interface WorkEnvironmentTransferResult {
  results: WorkEnvironmentTransferEntryResult[];
  successCount: number;
  failCount: number;
  totalCount: number;
}

export interface WorkEnvironmentRuntimeCapability {
  transferFiles(
    args: WorkEnvironmentTransferArgs,
    observer?: CommandRunObserver,
    context?: WorkEnvironmentTransferContext
  ): Promise<WorkEnvironmentTransferResult>;
}

/** 命令执行能力：根据 extension host 平台自动选择 PowerShell(shell) 或 Bash(bash)。 */
export interface CommandCapability {
  readonly toolName: 'shell' | 'bash';
  readonly description: string;
  /** 执行新命令；前台等待预算用尽时不 kill，而是转入后台并返回 { status:'running', processId }。limits 控制返回给模型的输出上限。 */
  run(args: CommandRunArgs, observer?: CommandRunObserver, options?: WorkEnvironmentCapabilityOptions, limits?: CommandOutputLimits): Promise<CommandRunResult>;
  /** 将仍在前台等待的本地命令立即转入后台；不存在、已结束或不支持后台化时返回 false。 */
  backgroundForeground(executionId: string): boolean;
  /** 读取某后台进程当前已累积的日志；默认 peek。模型 mode=output 可 claimTerminal，Webview 被动读取不得 claim。 */
  readOutput(processId: string, limits?: CommandOutputLimits, options?: { consume?: boolean; claimTerminal?: boolean }): CommandRunResult;
  /** 终止某后台进程；终止后日志仍保留，直到显式 consume。 */
  kill(processId: string): CommandRunResult;
  /** data-root 切换前把所有前台命令完成 handoff，并终止/持久化本实例拥有的后台进程。 */
  quiesce(): void;
  /** 扩展关闭时终止所有残留后台进程并清理。 */
  dispose(): void;
}

export interface WebviewClientRuntimeRecord {
  id: BridgeClientId;
  meta: WebviewClientMeta;
  attachedAt: number;
}

/** Webview 能力：集中管理多个 Webview client，真实 vscode.Webview 句柄不进入 ECS world。 */
export interface WebviewCapability {
  attach(webview: vscode.Webview, meta?: WebviewClientMeta): BridgeClientId;
  /** 分离 client，并返回因此失去最后一个订阅者的 stream。 */
  detach(clientId: BridgeClientId): string[];
  detachAll(): void;
  subscribe(clientId: BridgeClientId, streamId: string): void;
  unsubscribe(clientId: BridgeClientId, streamId: string): void;
  post(clientId: BridgeClientId, message: ExtensionToWebviewMessage): void;
  broadcast(message: ExtensionToWebviewMessage): void;
  broadcastToStream(streamId: string, message: ExtensionToWebviewMessage): void;
  clientIds(): BridgeClientId[];
  clientRecords(): WebviewClientRuntimeRecord[];
}

export type TurnControlStorageRootKey =
  | 'turns'
  | 'childTurnLinks'
  | 'messageTurnLinks'
  | 'turnIntents'
  | 'turnIntentRevisions'
  | 'turnExecutionPresetRevisions'
  | 'pendingTurnInputs'
  | 'executionLeases'
  | 'authoritySnapshots'
  | 'authorityDerivationLinks'
  | 'runtimeInboxItems'
  | 'runtimeDeliveryLinks'
  | 'interactions'
  | 'interactionOwnerLinks'
  | 'interactionResponses';

export interface RecordStorageRootPaths {
  rootUri: vscode.Uri;
  rootPath: string;
  indexUri: vscode.Uri;
  indexPath: string;
}

/** 插件数据目录：集中记录所有持久化数据的当前根位置；可由扩展级 globalState 指向自定义目录。 */
export interface RuntimePaths {
  /** 当前 active data root；未配置自定义目录时等于 VS Code context.globalStorageUri。 */
  globalStorageUri: vscode.Uri;
  globalStoragePath: string;
  /** data root 级兼容 marker、未完成重置 marker、归档与可靠事务控制面路径。 */
  dataEpochUri: vscode.Uri;
  dataResetPendingUri: vscode.Uri;
  dataBackupsRootUri: vscode.Uri;
  operationsRootUri: vscode.Uri;
  /** Turn/Intent/Lease/Authority/Inbox/Interaction 独立记录根，全部由当前 data root 动态派生。 */
  turnControlRoots: Record<TurnControlStorageRootKey, RecordStorageRootPaths>;
  /** Agent 数据根目录：<dataRoot>/agents */
  agentsRootUri: vscode.Uri;
  agentsRootPath: string;
  agentsIndexUri: vscode.Uri;
  agentsIndexPath: string;
  /** Workflow 数据根目录：<dataRoot>/workflows */
  workflowsRootUri: vscode.Uri;
  workflowsRootPath: string;
  workflowsIndexUri: vscode.Uri;
  workflowsIndexPath: string;
  /** PlanReviewPolicy 数据根目录：<dataRoot>/plan-review-policies */
  planReviewPoliciesRootUri: vscode.Uri;
  planReviewPoliciesRootPath: string;
  planReviewPoliciesIndexUri: vscode.Uri;
  planReviewPoliciesIndexPath: string;
  /** PlanReviewPolicy 与各作用域的关系数据根目录：<dataRoot>/plan-review-policy-scope-links */
  planReviewPolicyScopeLinksRootUri: vscode.Uri;
  planReviewPolicyScopeLinksRootPath: string;
  planReviewPolicyScopeLinksIndexUri: vscode.Uri;
  planReviewPolicyScopeLinksIndexPath: string;
  /** ToolPolicy 数据根目录：<dataRoot>/tool-policies */
  toolPoliciesRootUri: vscode.Uri;
  toolPoliciesRootPath: string;
  toolPoliciesIndexUri: vscode.Uri;
  toolPoliciesIndexPath: string;
  /** ToolPolicy 与各作用域的关系数据根目录：<dataRoot>/tool-policy-scope-links */
  toolPolicyScopeLinksRootUri: vscode.Uri;
  toolPolicyScopeLinksRootPath: string;
  toolPolicyScopeLinksIndexUri: vscode.Uri;
  toolPolicyScopeLinksIndexPath: string;
  /** SkillPolicy 数据根目录：<dataRoot>/skill-policies */
  skillPoliciesRootUri: vscode.Uri;
  skillPoliciesRootPath: string;
  skillPoliciesIndexUri: vscode.Uri;
  skillPoliciesIndexPath: string;
  /** SkillPolicy 与各作用域的关系数据根目录：<dataRoot>/skill-policy-scope-links */
  skillPolicyScopeLinksRootUri: vscode.Uri;
  skillPolicyScopeLinksRootPath: string;
  skillPolicyScopeLinksIndexUri: vscode.Uri;
  skillPolicyScopeLinksIndexPath: string;
  /** SystemPrompt 数据根目录：<dataRoot>/system-prompts */
  systemPromptsRootUri: vscode.Uri;
  systemPromptsRootPath: string;
  systemPromptsIndexUri: vscode.Uri;
  systemPromptsIndexPath: string;
  /** RuntimeContext 模板数据根目录：<dataRoot>/runtime-contexts */
  runtimeContextsRootUri: vscode.Uri;
  runtimeContextsRootPath: string;
  runtimeContextsIndexUri: vscode.Uri;
  runtimeContextsIndexPath: string;
  /** RuntimeContext 与各 scope 的关系数据根目录：<dataRoot>/runtime-context-scope-links */
  runtimeContextScopeLinksRootUri: vscode.Uri;
  runtimeContextScopeLinksRootPath: string;
  runtimeContextScopeLinksIndexUri: vscode.Uri;
  runtimeContextScopeLinksIndexPath: string;
  /** RuntimeContext 快照数据根目录：<dataRoot>/runtime-context-snapshots */
  runtimeContextSnapshotsRootUri: vscode.Uri;
  runtimeContextSnapshotsRootPath: string;
  runtimeContextSnapshotsIndexUri: vscode.Uri;
  runtimeContextSnapshotsIndexPath: string;
  /** Conversation 与 RuntimeContextSnapshot 的关系数据根目录：<dataRoot>/conversation-runtime-context-snapshot-links */
  conversationRuntimeContextSnapshotLinksRootUri: vscode.Uri;
  conversationRuntimeContextSnapshotLinksRootPath: string;
  conversationRuntimeContextSnapshotLinksIndexUri: vscode.Uri;
  conversationRuntimeContextSnapshotLinksIndexPath: string;
  /** Run 与 RuntimeContextSnapshot 的关系数据根目录：<dataRoot>/run-runtime-context-snapshot-links */
  runRuntimeContextSnapshotLinksRootUri: vscode.Uri;
  runRuntimeContextSnapshotLinksRootPath: string;
  runRuntimeContextSnapshotLinksIndexUri: vscode.Uri;
  runRuntimeContextSnapshotLinksIndexPath: string;
  /** ModelProfile 数据根目录：<dataRoot>/model-profiles */
  modelProfilesRootUri: vscode.Uri;
  modelProfilesRootPath: string;
  modelProfilesIndexUri: vscode.Uri;
  modelProfilesIndexPath: string;
  /** SystemPrompt 与各 scope 的关系数据根目录：<dataRoot>/system-prompt-scope-links */
  systemPromptScopeLinksRootUri: vscode.Uri;
  systemPromptScopeLinksRootPath: string;
  systemPromptScopeLinksIndexUri: vscode.Uri;
  systemPromptScopeLinksIndexPath: string;
  /** ModelProfile 与各 scope 的关系数据根目录：<dataRoot>/model-profile-scope-links */
  modelProfileScopeLinksRootUri: vscode.Uri;
  modelProfileScopeLinksRootPath: string;
  modelProfileScopeLinksIndexUri: vscode.Uri;
  modelProfileScopeLinksIndexPath: string;
  /** Conversation/消息数据根目录：<dataRoot>/conversations */
  conversationsRootUri: vscode.Uri;
  conversationsRootPath: string;
  conversationsIndexUri: vscode.Uri;
  conversationsIndexPath: string;
  /** 侧边栏历史列表读模型根目录：<dataRoot>/conversation-history */
  conversationHistoryRootUri: vscode.Uri;
  conversationHistoryRootPath: string;
  conversationHistoryIndexUri: vscode.Uri;
  conversationHistoryIndexPath: string;
  /** 多模态小附件数据根目录：<dataRoot>/attachments */
  attachmentsRootUri: vscode.Uri;
  attachmentsRootPath: string;
  attachmentsIndexUri: vscode.Uri;
  attachmentsIndexPath: string;
  /** 项目路径上下文数据根目录：<dataRoot>/project-contexts */
  projectContextsRootUri: vscode.Uri;
  projectContextsRootPath: string;
  projectContextsIndexUri: vscode.Uri;
  projectContextsIndexPath: string;
  /** Conversation 与项目路径的关系数据根目录：<dataRoot>/conversation-project-links */
  conversationProjectLinksRootUri: vscode.Uri;
  conversationProjectLinksRootPath: string;
  conversationProjectLinksIndexUri: vscode.Uri;
  conversationProjectLinksIndexPath: string;
  /** 工作环境数据根目录：<dataRoot>/work-environments */
  workEnvironmentsRootUri: vscode.Uri;
  workEnvironmentsRootPath: string;
  workEnvironmentsIndexUri: vscode.Uri;
  workEnvironmentsIndexPath: string;
  /** 工作环境策略数据根目录：<dataRoot>/work-environment-policies */
  workEnvironmentPoliciesRootUri: vscode.Uri;
  workEnvironmentPoliciesRootPath: string;
  workEnvironmentPoliciesIndexUri: vscode.Uri;
  workEnvironmentPoliciesIndexPath: string;
  workEnvironmentPolicyScopeLinksRootUri: vscode.Uri;
  workEnvironmentPolicyScopeLinksRootPath: string;
  workEnvironmentPolicyScopeLinksIndexUri: vscode.Uri;
  workEnvironmentPolicyScopeLinksIndexPath: string;
  /** Conversation 与工作环境的关系数据根目录：<dataRoot>/conversation-work-environment-links */
  conversationWorkEnvironmentLinksRootUri: vscode.Uri;
  conversationWorkEnvironmentLinksRootPath: string;
  conversationWorkEnvironmentLinksIndexUri: vscode.Uri;
  conversationWorkEnvironmentLinksIndexPath: string;
  /** AgentRun 与工作环境的关系数据根目录：<dataRoot>/run-work-environment-links */
  runWorkEnvironmentLinksRootUri: vscode.Uri;
  runWorkEnvironmentLinksRootPath: string;
  runWorkEnvironmentLinksIndexUri: vscode.Uri;
  runWorkEnvironmentLinksIndexPath: string;
  checkpointPoliciesRootUri: vscode.Uri;
  checkpointPoliciesRootPath: string;
  checkpointPoliciesIndexUri: vscode.Uri;
  checkpointPoliciesIndexPath: string;
  checkpointPolicyScopeLinksRootUri: vscode.Uri;
  checkpointPolicyScopeLinksRootPath: string;
  checkpointPolicyScopeLinksIndexUri: vscode.Uri;
  checkpointPolicyScopeLinksIndexPath: string;
  shadowRepositoriesRootUri: vscode.Uri;
  shadowRepositoriesRootPath: string;
  shadowRepositoriesIndexUri: vscode.Uri;
  shadowRepositoriesIndexPath: string;
  conversationCheckpointRepositoryLinksRootUri: vscode.Uri;
  conversationCheckpointRepositoryLinksRootPath: string;
  conversationCheckpointRepositoryLinksIndexUri: vscode.Uri;
  conversationCheckpointRepositoryLinksIndexPath: string;
  checkpointsRootUri: vscode.Uri;
  checkpointsRootPath: string;
  checkpointsIndexUri: vscode.Uri;
  checkpointsIndexPath: string;
  checkpointTimelineAnchorsRootUri: vscode.Uri;
  checkpointTimelineAnchorsRootPath: string;
  checkpointTimelineAnchorsIndexUri: vscode.Uri;
  checkpointTimelineAnchorsIndexPath: string;
  checkpointShadowWorktreesRootUri: vscode.Uri;
  checkpointShadowWorktreesRootPath: string;
  compressionBlocksRootUri: vscode.Uri;
  compressionBlocksRootPath: string;
  compressionBlocksIndexUri: vscode.Uri;
  compressionBlocksIndexPath: string;
  compressionBlockSourceLinksRootUri: vscode.Uri;
  compressionBlockSourceLinksRootPath: string;
  compressionBlockSourceLinksIndexUri: vscode.Uri;
  compressionBlockSourceLinksIndexPath: string;
  compressionContextVariantsRootUri: vscode.Uri;
  compressionContextVariantsRootPath: string;
  compressionContextVariantsIndexUri: vscode.Uri;
  compressionContextVariantsIndexPath: string;
  compressionBlockLlmInvocationLinksRootUri: vscode.Uri;
  compressionBlockLlmInvocationLinksRootPath: string;
  compressionBlockLlmInvocationLinksIndexUri: vscode.Uri;
  compressionBlockLlmInvocationLinksIndexPath: string;

  /** Agent 与 Conversation 的关系数据根目录：<dataRoot>/agent-conversation-links */
  linksRootUri: vscode.Uri;
  linksRootPath: string;
  linksIndexUri: vscode.Uri;
  linksIndexPath: string;
  /** Conversation 的当前工作流选择数据根目录：<dataRoot>/conversation-workflow-selections */
  conversationWorkflowSelectionsRootUri: vscode.Uri;
  conversationWorkflowSelectionsRootPath: string;
  conversationWorkflowSelectionsIndexUri: vscode.Uri;
  conversationWorkflowSelectionsIndexPath: string;
  /** Conversation 的当前 Agent 选择数据根目录：<dataRoot>/conversation-agent-selections */
  conversationAgentSelectionsRootUri: vscode.Uri;
  conversationAgentSelectionsRootPath: string;
  conversationAgentSelectionsIndexUri: vscode.Uri;
  conversationAgentSelectionsIndexPath: string;
  /** Agent 回答数据根目录：<dataRoot>/agent-answers */
  agentAnswersRootUri: vscode.Uri;
  agentAnswersRootPath: string;
  agentAnswersIndexUri: vscode.Uri;
  agentAnswersIndexPath: string;
  /** Agent 回答提交来源关系数据根目录：<dataRoot>/agent-answer-submission-links */
  agentAnswerSubmissionLinksRootUri: vscode.Uri;
  agentAnswerSubmissionLinksRootPath: string;
  agentAnswerSubmissionLinksIndexUri: vscode.Uri;
  agentAnswerSubmissionLinksIndexPath: string;
  /** Agent 回答目标关系数据根目录：<dataRoot>/agent-answer-target-links */
  agentAnswerTargetLinksRootUri: vscode.Uri;
  agentAnswerTargetLinksRootPath: string;
  agentAnswerTargetLinksIndexUri: vscode.Uri;
  agentAnswerTargetLinksIndexPath: string;

  /** 独立后台进程主体与日志：<dataRoot>/background-processes */
  backgroundProcessesRootUri: vscode.Uri;
  backgroundProcessesRootPath: string;
  backgroundProcessesIndexUri: vscode.Uri;
  backgroundProcessesIndexPath: string;
  /** BackgroundProcess 与 ToolCall/Run/Conversation 的来源关系。 */
  backgroundProcessOriginLinksRootUri: vscode.Uri;
  backgroundProcessOriginLinksRootPath: string;
  backgroundProcessOriginLinksIndexUri: vscode.Uri;
  backgroundProcessOriginLinksIndexPath: string;
  /** 不可变进程退出事实。 */
  backgroundProcessExitReceiptsRootUri: vscode.Uri;
  backgroundProcessExitReceiptsRootPath: string;
  backgroundProcessExitReceiptsIndexUri: vscode.Uri;
  backgroundProcessExitReceiptsIndexPath: string;
  /** 退出事实到可靠对话命令的 durable outbox。 */
  backgroundProcessNotificationDeliveriesRootUri: vscode.Uri;
  backgroundProcessNotificationDeliveriesRootPath: string;
  backgroundProcessNotificationDeliveriesIndexUri: vscode.Uri;
  backgroundProcessNotificationDeliveriesIndexPath: string;
  /** 通用设置根目录：<dataRoot>/settings */
  settingsRootUri: vscode.Uri;
  settingsRootPath: string;
  /** LLM 设置文件：<dataRoot>/settings/llm.json */
  llmSettingsUri: vscode.Uri;
  llmSettingsPath: string;
}

/** VS Code 存储能力：通过 workspace.fs/globalState 读写插件全局数据。 */
export interface StorageDataResetResult {
  dataRootPath: string;
  epoch: number;
  archivedEntries: string[];
  backupPath?: string;
}

export interface StorageCapability {
  /** 当前 active data root 派生出的路径；数据目录切换后 getter 会返回新路径。 */
  readonly paths: RuntimePaths;
  ensureReady(): Promise<void>;
  /** 归档或删除 LimCode 受管条目后创建当前 data epoch；不会触碰 data root 内的其它用户文件。 */
  resetDataRoot(options?: { archive?: boolean }): Promise<StorageDataResetResult>;
  /**
   * Blob-first attachment admission boundary. Returns the only MessageContent representation that
   * may enter durable conversation facts: immutable managed/local references with no inline bytes.
   */
  ingestMessageContentAttachments(content: import('../../shared/protocol').MessageContent): Promise<import('../../shared/protocol').MessageContent>;
  /** Canonicalizes and blob-first stages one raw tool result before the reliable terminal transaction. */
  stageToolResultContent(content: import('../../shared/conversationReliability').JsonValue): Promise<import('../../shared/protocol').StagedToolResultContent>;
  /** Strict lazy read of one canonical ToolResult Artifact. */
  loadToolResultContent(artifact: import('../../shared/protocol').ToolResultArtifactRecord): Promise<import('../../shared/conversationReliability').JsonValue>;
  loadClientStateSkeleton(options?: { profile?: 'startup' | 'deferred' | 'full' }): Promise<ClientState | undefined>;
  saveClientStateSkeleton(state: ClientState): Promise<void>;
  loadConversationHistoryPage(request: ConversationHistoryPageRequest): Promise<ConversationHistoryPageRecord>;
  upsertConversationHistoryEntry(
    entry: import('../../shared/protocol').SidebarConversationHistoryEntry,
    originLink?: import('../../shared/protocol').ConversationOriginLinkRecord
  ): Promise<void>;
  removeConversationHistoryEntry(conversationId: string): Promise<void>;
  detectSystemGit(): Promise<CheckpointGitStatusRecord>;
  createShadowCheckpoint(request: ShadowCheckpointCreateRequest): Promise<CheckpointRecord>;
  restoreShadowCheckpoint(request: CheckpointRestorePayload): Promise<ShadowCheckpointRestoreResult>;
  openShadowCheckpointDiff(request: ShadowCheckpointDiffOpenRequest): Promise<ShadowCheckpointDiffOpenResult>;
  collectShadowWorktreeStats(): Promise<ShadowRepositoryDiskStatRecord[]>;
  deleteShadowWorktrees(storageKeys: string[]): Promise<{ deletedStorageKeys: string[] }>;
  cleanupUnusedShadowWorktrees(maxAgeDays: number): Promise<{ deletedStorageKeys: string[] }>;
  loadGlobalSettings(section: GlobalSettingsSection): Promise<{ section: GlobalSettingsSection; settings: GlobalSettingsSectionValue; filePath: string; revision: string }>;
  saveGlobalSettings(section: GlobalSettingsSection, settings: GlobalSettingsSectionValue, expectedRevision: string): Promise<{ section: GlobalSettingsSection; settings: GlobalSettingsSectionValue; filePath: string; revision: string; previousSettings?: GlobalSettingsSectionValue }>;
  loadActiveLlmProviderConfig(conversationId?: string): Promise<LlmProviderConfigRecord>;
  loadLlmProviderConfigById(configId: string): Promise<LlmProviderConfigRecord | undefined>;
  loadActiveLlmCompressionConfig(providerConfigId?: string, modelId?: string): Promise<LlmCompressionConfigRecord | undefined>;
  loadLlmCompressionConfigById(configId: string): Promise<LlmCompressionConfigRecord | undefined>;
  loadConversationSettings(conversationId: string, section: ConversationSettingsSection): Promise<{ conversationId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string } | undefined>;
  saveConversationSettings(section: ConversationSettingsSection, settings: ConversationSettingsSectionValue): Promise<{ conversationId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string }>;
}

export interface ShadowCheckpointCreateRequest {
  checkpointId: string;
  conversationId: string;
  projectContextId: string;
  projectUri: string;
  projectDisplayPath: string;
  shadowRepositoryId: string;
  shadowRepositoryStorageKey: string;
  trigger: CheckpointTriggerKind;
  policy: CheckpointPolicyRecord;
}

export interface ShadowCheckpointDiffOpenRequest {
  checkpointId: string;
  conversationId: string;
  shadowRepositoryStorageKey: string;
  commitSha: string;
  projectUri: string;
  filePath: string;
}

export interface ShadowCheckpointDiffOpenResult {
  status: 'opened' | 'failed';
  message: string;
}
