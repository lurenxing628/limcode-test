import type { TurnExecutionPhase, TurnLifecycleStatus } from './turnLifecycle';
import type { NativeSteeringReceipt, OpenAIResponsesNativeSettings } from './openAIResponsesNative';
import type { DebugCaptureSettings, DebugCaptureCommand, DebugCaptureResult, DebugCaptureUiBatch, DebugCaptureUiAck } from './debugCapture';
import type {
  AuthoritySnapshotRecord,
  CommittedConversationHead,
  DurableInteractionRequestRecord,
  DurableInteractionDecision,
  ExecutionLeaseRecord,
  InteractionOwnerLinkRecord,
  InteractionResponseRecord,
  JsonValue,
  MessageTurnLinkRecord,
  PendingTurnInputRecord,
  RuntimeDeliveryLinkRecord,
  TurnIntentRecord,
  TurnIntentRevisionRecord,
  TurnRecord
} from './conversationReliability';

export type MessageId = string;
export type BridgeClientId = string;

export type BridgeChannel = 'control' | 'command' | 'state' | 'settings' | 'diagnostics';

export type BridgeScope =
  | { kind: 'global' }
  | { kind: 'conversation'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'settings'; level: 'global' | 'conversation' | 'agent' | 'workflow'; id?: string };

export interface WebviewClientMeta {
  kind: 'mainPanel' | 'globalSettings' | 'workflowSettings' | 'agentSettings' | 'planDetail' | 'sidebar' | 'unknown';
  panelId?: string;
  title?: string;
  conversationId?: string;
  toolCallId?: string;
  planProposalId?: string;
}

export const GLOBAL_SETTINGS_SECTIONS = ['common', 'network', 'llm', 'llmProviderConfigs', 'llmCompression', 'llmCompressionConfigs', 'checkpointMaintenance', 'appearance', 'attachments', 'mcpServers', 'debugCapture'] as const;
export type GlobalSettingsSection = typeof GLOBAL_SETTINGS_SECTIONS[number];

export const CONVERSATION_SETTINGS_SECTIONS = ['common', 'llm'] as const;
export type ConversationSettingsSection = typeof CONVERSATION_SETTINGS_SECTIONS[number];

export enum BridgeMessageType {
  Hello = 'bridge.hello',
  Ready = 'bridge.ready',
  Ping = 'bridge.ping',
  Pong = 'bridge.pong',
  Ack = 'bridge.ack',
  GetWorkspaceInfo = 'workspace.getInfo',
  WorkspaceInfo = 'workspace.info',
  ShowInfo = 'vscode.showInfo',
  Error = 'bridge.error',
  InteractionResult = 'interaction.result',
  TurnStart = 'turn.start',
  TurnEnqueue = 'turn.enqueue',
  TurnInputResult = 'turn.input.result',
  TurnInterrupt = 'turn.interrupt',
  TurnInterruptResult = 'turn.interrupt.result',
  TurnSteer = 'turn.steer',
  TurnSteerResult = 'turn.steer.result',
  GuidanceEdit = 'guidance.edit',
  GuidanceCancel = 'guidance.cancel',
  GuidanceReorder = 'guidance.reorder',
  GuidanceHold = 'guidance.hold',
  GuidanceControlResult = 'guidance.control.result',
  InteractionResolve = 'interaction.resolve',
  ConversationOpen = 'conversation.open',
  ConversationCreate = 'conversation.create',
  ConversationFork = 'conversation.fork',
  ConversationForkResult = 'conversation.fork.result',
  AgentCreate = 'agent.create',
  AgentUpdate = 'agent.update',
  AgentDelete = 'agent.delete',
  SystemPromptScopeSet = 'systemPrompt.scope.set',
  SystemPromptScopeClear = 'systemPrompt.scope.clear',
  RuntimeContextScopeSet = 'runtimeContext.scope.set',
  RuntimeContextScopeClear = 'runtimeContext.scope.clear',
  ModelProfileScopeSet = 'modelProfile.scope.set',
  ModelProfileScopeClear = 'modelProfile.scope.clear',
  MessageEdit = 'message.edit',
  MessageDeleteFrom = 'message.deleteFrom',
  MessageRetryFrom = 'message.retryFrom',
  ConversationActionResult = 'conversation.action.result',
  CompressionStart = 'compression.start',
  CompressionCommandResult = 'compression.command.result',
  ToolPolicyScopeSet = 'toolPolicy.scope.set',
  ToolPolicyScopeClear = 'toolPolicy.scope.clear',
  SkillPolicyScopeSet = 'skillPolicy.scope.set',
  SkillPolicyScopeClear = 'skillPolicy.scope.clear',
  SkillCatalogRefresh = 'skill.catalog.refresh',
  RulesFileSave = 'rules.file.save',
  RulesCatalogRefresh = 'rules.catalog.refresh',
  ToolExecutionCancel = 'tool.execution.cancel',
  ProcessStop = 'process.stop',
  ToolDiffOpen = 'tool.diff.open',
  PlanProposalOpen = 'planProposal.open',
  PlanProposalExport = 'planProposal.export',
  CheckpointDiffOpen = 'checkpoint.diff.open',
  LocalFileOpen = 'localFile.open',
  AttachmentOpen = 'attachment.open',
  AttachmentOpenResult = 'attachment.open.result',
  AttachmentReload = 'attachment.reload',
  AttachmentReloadResult = 'attachment.reload.result',
  CheckpointDiffOpenResult = 'checkpoint.diff.open.result',
  ClientResync = 'client.resync',
  ConfigurationSnapshot = 'configuration.snapshot',
  LlmProviderModelsGet = 'llm.providerModels.get',
  LlmProviderModelsSnapshot = 'llm.providerModels.snapshot',
  GlobalSettingsGet = 'settings.global.get',
  GlobalSettingsUpdate = 'settings.global.update',
  GlobalSettingsSnapshot = 'settings.global.snapshot',
  GlobalSettingsFlush = 'settings.global.flush',
  GlobalSettingsFlushResult = 'settings.global.flush.result',
  DebugCaptureCommand = 'diagnostics.capture.command',
  DebugCaptureResult = 'diagnostics.capture.result',
  DebugCaptureObservation = 'diagnostics.capture.observation',
  DebugCaptureObservationAck = 'diagnostics.capture.observation.ack',
  ConversationSettingsGet = 'settings.conversation.get',
  ConversationSettingsUpdate = 'settings.conversation.update',
  ConversationSettingsSnapshot = 'settings.conversation.snapshot',
  ProjectFoldersGet = 'projectFolders.get',
  ProjectFoldersSnapshot = 'projectFolders.snapshot',
  WorkflowCreate = 'workflow.create',
  WorkflowUpdate = 'workflow.update',
  WorkflowDelete = 'workflow.delete',
  ConversationWorkflowSelect = 'conversation.workflow.select',
  ConversationAgentSelect = 'conversation.agent.select',
  WorkEnvironmentSelect = 'workEnvironment.select',
  WorkEnvironmentUpsert = 'workEnvironment.upsert',
  WorkEnvironmentRemove = 'workEnvironment.remove',
  WorkEnvironmentImportFromVscode = 'workEnvironment.importFromVscode',
  WorkEnvironmentPolicyScopeSet = 'workEnvironmentPolicy.scope.set',
  WorkEnvironmentPolicyScopeClear = 'workEnvironmentPolicy.scope.clear',
  PlanReviewPolicyScopeSet = 'planReviewPolicy.scope.set',
  PlanReviewPolicyScopeClear = 'planReviewPolicy.scope.clear',
  CheckpointPolicyScopeSet = 'checkpointPolicy.scope.set',
  CheckpointPolicyScopeClear = 'checkpointPolicy.scope.clear',
  CheckpointGitStatusGet = 'checkpoint.gitStatus.get',
  CheckpointGitStatusSnapshot = 'checkpoint.gitStatus.snapshot',
  CheckpointShadowStatsGet = 'checkpoint.shadowStats.get',
  CheckpointShadowStatsSnapshot = 'checkpoint.shadowStats.snapshot',
  CheckpointShadowDelete = 'checkpoint.shadow.delete',
  CheckpointDismiss = 'checkpoint.dismiss',
  CheckpointRestore = 'checkpoint.restore',
  CheckpointRestoreResult = 'checkpoint.restore.result',
  FsStatGet = 'fs.stat.get',
  FsStatResult = 'fs.stat.result',

}

export interface BridgeEnvelope<TType extends string = string, TPayload = unknown> {
  id: MessageId;
  type: TType;
  channel: BridgeChannel;
  scope?: BridgeScope;
  clientId?: BridgeClientId;
  correlationId?: MessageId;
  seq?: number;
  ack?: number;
  payload?: TPayload;
}

export interface RuntimeBuildInfoRecord {
  extensionName: string;
  extensionVersion: string;
  providerVersion: string;
  webSocketVersion: string;
  proxyAgentVersion: string;
  wsImplementation: string;
  /** Extension Host 激活时实际加载的代码指纹。 */
  buildFingerprint: string;
  /** 当前磁盘上对应编译产物的指纹；与 buildFingerprint 不同时必须重载 Extension Host。 */
  currentBuildFingerprint: string;
  reloadRequired: boolean;
  reloadReason?: 'extension_files_changed';
  runtimeInstanceId: string;
  activatedAt: number;
  processId: number;
  nodeVersion: string;
}

export interface BridgeHelloPayload {
  clientId: BridgeClientId;
  attachedAt: number;
  meta: WebviewClientMeta;
  runtime: RuntimeBuildInfoRecord;
}

export interface BridgeAckPayload {
  streamId?: string;
  seq?: number;
}

export interface WorkspaceInfo {
  name: string;
  folders: string[];
}

export interface FsStatGetPayload {
  paths: string[];
}

export interface FsStatResultPayload {
  results: FsStatResultEntry[];
}

export interface FsStatResultEntry {
  path: string;
  isDirectory: boolean;
  exists: boolean;
}

export interface SidebarConversationHistoryEntry {
  id: string;
  title: string;
  preview: string;
  previewState?: 'pending' | 'empty';
  messageCount: number;
  status: MessageMaterializationStatus | 'empty';
  createdAt: number;
  updatedAt: number;
  agentName?: string;
  isRunning: boolean;
  /** Exact active Turn identity used by Sidebar Stop; never resolve a successor at click handling time. */
  activeTurnId?: string;
  executionLeaseGeneration?: string;
  /** Read-only reliable-runtime projection; child states are never inferred from display text. */
  runState?: 'running' | 'awaiting_parent' | 'completed' | 'delivery_failed' | 'interrupted';
  runStatusLabel?: string;
  projectFolderUri?: string;
  projectName?: string;
}

export interface OpenConversationPanelRecord {
  conversationId: string;
  visible: boolean;
  active: boolean;
}

export type ConversationHistoryScope =
  | { kind: 'project'; folderUri: string }
  | { kind: 'unbound' }
  | { kind: 'all' };

export type SidebarHistoryScopeKind = 'currentProject' | 'project' | 'unbound' | 'all';

export interface ConversationHistoryPageRequest {
  scope: ConversationHistoryScope;
  cursor?: string;
  limit?: number;
}

export interface ConversationHistoryPageInfo {
  cursor?: string;
  nextCursor?: string;
  previousCursor?: string;
  pageIndex: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface ConversationHistoryPageRecord {
  scope: ConversationHistoryScope;
  entries: SidebarConversationHistoryEntry[];
  /** 独立的会话来源关系；历史列表按需解释 sourceConversationId，不嵌入条目。 */
  originLinks: ConversationOriginLinkRecord[];
  pageInfo: ConversationHistoryPageInfo;
}

export type MsgRole = 'user' | 'model';
/** 仅描述 Message.content 是否仍在物化；执行失败、取消和暂停由 Run 事实表达。 */
export const MESSAGE_MATERIALIZATION_STATUSES = ['streaming', 'final', 'partial'] as const;
export type MessageMaterializationStatus = typeof MESSAGE_MATERIALIZATION_STATUSES[number];

export function isMessageMaterializationStatus(value: unknown): value is MessageMaterializationStatus {
  return typeof value === 'string'
    && (MESSAGE_MATERIALIZATION_STATUSES as readonly string[]).includes(value);
}

export const TOOL_CALL_STATUSES = [
  'streaming',
  'queued',
  'awaiting_approval',
  'awaiting_user_input',
  'awaiting_child',
  'executing',
  'awaiting_change_apply',
  'applying_change',
  'change_applied',
  'change_rejected',
  'awaiting_result_submit',
  'success',
  'warning',
  'error'
] as const;
export type ToolCallStatus = typeof TOOL_CALL_STATUSES[number];
export const TERMINAL_TOOL_CALL_STATUSES: ReadonlySet<ToolCallStatus> = new Set(['success', 'warning', 'error']);

export type ToolExecutionKind = 'runtime' | 'agentRun';
export type ToolSchedulingMode = 'parallel' | 'serial';
export type ToolRiskLevel = 'read' | 'write' | 'command' | 'agent';
export type ToolDefinitionCategory = 'filesystem' | 'command' | 'agent' | 'general';
export type ToolDomainScope = 'agent' | 'file' | 'command' | 'conversation' | 'workEnvironment' | 'task' | 'skill' | 'general';
export type ToolConfigFieldType = 'string' | 'number' | 'boolean' | 'stringList' | 'globList' | 'enum' | 'json';
export type ToolConfigValue = string | number | boolean | null | string[] | number[] | boolean[] | unknown[] | Record<string, unknown>;
export type ToolConfigRecord = Record<string, ToolConfigValue>;

export interface ToolConfigFieldOptionRecord {
  label: string;
  value: string | number | boolean;
  description?: string;
}

export interface ToolConfigFieldRecord {
  key: string;
  label: string;
  type: ToolConfigFieldType;
  description?: string;
  required?: boolean;
  defaultValue?: ToolConfigValue;
  placeholder?: string;
  options?: ToolConfigFieldOptionRecord[];
  sensitive?: boolean;
}

export interface ToolConfigSchemaRecord {
  fields: ToolConfigFieldRecord[];
}

export interface ToolDefinitionMetadataRecord {
  category?: ToolDefinitionCategory;
  /** 工具领域分类，不是 ToolPolicyScopeKind。用于设置页分组、筛选与隐藏显示。 */
  scope?: ToolDomainScope;
  riskLevel?: ToolRiskLevel;
  readonly?: boolean;
  defaultEnabled?: boolean;
  requiresApproval?: boolean;
  defaultAutoExpand?: boolean;
  /** true 表示工具执行结果存在“待应用更改”阶段，适合显示自动应用/手动应用配置。 */
  supportsChangeApply?: boolean;
  /** true 表示工具结果可通过存档点打开 VS Code diff 预览。 */
  supportsDiffPreview?: boolean;
  defaultAutoOpenDiffPreview?: boolean;
  defaultAutoApproveExecution?: boolean;
  defaultAutoApplyChange?: boolean;
  defaultAutoApplyChangeDelaySeconds?: number;
  defaultAutoSubmitResult?: boolean;
  checkpoint?: Partial<CheckpointToolTriggerConfigRecord>;
}

export interface ToolDefinitionRecord {
  id: string;
  name: string;
  description: string;
  parameters: unknown;
  execution: ToolExecutionKind;
  source?: ToolDefinitionSourceRecord;
  metadata?: ToolDefinitionMetadataRecord;
  configSchema?: ToolConfigSchemaRecord;
  defaultConfig?: ToolConfigRecord;
}

export interface ToolDefinitionSourceRecord {
  kind: 'builtin' | 'mcp';
  sourceId?: string;
  sourceName?: string;
  originalToolName?: string;
}

export const TASK_LIST_TOOL_NAME = 'update_task_list';
export const ASK_USER_TOOL_NAME = 'ask_user';
export const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';
export const SWITCH_WORK_ENVIRONMENT_TOOL_NAME = 'switch_work_environment';
export const TRANSFER_TOOL_NAME = 'transfer';
export const READ_TOOL_NAME = 'read';
export const EDIT_TOOL_NAME = 'edit';
export const WRITE_TOOL_NAME = 'write';
export const DELETE_TOOL_NAME = 'delete';
export const ALLOW_OUTSIDE_PROJECT_PATHS_CONFIG_KEY = 'allowOutsideProjectPaths';
export const SUBMIT_AGENT_ANSWER_TOOL_NAME = 'submit_agent_answer';
export const READ_AGENT_ANSWER_TOOL_NAME = 'read_agent_answer';
export const SKILLS_TOOL_NAME = 'skills';

export type EditToolMode = 'hunk' | 'insert' | 'delete';

export const TASK_LIST_ITEM_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'cancelled'
] as const;
export type TaskListItemStatus = typeof TASK_LIST_ITEM_STATUSES[number];
export type TaskListToolMode = 'rewrite' | 'update';

export interface TaskListToolItemRecord {
  /** 面向用户展示的任务标题；update 模式下也作为匹配键。 */
  title: string;
  /** 任务的补充说明、验收条件或上下文；任务进行中时也作为当前活动文案展示。 */
  description?: string;
  /** 不传时前端回放会沿用旧状态；新任务默认 pending。 */
  status?: TaskListItemStatus;
  /** update 模式下删除同标题任务。 */
  delete?: boolean;
}

export interface TaskListToolOperationRecord {
  kind: 'task_list.operation';
  mode: TaskListToolMode;
  items: TaskListToolItemRecord[];
}

export interface TaskListToolOutputRecord {
  kind: 'task_list.result';
  operation: TaskListToolOperationRecord;
  summary: string;
}

export interface AskUserOptionRecord {
  label: string;
  description?: string;
}

export interface AskUserToolRequestRecord {
  question: string;
  options: AskUserOptionRecord[];
  /** false 为单选；true 为多选。模型省略该参数时按 false 处理。 */
  multiple: boolean;
}

export interface AskUserAnswerRecord {
  /** 选项在请求 options 数组中的索引；不要求模型生成额外选项 id。 */
  selectedOptionIndexes: number[];
  /** 自定义描述始终可用；多选时可以与预设选项同时提交。 */
  customText?: string;
}

export interface AskUserToolOutputRecord {
  kind: 'ask_user.result';
  question: string;
  multiple: boolean;
  selectedOptions: AskUserOptionRecord[];
  customText?: string;
}

export interface SubmitPlanToolRequestRecord {
  plan: string;
  taskList: TaskListToolOperationRecord;
}

export type SubmitPlanDecisionStatus = 'approved' | 'change_requested' | 'rejected' | 'cancelled';
export type SubmitPlanExecutionTarget = 'current_conversation' | 'new_conversation';
export type SubmitPlanDelegationStatus = 'backgrounded';

export interface SubmitPlanToolOutputRecord {
  kind: 'submit_plan.result';
  proposalId: string;
  status: SubmitPlanDecisionStatus;
  userMessage?: string;
  executionTarget?: SubmitPlanExecutionTarget;
  delegationStatus?: SubmitPlanDelegationStatus;
  agentId?: string;
  agentType?: string;
  childExecutionId?: string;
  runId?: string;
  conversationId?: string;
  answerBridgeId?: string;
}

export type LlmProviderKind = 'openai-compatible' | 'openai-responses' | 'claude' | 'gemini' | 'deepseek';
export type LlmToolCallFormat = 'function-call';
export type LlmOpenAIResponsesTransport = 'http' | 'websocket';
export type LlmPromptCacheTtl = '5m' | '30m' | '1h';
/**
 * LimCode 暴露的 Prompt Cache 请求模式。
 * - key：仅为 OpenAI Responses 发送稳定的 prompt_cache_key。
 * - explicit：为 OpenAI Responses 发送 prompt_cache_options 与聊天记录末尾断点；Claude 固定使用此语义。
 */
export type LlmPromptCacheMode = 'key' | 'explicit';
export type LlmThinkingLevel = 'not-set' | 'non-set' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type LlmReasoningMode = 'standard' | 'pro';

export interface LlmThinkingConfigRecord {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: LlmThinkingLevel;
  reasoningMode?: LlmReasoningMode;
}

export interface LlmGenerationConfigRecord {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  thinkingConfig?: LlmThinkingConfigRecord;
}

export type LlmRequestBodyJsonValue =
  | string
  | number
  | boolean
  | null
  | LlmRequestBodyJsonValue[]
  | { [key: string]: LlmRequestBodyJsonValue };

export type LlmRequestBodyRecord = Record<string, LlmRequestBodyJsonValue>;
export type LlmProviderHeadersRecord = Record<string, string>;

export interface LlmUsageMetadataRecord {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cacheCreationInputTokenCount?: number;
  cacheCreationInputTokensDetails?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LlmSettingsRecord {
  activeProviderConfigId: string;
}

export interface LlmProviderConfigsRecord {
  configs: LlmProviderConfigRecord[];
}

export type LlmCompressionMethodKind = 'disabled' | 'openai_responses_compact' | 'llm_summary' | 'segmented_summary' | 'deterministic_summary' | 'manual_summary';
export type LlmCompressionTriggerMode = 'manual' | 'token_threshold';
export type LlmCompressionThresholdUnit = 'percent' | 'tokens';

export const DEFAULT_LLM_CONTEXT_WINDOW_TOKENS = 200_000;
export const DEFAULT_LLM_RETRY_ON_ERROR = true;
export const DEFAULT_LLM_RETRY_MAX_ATTEMPTS = 4;
/** 重试间隔秒数；0 表示沿用自动指数退避。 */
export const DEFAULT_LLM_RETRY_DELAY_SECONDS = 0;
/** 可配置重试间隔的上限秒数。 */
export const MAX_LLM_RETRY_DELAY_SECONDS = 600;
/** Reliable Runtime hard ceiling for automatic Provider retries (excluding the original attempt). */
export const MAX_RELIABLE_PROVIDER_RETRY_ATTEMPTS = 10;
export const DEFAULT_LLM_PROMPT_CACHE_ENABLED = true;
export const DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT = 90;
export const DEFAULT_LLM_COMPRESSION_MAX_DURATION_MINUTES = 20;
export const MAX_LLM_COMPRESSION_DURATION_MINUTES = 1_440;
/** Default decimal token target for the model-visible conversation body after text compaction. */
export const DEFAULT_LLM_COMPRESSION_BODY_TARGET_TOKENS = 48_000;
/** Smallest retained body a Conversation may be configured down to. */
export const MIN_LLM_COMPRESSION_BODY_TARGET_TOKENS = 1_000;
/**
 * Largest share of the room below the compression threshold that the retained body may claim.
 *
 * Compaction has to leave the Conversation meaningfully below its own trigger level. A retained
 * body sized at the whole remaining room lands back on the threshold as soon as the next Turn is
 * appended, so a configured target is capped at half of it.
 */
export const MAX_LLM_COMPRESSION_BODY_TARGET_ROOM_SHARE = 0.5;
/** Default and hard cap for the visible text produced by summary-based compaction. */
export const DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS = 8_000;
/** Default frozen output allowance when a compression Provider has no explicit maximum. */
export const DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS = 16_000;
export const DEFAULT_LLM_COMPRESSION_SUMMARY_SYSTEM_PROMPT = 'You have written a partial transcript for the initial task above. Please write a summary of the transcript. The purpose of this summary is to provide continuity so you can continue to make progress towards solving the task in a future context, where the raw history above may not be accessible and will be replaced with this summary. Write down anything that would be helpful, including the state, next steps, learnings etc. You must wrap your summary in a <summary></summary> block.';
export const DEFAULT_LLM_COMPRESSION_SUMMARY_USER_PROMPT = 'Transcript:';
export const DEFAULT_SEGMENTED_SUMMARY_SYSTEM_PROMPT = [
  '你正在对一段很长的对话做“分段”压缩。下面【本回合记录】是对话中的一个回合的完整记录',
  '(一个回合 = 从一条用户消息开始，到下一条用户消息之前为止，中间包含模型的思考、工具调用、工具结果和文字回复)。',
  '请把这个回合压缩成简洁但信息完整、可在未来上下文中替代原文使用的摘要。',
  '',
  '必须包含：',
  '- 本回合中用户的意图/请求',
  '- 模型采取的主要动作(调用了哪些工具、关键参数、返回的主要结果)',
  '- 得出的结论/决定/查明的事实',
  '- 回合结束时的状态与遗留任务/下一步',
  '',
  '规则：',
  '- 只总结本回合。“前情”仅用于保持连贯的只读参考，不要重新总结它。',
  '- 文件路径、函数名、标识符、数字等关键细节要按原文保留，不要编造。',
  '- 用户明确要求核对、记住或稍后复用的事实，以及工具结果中的对应键值，必须逐项写入摘要。',
  '- 不得用“读取了N个文件”“工具执行成功”等数量或状态概述替代这些具体事实。',
  '- 输出连贯的纯文本段落，不要使用 Markdown 标题(#)，以免与拼接时的分段标题冲突。',
  '- 必须把最终摘要用 <summary></summary> 标签包裹，标签外不要写其它内容。'
].join('\n');
export const DEFAULT_SEGMENTED_SUMMARY_USER_PROMPT = '请总结下面这个回合。';

export interface LlmCompressionSettingsRecord {
  defaultConfigId?: string;
  providerBindings: LlmCompressionProviderBindingRecord[];
  modelBindings: LlmCompressionModelBindingRecord[];
}

export interface LlmCompressionProviderBindingRecord {
  id: string;
  providerConfigId: string;
  compressionConfigId: string;
  role: 'default';
  createdAt: number;
  updatedAt: number;
}

export interface LlmCompressionModelBindingRecord {
  id: string;
  providerConfigId: string;
  modelId: string;
  compressionConfigId: string;
  role: 'model';
  createdAt: number;
  updatedAt: number;
}

export interface LlmCompressionConfigsRecord {
  configs: LlmCompressionConfigRecord[];
}

export interface LlmCompressionConfigRecord {
  id: string;
  name: string;
  kind: LlmCompressionMethodKind;
  maxDurationMinutes?: number;
  /** Token target for the conversation body text compaction retains; unset uses the default. */
  bodyTargetTokens?: number;
  trigger: {
    mode: LlmCompressionTriggerMode;
    thresholdTokens?: number;
    thresholdPercent?: number;
    thresholdUnit?: LlmCompressionThresholdUnit;
  };
  openaiResponsesCompact?: {
    providerConfigId?: string;
    model?: string;
  };
  llmSummary?: {
    providerConfigId?: string;
    model?: string;
    systemPrompt?: string;
    userPrompt?: string;
    targetTokens?: number;
    generationConfig?: LlmGenerationConfigRecord;
  };
  createdAt: number;
  updatedAt: number;
}

export function createDefaultLlmCompressionSettings(): LlmCompressionSettingsRecord {
  return { providerBindings: [], modelBindings: [] };
}

export function normalizeLlmCompressionBodyTargetTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LLM_COMPRESSION_BODY_TARGET_TOKENS;
  return Math.max(MIN_LLM_COMPRESSION_BODY_TARGET_TOKENS, Math.round(value));
}

export function normalizeLlmCompressionMaxDurationMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LLM_COMPRESSION_MAX_DURATION_MINUTES;
  return Math.min(MAX_LLM_COMPRESSION_DURATION_MINUTES, Math.max(1, Math.round(value)));
}

export function createDefaultLlmCompressionConfig(name = '默认压缩方法'): LlmCompressionConfigRecord {
  const now = Date.now();
  return {
    id: `llm-compression-config-${createMessageId()}`,
    name,
    kind: 'segmented_summary',
    maxDurationMinutes: DEFAULT_LLM_COMPRESSION_MAX_DURATION_MINUTES,
    bodyTargetTokens: DEFAULT_LLM_COMPRESSION_BODY_TARGET_TOKENS,
    trigger: {
      mode: 'token_threshold',
      thresholdUnit: 'percent',
      thresholdPercent: DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT
    },
    llmSummary: {
      targetTokens: DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS
    },
    createdAt: now,
    updatedAt: now
  };
}

export interface LlmProviderModelRecord {
  id: string;
  name: string;
  createdAt?: string;
}

export interface LlmPromptCacheConfigRecord {
  enabled: boolean;
  /** OpenAI Responses 可在缓存 Key 与显式断点之间选择；Claude 固定使用显式断点。 */
  mode: LlmPromptCacheMode;
  /** 缓存 TTL 档位：Claude 支持 5m / 1h；OpenAI Responses 的显式断点模式固定使用 30m。 */
  ttl: LlmPromptCacheTtl;
}

export function isPromptCacheSupportedProvider(provider: LlmProviderKind | undefined): boolean {
  return provider === 'openai-responses' || provider === 'claude';
}

export function defaultLlmPromptCacheTtlForProvider(provider: LlmProviderKind | undefined): LlmPromptCacheTtl {
  if (provider === 'openai-responses') return '30m';
  return '1h';
}

export function defaultLlmPromptCacheModeForProvider(provider: LlmProviderKind | undefined): LlmPromptCacheMode {
  return provider === 'openai-responses' ? 'key' : 'explicit';
}

export function createDefaultLlmPromptCacheConfig(provider: LlmProviderKind | undefined): LlmPromptCacheConfigRecord {
  return {
    enabled: DEFAULT_LLM_PROMPT_CACHE_ENABLED,
    mode: defaultLlmPromptCacheModeForProvider(provider),
    ttl: defaultLlmPromptCacheTtlForProvider(provider)
  };
}

export interface LlmProviderModelConfigRecord {
  id: string;
  /** 绑定当前渠道模型列表中的模型 ID。 */
  modelId: string;
  toolCallFormat: LlmToolCallFormat;
  openaiResponsesTransport: LlmOpenAIResponsesTransport;
  stream: boolean;
  /** 请求报错时是否自动重试。 */
  retryOnError: boolean;
  /** 最大重试次数，不包含原始请求；4 表示最多 1 + 4 次请求，-1 表示无限重试。 */
  retryMaxAttempts: number;
  /** 每次重试前固定等待的秒数；0 表示沿用自动指数退避。 */
  retryDelaySeconds: number;
  enableMultimodalTools: boolean;
  contextWindowTokens?: number;
  /** 不添加标题，直接放在本次请求最终系统提示词的最前面；空字符串表示不注入。 */
  systemPromptPrefix: string;
  promptCache?: LlmPromptCacheConfigRecord;
  headers?: LlmProviderHeadersRecord;
  generationConfig?: LlmGenerationConfigRecord;
  requestBody?: LlmRequestBodyRecord;
  /** Astra 原生能力配置；缺省表示跟随渠道级配置。 */
  nativeResponses?: OpenAIResponsesNativeSettings;
  createdAt: number;
  updatedAt: number;
}

export interface LlmProviderConfigRecord {
  id: string;
  name: string;
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
  models: LlmProviderModelRecord[];
  apiKey: string;
  toolCallFormat: LlmToolCallFormat;
  openaiResponsesTransport: LlmOpenAIResponsesTransport;
  stream: boolean;
  /** 请求报错时是否自动重试。 */
  retryOnError: boolean;
  /** 最大重试次数，不包含原始请求；4 表示最多 1 + 4 次请求，-1 表示无限重试。 */
  retryMaxAttempts: number;
  /** 每次重试前固定等待的秒数；0 表示沿用自动指数退避。 */
  retryDelaySeconds: number;
  enableMultimodalTools: boolean;
  contextWindowTokens?: number;
  /** 不添加标题，直接放在本次请求最终系统提示词的最前面；空字符串表示不注入。 */
  systemPromptPrefix: string;
  promptCache?: LlmPromptCacheConfigRecord;
  headers?: LlmProviderHeadersRecord;
  generationConfig?: LlmGenerationConfigRecord;
  requestBody?: LlmRequestBodyRecord;
  /**
   * Astra 原生能力配置（provider-scoped）。显式 enabled 同时表示确认该兼容渠道支持原生能力；
   * 仅对 openai-responses + 精确 Astra 模型生效。
   */
  nativeResponses?: OpenAIResponsesNativeSettings;
  /** 针对单个模型的完整高级配置；命中模型时整体替代渠道默认高级配置。 */
  modelConfigs: LlmProviderModelConfigRecord[];
  createdAt: number;
  updatedAt: number;
}

export type LlmInvocationStatus = 'resolving' | 'ready' | 'streaming' | 'complete' | 'error' | 'cancelled';
export type LlmInvocationRetryStatus = 'scheduled' | 'retrying' | 'cancelled' | 'recovered' | 'exhausted';
export type RunLlmInvocationRole = 'primary';
export type MessageLlmInvocationRole = 'modelOutput';
export type CompressionBlockLlmInvocationRole = 'compact';

export interface LlmInvocationSettingsSnapshotRecord {
  providerConfigId?: string;
  providerConfigName?: string;
  provider?: LlmProviderKind;
  baseUrl?: string;
  modelId?: string;
  modelName?: string;
  displayModelName?: string;
  toolCallFormat?: LlmToolCallFormat;
  openaiResponsesTransport?: LlmOpenAIResponsesTransport;
  stream?: boolean;
  retryOnError?: boolean;
  retryMaxAttempts?: number;
  retryDelaySeconds?: number;
  enableMultimodalTools?: boolean;
  contextWindowTokens?: number;
  /** 本次调用已经冻结的渠道或模型前置系统提示词。 */
  systemPromptPrefix?: string;
  promptCache?: LlmPromptCacheConfigRecord;
  generationConfig?: LlmGenerationConfigRecord;
  requestBody?: LlmRequestBodyRecord;
  /** 本次调用冻结的 Astra 原生能力配置（已按渠道/模型配置合并）。 */
  nativeResponses?: OpenAIResponsesNativeSettings;
  compressionConfigId?: string;
  compressionMethodKind?: LlmCompressionMethodKind;
  compressionTrigger?: LlmCompressionConfigRecord['trigger'];
  /** Immutable non-secret compression configuration used by this invocation. */
  compressionConfigSnapshot?: LlmCompressionConfigRecord;
  /** header 名保留；敏感值会被 mask，不持久化真实 secret。 */
  headers?: LlmProviderHeadersRecord;
}

export interface LlmRawErrorInfoRecord {
  kind?: string;
  status?: number;
  headers?: Record<string, unknown>;
  bodyText?: string;
  rawBody?: unknown;
  rawChunk?: unknown;
  rawResponse?: unknown;
  data?: unknown;
  message?: string;
  [key: string]: unknown;
}


export interface LlmInvocationRecord {
  id: string;
  requestId: string;
  status: LlmInvocationStatus;
  settings?: LlmInvocationSettingsSnapshotRecord;
  createdAt: number;
  resolvedAt?: number;
  startedAt?: number;
  completedAt?: number;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  error?: string;
  retryStatus?: LlmInvocationRetryStatus;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  retryDelayMs?: number;
  retryMessage?: string;
  retryRawError?: LlmRawErrorInfoRecord;
  retryUpdatedAt?: number;
}

export interface RunLlmInvocationLinkRecord {
  id: string;
  runId: string;
  invocationId: string;
  role: RunLlmInvocationRole;
  createdAt: number;
  updatedAt: number;
}

export interface MessageLlmInvocationLinkRecord {
  id: string;
  messageId: string;
  invocationId: string;
  role: MessageLlmInvocationRole;
  createdAt: number;
  updatedAt: number;
}

export interface CompressionBlockLlmInvocationLinkRecord {
  id: string;
  blockId: string;
  invocationId: string;
  role: CompressionBlockLlmInvocationRole;
  createdAt: number;
  updatedAt: number;
}


export type AgentSource = 'builtin' | 'user';
export type AgentRecordRuntimeRole = 'mirror';

export interface AgentRecord {
  id: string;
  name: string;
  description?: string;
  kind: string;
  source: AgentSource;
  status: 'idle' | 'thinking' | 'running' | 'done' | 'error';
  runtimeRole?: AgentRecordRuntimeRole;
  typeAgentId?: string;
}

export type TurnSummaryKind = 'chat' | 'tool_invoked' | 'delegated' | 'review' | 'notification' | 'scheduled';
export type TurnSummaryStatus = 'queued' | 'preparing' | 'running' | 'waiting_tool' | 'waiting_child_run' | 'delivering' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'stale' | 'interrupted';

export type AgentRunSourceKind = 'user' | 'toolCall' | 'agentRun' | 'schedule' | 'system';
export type ConversationOriginKind = 'user' | 'agent' | 'system';
export type AgentRunTargetRole = 'executor';
export type ToolCallRunRole = 'produced_by';
export type PolicyBindingRole = 'active';
export type ToolPolicyScopeKind = 'global' | 'conversation' | 'agent' | 'workflow' | 'run';
export type ConfigScopeKind = 'global' | 'conversation' | 'agent' | 'workflow' | 'run';
export type ConfigScopeBindingRole = 'active';

export type WorkflowSource = 'builtin' | 'user';
export type WorkflowIconKey = 'list-details';

export type PlanReviewMode = 'off' | 'before_mutation';
export type PlanReviewRequiredToolRiskLevel = 'write' | 'command' | 'agent';
export type PlanReviewPolicyScopeKind = ConfigScopeKind;
export type PlanProposalStatus = 'pending' | 'approved' | 'change_requested' | 'rejected' | 'cancelled';

export interface WorkflowRecord {
  id: string;
  name: string;
  description?: string;
  source: WorkflowSource;
  icon?: WorkflowIconKey;
  createdAt: number;
  updatedAt: number;
}

export interface PlanReviewPolicyRecord {
  id: string;
  mode: PlanReviewMode;
  allowReadonlyBeforeApproval: boolean;
  requireForToolRiskLevels: PlanReviewRequiredToolRiskLevel[];
  createdAt: number;
  updatedAt: number;
}

export interface PlanReviewPolicyScopeLinkRecord {
  id: string;
  scopeKind: PlanReviewPolicyScopeKind;
  scopeId?: string;
  planReviewPolicyId: string;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}

export interface PlanProposalRecord {
  id: string;
  body: string;
  taskList?: TaskListToolOperationRecord;
  status: PlanProposalStatus;
  createdAt: number;
  updatedAt: number;
}

export interface RunPlanProposalLinkRecord {
  id: string;
  runId: string;
  planProposalId: string;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}

export type ConversationWorkflowScopeKind = 'global' | 'workflow';
export type ConversationWorkflowSelectionRole = 'active';

export interface ToolDisplayPolicyRecord {
  /** true 时前端默认展开该工具调用的内容面板；false/未设置则默认收起。 */
  autoExpand?: boolean;
  /** true 时前端在“查看差异”按钮可用后自动打开 VS Code diff 预览。 */
  autoOpenDiffPreview?: boolean;
}

export interface ToolChangeApplyPolicyRecord {
  /** true 时后端策略 actor 会在持久 deadline 到期后自动解决请求；前端只展示倒计时。 */
  autoApply?: boolean;
  /** 0 表示服务端立即调度；大于 0 表示持久 grace window 的秒数。 */
  autoApplyDelaySeconds?: number;
}

export type ToolPolicyPresetKind = 'inherit' | 'custom' | 'yolo';

export interface ToolPolicyToolConfigRecord {
  /** 是否自动批准工具进入执行阶段。关闭时会先等待用户批准执行。 */
  autoApproveExecution?: boolean;
  /**
   * 是否自动应用工具生成的可预览更改。
   * 仅对“执行阶段只生成更改提案、应用阶段才产生副作用”的工具有意义；
   * 对 read、shell、switch_work_environment 等无更改提案或立即副作用工具无影响。
   */
  autoApplyChange?: boolean;
  /** 0 表示直接应用；未设置时使用工具定义默认值。 */
  autoApplyChangeDelaySeconds?: number;
  /**
   * 是否自动把工具结果提交给 AI，作为后续模型上下文的一部分。
   * 关闭时工具执行/更改应用完成后会等待用户确认结果回传；
   * 用户拒绝时仍会向 AI 回传“用户拒绝使用该结果”的工具响应，避免 AgentRun 永久等待。
   */
  autoSubmitResult?: boolean;
  /** 是否在 Astra 原生通道允许该工具异步准入（output_item.done 即持久化准入、结果延迟投递）；缺省/false = 同步。 */
  nativeAsync?: boolean;
  display?: ToolDisplayPolicyRecord;
  config: ToolConfigRecord;
}

export interface ToolPolicySourceConfigRecord {
  enabled: boolean;
  disabledTools?: string[];
}

export interface ToolPolicyRecord {
  id: string;
  name: string;
  allowedTools: string[];
  /** 工具策略预设；非全局 scope 可用 inherit 只继承全局预设，同时保留本 scope 的逐工具配置。 */
  preset?: ToolPolicyPresetKind;
  toolConfigs?: Record<string, ToolPolicyToolConfigRecord>;
  sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>;
}

export interface ToolPolicyScopeLinkRecord {
  id: string;
  scopeKind: ToolPolicyScopeKind;
  /** global scope 无 scopeId；其余 scope 使用对应领域对象 id。 */
  scopeId?: string;
  toolPolicyId: string;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}

/** 技能来源：agents=项目 .agents/skills/；claude=项目 .claude/skills/；global=数据根 skills/。三者相互独立，同名 slug 可共存。 */
export type SkillSource = 'agents' | 'claude' | 'global';
/** 技能策略作用域，与 ToolPolicyScopeKind 保持一致，便于不同 scope 复用配置。 */
export type SkillPolicyScopeKind = ToolPolicyScopeKind;

/** 磁盘扫描出的技能定义。不落 record-store，来自 SkillCatalog 资源投影，类似 ToolDefinitionRecord。 */
export interface SkillDefinitionRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  dir: string;
  workspaceFolderUri?: string;
}

/** 单个来源分组的技能开关配置：组总开关 + 组内被停用技能 id。 */
export interface SkillPolicySourceConfigRecord {
  enabled: boolean;
  disabledSkills?: string[];
}

export interface SkillPolicyRecord {
  id: string;
  name: string;
  sourceConfigs?: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>>;
}

export interface SkillPolicyScopeLinkRecord {
  id: string;
  scopeKind: SkillPolicyScopeKind;
  /** global scope 无 scopeId；其余 scope 使用对应领域对象 id。 */
  scopeId?: string;
  skillPolicyId: string;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}

/** 规则来源：project=项目根 AGENTS.md/CLAUDE.md；global=数据根 AGENTS.md/CLAUDE.md。 */
export type RuleScope = 'project' | 'global';
/** 规则文件类型：AGENTS 为我们维护（可读写）的主文件；CLAUDE 仅作兼容只读读取。 */
export type RuleKind = 'AGENTS' | 'CLAUDE';

/**
 * 磁盘扫描出的规则文件。不落 record-store，来自 RulesCatalog 资源投影。
 * 其正文在对话开始时冻结进 runtime 上下文快照，注入所有 agent 的提示词。
 */
export interface RuleFileRecord {
  id: string;
  scope: RuleScope;
  kind: RuleKind;
  /** AGENTS=true（可编辑保存）；CLAUDE=false（只读预览）。 */
  editable: boolean;
  /** 目标文件绝对 fsPath；即使文件不存在也给出，便于保存时创建。 */
  path: string;
  exists: boolean;
  /** 文件正文；不存在时为空串。 */
  content: string;
  /** project 作用域对应的 workspace folder uri，global 作用域无。 */
  workspaceFolderUri?: string;
}

export interface SystemPromptRecord {
  id: string;
  name: string;
  text: string;
}

export interface SystemPromptScopeLinkRecord {
  id: string;
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  systemPromptId: string;
  role: ConfigScopeBindingRole;
  order?: number;
  createdAt: number;
  updatedAt: number;
}

export type PromptPlaceholderTarget = 'systemPrompt' | 'runtimeContext';

export interface PromptPlaceholderRecord {
  id: string;
  token: string;
  label: string;
  description?: string;
  target: PromptPlaceholderTarget;
  order?: number;
}

export interface RuntimeContextRecord {
  id: string;
  name: string;
  template: string;
}

export interface RuntimeContextScopeLinkRecord {
  id: string;
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  runtimeContextId: string;
  role: ConfigScopeBindingRole;
  order?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeContextSnapshotRecord {
  id: string;
  name: string;
  text: string;
  template: string;
  conversationId?: string;
  sourceRuntimeContextIds?: string[];
  sourceHash?: string;
  createdAt: number;
  updatedAt: number;
  refreshedAt: number;
}

export interface ConversationRuntimeContextSnapshotLinkRecord {
  id: string;
  conversationId: string;
  runtimeContextSnapshotId: string;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}

export interface RunRuntimeContextSnapshotLinkRecord {
  id: string;
  runId: string;
  runtimeContextSnapshotId: string;
  role: 'context';
  createdAt: number;
  updatedAt: number;
}

export interface ModelProfileRecord {
  id: string;
  name: string;
  providerConfigId?: string;
  provider?: LlmProviderKind;
  model: string;
}

export interface ModelProfileScopeLinkRecord {
  id: string;
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  modelProfileId: string;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationWorkflowSelectionRecord {
  id: string;
  conversationId: string;
  scopeKind: ConversationWorkflowScopeKind;
  workflowId?: string;
  role: ConversationWorkflowSelectionRole;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRecord {
  id: string;
  title?: string;
  visibility?: 'visible' | 'hidden' | 'collapsed';
  createdAt: number;
  lastActivityAt: number;
}

export interface ConversationReuseLinkRecord {
  id: string;
  key: string;
  conversationId: string;
  agentId?: string;
}

export type ConversationBranchKind = 'fork' | 'branch_from_revision';

export interface ConversationBranchLinkRecord {
  id: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceRevisionId?: string;
  kind: ConversationBranchKind;
}


export interface ConversationOriginLinkRecord {
  id: string;
  conversationId: string;
  originKind: ConversationOriginKind;
  sourceKind?: AgentRunSourceKind;
  sourceAgentId?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  sourceToolCallId?: string;
  sourceRunId?: string;
  createdAt: number;
  updatedAt: number;
}


export type AgentConversationRole = 'default' | 'participant' | 'reviewer';

export type ProjectContextKind = 'folder';
export type BuiltinWorkEnvironmentKind = 'localFolder' | 'remoteServer';
export type WorkEnvironmentKind = BuiltinWorkEnvironmentKind | (string & {});
export type WorkEnvironmentSource = 'workspaceFolder' | 'vscodeSshConfig' | 'manual' | (string & {});
export type WorkEnvironmentOs = 'linux' | 'windows' | 'macos' | 'unknown' | string;
export type WorkEnvironmentCapabilityKind = 'localFileRead' | 'localCommand' | 'remoteFileRead' | 'remoteCommand' | 'containerFileRead' | 'containerCommand' | 'fileTransferRead' | 'fileTransferWrite' | (string & {});
export type WorkEnvironmentPolicyScopeKind = 'global' | 'conversation' | 'agent' | 'workflow' | 'run';

export interface ProjectContextRecord {
  id: string;
  kind: ProjectContextKind;
  uri: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export type ConversationProjectRole = 'primary';

export interface ConversationProjectLinkRecord {
  id: string;
  conversationId: string;
  projectContextId: string;
  role: ConversationProjectRole;
  createdAt: number;
  updatedAt: number;
}

export interface WorkEnvironmentRecord {
  id: string;
  kind: WorkEnvironmentKind;
  name: string;
  /** 本地 folder 使用 VS Code uri；未来远程环境可使用自定义 uri。 */
  uri?: string;
  /** 本地 folder 的可执行根目录；未来远程环境可映射为远程根路径。 */
  rootPath?: string;
  /** 面向 UI / LLM 展示的路径或地址。 */
  displayPath?: string;
  source?: WorkEnvironmentSource;
  /** 环境类型声明的能力；不填时由 kind 的定义提供默认能力。 */
  capabilities?: WorkEnvironmentCapabilityKind[];
  /** provider 专属的非敏感扩展信息，例如未来 Docker container/workspace 映射等。 */
  metadata?: Record<string, unknown>;
  /** SSH Config: Host。 */
  host?: string;
  /** SSH Config: Port，默认 22。 */
  port?: number;
  /** SSH Config: User。 */
  user?: string;
  /** SSH Config: IdentityFile。 */
  identityFile?: string;
  /** 可选明文密码；不会注入 LLM 上下文。 */
  password?: string;
  /** 远端默认工作目录。 */
  workdir?: string;
  os?: WorkEnvironmentOs;
  description?: string;
  /** VS Code workspace folder 顺序；远程环境可不填。 */
  index?: number;
  available: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkEnvironmentPolicyRecord {
  id: string;
  name: string;
  enabled: boolean;
  allowedWorkEnvironmentIds: string[];
  defaultWorkEnvironmentId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkEnvironmentPolicyScopeLinkRecord {
  id: string;
  scopeKind: WorkEnvironmentPolicyScopeKind;
  scopeId?: string;
  workEnvironmentPolicyId: string;
  role: WorkEnvironmentLinkRole;
  createdAt: number;
  updatedAt: number;
}

export type WorkEnvironmentLinkRole = 'active';

export interface ConversationWorkEnvironmentLinkRecord {
  id: string;
  conversationId: string;
  workEnvironmentId: string;
  role: WorkEnvironmentLinkRole;
  createdAt: number;
  updatedAt: number;
}

export interface RunWorkEnvironmentLinkRecord {
  id: string;
  runId: string;
  workEnvironmentId: string;
  role: WorkEnvironmentLinkRole;
  createdAt: number;
  updatedAt: number;
}

export type CheckpointPolicyScopeKind = ConfigScopeKind;
export type CheckpointRepositoryLinkRole = 'active' | 'history';
export type CheckpointStatus = 'pending' | 'created' | 'skipped' | 'failed';
export type CheckpointSkipReason =
  | 'disabled'
  | 'trigger_disabled'
  | 'no_project'
  | 'workspace_not_containing_project'
  | 'initial_size_exceeded'
  | 'no_changes'
  | 'git_unavailable'
  | 'unsupported_project_uri'
  | 'io_error';
export type CheckpointTriggerKind =
  | 'conversation_initial'
  | 'user_message_before'
  | 'user_message_after'
  | 'llm_response_before'
  | 'llm_response_after'
  | 'tool_execution_before'
  | 'tool_execution_after'
  | 'agent_run_completed_before'
  | 'agent_run_completed_after'
  | 'manual';

export interface CheckpointTriggerConfigRecord {
  conversationInitial: boolean;
  userMessageBefore: boolean;
  userMessageAfter: boolean;
  llmResponseBefore: boolean;
  llmResponseAfter: boolean;
  agentRunCompletedBefore: boolean;
  agentRunCompletedAfter: boolean;
  manual: boolean;
}

export interface CheckpointToolTriggerConfigRecord {
  before: boolean;
  after: boolean;
}

export interface CheckpointPolicyRecord {
  id: string;
  name: string;
  enabled: boolean;
  initialSnapshotMaxBytes: number;
  preserveEmptyDirectories: boolean;
  useGitignore: boolean;
  skipPatterns: string[];
  triggers: CheckpointTriggerConfigRecord;
  toolTriggers: Record<string, CheckpointToolTriggerConfigRecord>;
  createdAt: number;
  updatedAt: number;
}

export interface CheckpointGitStatusRecord {
  available: boolean;
  checkedAt: number;
  version?: string;
  message?: string;
}

export interface CheckpointGitStatusSnapshotPayload { status: CheckpointGitStatusRecord }

export interface ShadowRepositoryDiskStatRecord {
  storageKey: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  lastActiveAt?: number;
}

export interface CheckpointShadowStatsSnapshotPayload { stats: ShadowRepositoryDiskStatRecord[] }

export interface CheckpointShadowDeletePayload { storageKeys: string[] }

export interface CheckpointDismissPayload { checkpointId: string; conversationId: string }

export interface CheckpointRestorePayload {
  checkpointId: string;
  conversationId: string;
  shadowRepositoryStorageKey: string;
  commitSha: string;
  projectUri: string;
  policy: CheckpointPolicyRecord;
}

export interface ShadowCheckpointRestoreResult {
  status: 'restored' | 'failed';
  message: string;
  restoredFileCount?: number;
  removedFileCount?: number;
}

export interface CheckpointRestoreResultPayload {
  checkpointId: string;
  conversationId: string;
  result: ShadowCheckpointRestoreResult;
}

export interface CheckpointDiffOpenPayload {
  conversationId: string;
  checkpointId: string;
  filePath: string;
}

export interface CheckpointDiffOpenResultPayload {
  conversationId: string;
  checkpointId: string;
  filePath: string;
  status: 'opened' | 'failed';
  message: string;
}

export interface CheckpointPolicyScopeLinkRecord {
  id: string;
  scopeKind: CheckpointPolicyScopeKind;
  scopeId?: string;
  checkpointPolicyId: string;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}

export interface ShadowRepositoryRecord {
  id: string;
  storageKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationCheckpointRepositoryLinkRecord {
  id: string;
  conversationId: string;
  projectContextId: string;
  shadowRepositoryId: string;
  projectUri: string;
  projectDisplayPath: string;
  role: CheckpointRepositoryLinkRole;
  createdAt: number;
  updatedAt: number;
}

export interface CheckpointRecord {
  id: string;
  conversationId: string;
  projectContextId: string;
  shadowRepositoryId: string;
  trigger: CheckpointTriggerKind;
  status: CheckpointStatus;
  projectUri: string;
  projectDisplayPath: string;
  createdAt: number;
  updatedAt: number;
  commitSha?: string;
  skipReason?: CheckpointSkipReason;
  message?: string;
  fileCount?: number;
  byteCount?: number;
  emptyDirectoryCount?: number;
}

export type CheckpointFloorAnchorPosition = 'before' | 'after';

export interface CheckpointTimelineAnchorRecord {
  id: string;
  conversationId: string;
  checkpointId: string;
  floorMessageId: string;
  position: CheckpointFloorAnchorPosition;
  order: number;
  sourceRunId?: string;
  sourceToolCallId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConversationLinkRecord {
  id: string;
  agentId: string;
  conversationId: string;
  role: AgentConversationRole;
}

export type ConversationAgentSelectionRole = 'active';

export interface ConversationAgentSelectionRecord {
  id: string;
  conversationId: string;
  agentId: string;
  role: ConversationAgentSelectionRole;
  createdAt: number;
  updatedAt: number;
}

export type ContentRole = MsgRole;

/** OpenAI Responses 可显式区分工具前说明与最终答复；其他 provider 可不提供。 */
export type AssistantMessagePhase = 'commentary' | 'final_answer';

/**
 * 一次模型输出中独立 output item 的稳定引用。
 * `id` 是本次响应内稳定的展示/合并键，`ordinal` 表示 provider 输出顺序。
 */
export interface ModelOutputItemReference {
  id: string;
  ordinal: number;
  phase?: AssistantMessagePhase;
  /** 原生链上该 item 所属 response；自动后继/转向边界按此切分，绝不跨边界静默拼接。 */
  providerResponseId?: string;
  /** 该 response 的 previous_response_id（链上首个 response 缺省）。 */
  previousResponseId?: string;
}

export interface ModelOutputPartMetadata {
  outputItem?: ModelOutputItemReference;
}

export interface TextPart extends ModelOutputPartMetadata {
  text: string;
  thought?: boolean;
  thoughtSignature?: string;
  /** 当前活动思考块的权威开始时间；只用于本地显示插值，不替代最终耗时。 */
  thoughtStartedAt?: number;
  /** 当前活动块之前已经完成的思考块累计耗时。 */
  thoughtCompletedDurationMs?: number;
  /** 当前思考块仍在流式输出时，由后端低频校准的块内耗时。 */
  thoughtElapsedMs?: number;
  /** 所有思考块完成后的权威累计耗时。 */
  thoughtDurationMs?: number;
}

export interface FunctionCallPart extends ModelOutputPartMetadata {
  id?: string;
  functionCall: {
    name: string;
    args: unknown;
  };
  thoughtSignature?: string;
  /**
   * Astra 原生异步调用标记：声明或接收到 async:true 时保留，双向无损传播。
   * 仅为合法性的历史证据；当前请求是否允许 pending 由目标 capability 与持久化准入共同决定。
   */
  async?: boolean;
}

export interface FunctionResponsePart extends ModelOutputPartMetadata {
  id?: string;
  functionResponse: {
    name: string;
    response: unknown;
    parts?: InlineDataPart[];
  };
  durationMs?: number;
}

export type AttachmentStorageMode = 'embedded' | 'managed' | 'localPath';
export type AttachmentAvailabilityStatus = 'available' | 'loading' | 'missing' | 'tooLarge' | 'unsupported' | 'failed';

export interface AttachmentRecord {
  id: string;
  mimeType: string;
  name?: string;
  sizeBytes: number;
  base64Bytes: number;
  sha256: string;
  blobFile: string;
  createdAt: number;
  updatedAt: number;
}

export interface AttachmentCatalogEntry {
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface InlineDataPart extends ModelOutputPartMetadata {
  inlineData: {
    mimeType: string;
    /** 运行时可用的纯 base64；持久化时小附件会外置到 attachments/blobs。 */
    data?: string;
    /** 原始文件名；OpenAI Responses input_file 会作为 filename 发送。 */
    name?: string;
    /** 托管附件 id，指向 <dataRoot>/attachments。 */
    attachmentId?: string;
    /** 托管附件原始字节的完整 SHA-256；durable managed 引用必须携带。 */
    sha256?: string;
    /** 超过托管阈值或用户选择本地引用时的源文件绝对路径。 */
    sourcePath?: string;
    storage?: AttachmentStorageMode;
    status?: AttachmentAvailabilityStatus;
    error?: string;
    sizeBytes?: number;
  };
}

export interface FileDataPart extends ModelOutputPartMetadata {
  fileData: { mimeType?: string; uri: string };
}

export interface ProviderContextPart extends ModelOutputPartMetadata {
  providerContext: {
    provider: string;
    format: string;
    endpoint?: string;
    itemType?: string;
    encryptedContent?: string;
    rawItem?: unknown;
  };
}

export type ContentPart = TextPart | FunctionCallPart | FunctionResponsePart | InlineDataPart | FileDataPart | ProviderContextPart;

export function isTextPart(part: ContentPart): part is TextPart { return 'text' in part; }
export function isVisibleTextPart(part: ContentPart): part is TextPart { return isTextPart(part) && part.thought !== true; }
export function isFunctionCallPart(part: ContentPart): part is FunctionCallPart { return 'functionCall' in part; }
export function isFunctionResponsePart(part: ContentPart): part is FunctionResponsePart { return 'functionResponse' in part; }
export function isInlineDataPart(part: ContentPart): part is InlineDataPart { return 'inlineData' in part; }
export function isFileDataPart(part: ContentPart): part is FileDataPart { return 'fileData' in part; }
export function isProviderContextPart(part: ContentPart): part is ProviderContextPart { return 'providerContext' in part; }

export interface MessageContent {
  role: ContentRole;
  parts: ContentPart[];
}

export function textContent(role: ContentRole, text: string): MessageContent {
  return { role, parts: text ? [{ text }] : [] };
}

export type MessagePresentation = 'visible' | 'internal';

export interface MessageRecord {
  id: string;
  /** Immutable revision observed when an edit interaction begins. */
  revisionId?: string;
  conversationId: string;
  role: MsgRole;
  model?: string;
  /** Whether this message is part of the user-facing transcript or model-only control context. */
  presentation?: MessagePresentation;
  content: MessageContent;
  status: MessageMaterializationStatus;
  createdAt: number;
  requestStartedAt?: number;
  firstChunkAt?: number;
  completedAt?: number;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  /** Exact Runtime fact used when the user retries this projected model output. */
  retryTarget?: MessageRetryTarget;
  seq: number;
}

export type MessageRevisionReason = 'created' | 'edited' | 'regenerated' | 'system';

export interface MessageRevisionRecord {
  id: string;
  messageId: string;
  conversationId: string;
  content: MessageContent;
  createdAt: number;
  reason: MessageRevisionReason;
}

export interface MessageCurrentRevisionLinkRecord {
  id: string;
  messageId: string;
  revisionId: string;
}

export interface ToolCallRecord {
  id: string;
  messageId: string;
  name: string;
  functionCallId?: string;
  args: string;
  summary?: string;
  status: ToolCallStatus;
  /** Canonical durable attachment references returned by the tool; bytes are materialized only at provider/UI boundaries. */
  responseParts?: InlineDataPart[];
  error?: string;
  progress?: unknown;
  /** Stable zero-based order within the model message's tool-call batch. */
  schedulingOrdinal?: number;
  schedulingMode?: ToolSchedulingMode;
  schedulingReason?: string;
  display?: ToolDisplayPolicyRecord;
  changeApply?: ToolChangeApplyPolicyRecord;
  durationMs?: number;
  createdAt: number;
  updatedAt: number;
}

/** Process-local preview of one function call while its JSON arguments are still arriving. */
export interface ToolCallPreviewRecord {
  id: string;
  callId: string;
  name?: string;
  streamIndex?: string;
  /** Complete arguments received for the current stream epoch. */
  argumentsText: string;
  receivedChars: number;
  /**
   * Incrementally decoded fields used by the streaming presentation. Their presence means the
   * producer has already scanned the argument prefix; consumers must not rescan it from byte zero.
   */
  argumentPreviewFields?: Partial<Record<
    'path' | 'title' | 'content' | 'plan' | 'command' | 'explanation' | 'oldContent' | 'newContent',
    { value: string; closed: boolean }
  >>;
  createdAt: number;
  updatedAt: number;
}

/** Independent transient relationship from a preview to its request/message/conversation. */
export interface ToolCallPreviewTargetLinkRecord {
  id: string;
  previewId: string;
  requestId: string;
  messageId: string;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
}

export type ToolResultArtifactStorageKind = 'inline' | 'blob';

/** Blob-first result admission output before a conversation transaction publishes Artifact identity. */
export interface StagedToolResultContent {
  contentHash: string;
  mediaType: 'application/json';
  byteLength: number;
  storageKind: ToolResultArtifactStorageKind;
  inlineContent?: JsonValue;
  blobHash?: string;
  /** Bounded UTF-8 preview for list/card rendering; never authoritative full content. */
  preview: string;
}

/** Canonical owner of one tool result. Large payload bytes live only in the content-addressed blob. */
export interface ToolResultArtifactRecord extends StagedToolResultContent {
  id: string;
  conversationId: string;
  /** Backend-only modelResponse is deliberately excluded from ClientState; UI loads full blobs lazily. */
  createdAt: number;
}

/** Independent relationship between a ToolCall and one immutable result Artifact. */
export interface ToolCallResultLinkRecord {
  id: string;
  conversationId: string;
  toolCallId: string;
  artifactId: string;
  role: 'final' | 'partial' | 'audit';
  createdAt: number;
  updatedAt: number;
}

export type ToolCallEventKind =
  | 'created'
  | 'queued'
  | 'started'
  | 'progress'
  | 'stdout'
  | 'stderr'
  | 'state'
  | 'completed'
  | 'failed';

export interface ToolCallEventRecord {
  id: string;
  toolCallId: string;
  seq: number;
  kind: ToolCallEventKind;
  at: number;
  status?: ToolCallStatus;
  elapsedMs?: number;
  durationMs?: number;
  delta?: string;
  payload?: unknown;
  error?: string;
}

export type ConversationPolicyMode = 'same_conversation' | 'new_conversation' | 'reuse_conversation' | 'fork_conversation' | 'branch_from_revision';
export type ConversationVisibility = 'visible' | 'hidden' | 'collapsed';
export type ContextHistoryMode = 'none' | 'full' | 'last_n' | 'since_message' | 'selected_messages' | 'summary';
export type DeliveryMode = 'direct_reply' | 'tool_response' | 'notification' | 'append_to_source_conversation' | 'silent';
export type TranscriptInclusion = 'none' | 'summary' | 'selected' | 'full' | 'link';
export type SourceEditBehavior = 'ignore_snapshot' | 'abort_and_restart' | 'append_correction' | 'branch_new_run' | 'mark_stale';
export type NewMessageWhileRunningBehavior = 'queue_next_run' | 'interrupt_current' | 'append_to_target' | 'ignore';

export interface RunConversationPolicyRecord {
  id: string;
  mode: ConversationPolicyMode;
  conversationId?: string;
  reuseKey?: string;
  branchFromConversationId?: string;
  branchFromRevisionId?: string;
  visibility: ConversationVisibility;
}

export interface RunContextPolicyRecord {
  id: string;
  historyMode: ContextHistoryMode;
  lastN?: number;
  sinceMessageId?: string;
  selectedMessageIds?: string[];
  includeSourceContext?: boolean;
  includeSourceToolResult?: boolean;
}

export interface RunDeliveryPolicyRecord {
  id: string;
  mode: DeliveryMode;
  includeTranscript: TranscriptInclusion;
  targetConversationId?: string;
  targetToolCallId?: string;
}

export interface RunEditPolicyRecord {
  id: string;
  onSourceEdited: SourceEditBehavior;
  onNewUserMessageWhileRunning: NewMessageWhileRunningBehavior;
}

export interface OutcomeUnknownOperationRecord {
  operationId: string;
  reason: 'outcome_unknown';
  allowedResolutions: Array<'restart_proved_not_executed' | 'submit_verified_result' | 'abandon'>;
  createdAt: number;
}

export const RUN_TERMINATION_KINDS = ['cancelled', 'stale', 'interrupted', 'failed'] as const;
export type RunTerminationKind = typeof RUN_TERMINATION_KINDS[number];

export const RUN_TERMINATION_ACTORS = ['user', 'system', 'provider', 'tool', 'parent_run'] as const;
export type RunTerminationActor = typeof RUN_TERMINATION_ACTORS[number];

export const RUN_TERMINATION_REASON_CODES = [
  'user_cancelled',
  'run_promoted',
  'removed_from_queue',
  'conversation_deleted',
  'message_deleted',
  'source_revision_edited',
  'retry_requested',
  'regenerate_requested',
  'answer_bridge_continued',
  'agent_interrupt_requested',
  'parent_run_terminated',
  'callback_rejected',
  'operation_timed_out',
  'extension_host_restarted',
  'parent_outcome_unknown',
  'unknown_outcome_abandoned',
  'invocation_failed',
  'llm_request_failed',
  'empty_model_result'
] as const;
export type RunTerminationReasonCode = typeof RUN_TERMINATION_REASON_CODES[number];

export interface RunTerminationRecord {
  id: string;
  runId: string;
  kind: RunTerminationKind;
  actor: RunTerminationActor;
  /** Run.phase immediately before the terminal transition. */
  interruptedPhase: Exclude<TurnExecutionPhase, 'terminal'>;
  reasonCode: RunTerminationReasonCode;
  /** Exact reliable-runtime termination detail for user-visible diagnostics. */
  detail?: string;
  /** Present when another Run caused this Run to terminate. */
  triggerRunId?: string;
  createdAt: number;
}

export function isRunTerminationKind(value: unknown): value is RunTerminationKind {
  return typeof value === 'string' && (RUN_TERMINATION_KINDS as readonly string[]).includes(value);
}

export function isRunTerminationActor(value: unknown): value is RunTerminationActor {
  return typeof value === 'string' && (RUN_TERMINATION_ACTORS as readonly string[]).includes(value);
}

export function isRunTerminationReasonCode(value: unknown): value is RunTerminationReasonCode {
  return typeof value === 'string' && (RUN_TERMINATION_REASON_CODES as readonly string[]).includes(value);
}

export interface TurnSummaryRecord {
  id: string;
  kind: TurnSummaryKind;
  status: TurnSummaryStatus;
  lifecycle?: TurnLifecycleStatus;
  phase?: TurnExecutionPhase;
  rowVersion?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  retryOfRunId?: string;
  attempt?: number;
  outcomeUnknownOperations?: OutcomeUnknownOperationRecord[];
}

export interface AgentRunSourceLinkRecord {
  id: string;
  runId: string;
  sourceKind: AgentRunSourceKind;
  sourceAgentId?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  sourceToolCallId?: string;
  sourceRunId?: string;
  answerBridgeId?: string;
}

export interface AgentRunTargetLinkRecord {
  id: string;
  runId: string;
  agentId: string;
  conversationId: string;
  role: AgentRunTargetRole;
}

export interface ToolCallRunLinkRecord {
  id: string;
  toolCallId: string;
  runId: string;
  role: ToolCallRunRole;
}

export interface RunWorkflowLinkRecord {
  id: string;
  runId: string;
  workflowId: string;
  role: PolicyBindingRole;
}

export interface RunSystemPromptLinkRecord {
  id: string;
  runId: string;
  systemPromptId: string;
  role: PolicyBindingRole;
}

export interface RunModelProfileLinkRecord {
  id: string;
  runId: string;
  modelProfileId: string;
  role: PolicyBindingRole;
}

export interface RunToolPolicyLinkRecord {
  id: string;
  runId: string;
  toolPolicyId: string;
  role: PolicyBindingRole;
}

export interface RunConversationPolicyLinkRecord {
  id: string;
  runId: string;
  policyId: string;
  role: PolicyBindingRole;
}

export interface RunContextPolicyLinkRecord {
  id: string;
  runId: string;
  policyId: string;
  role: PolicyBindingRole;
}

export interface RunDeliveryPolicyLinkRecord {
  id: string;
  runId: string;
  policyId: string;
  role: PolicyBindingRole;
}

export interface RunEditPolicyLinkRecord {
  id: string;
  runId: string;
  policyId: string;
  role: PolicyBindingRole;
}

export interface AgentRunInputRevisionRecord {
  id: string;
  runId: string;
  conversationId: string;
  revisionId: string;
}

export interface AgentAnswerRecord {
  id: string;
  /** Stable immutable submission identity materialized by the file-schema migration. */
  submissionId?: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentAnswerSubmissionLinkRecord {
  id: string;
  answerId: string;
  submitterRunId?: string;
  submitterAgentId?: string;
  submitterConversationId?: string;
  submitterToolCallId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentAnswerTargetLinkRecord {
  id: string;
  answerId: string;
  targetRunId?: string;
  targetAgentId?: string;
  targetConversationId?: string;
  sourceToolCallId?: string;
  createdAt: number;
  updatedAt: number;
}

export type CompressionBlockStatus = 'pending' | 'running' | 'complete' | 'error' | 'stale' | 'disabled';
export type CompressionBlockSourceKind = 'message' | 'compressionBlock';
export type CompressionBlockSourceRole = 'source' | 'retained' | 'anchor';
export type CompressionContextVariantKind = 'provider_native' | 'provider_neutral_summary';
export type CompressionContextUseMode = 'provider_native' | 'summary_fallback' | 'raw_history_fallback';

export type ModelContextProjectionPurposeKind = 'turn' | 'compression';
export type ModelContextProjectionMode = 'fresh' | 'same_run_resume' | 'dry_run' | 'auto' | 'manual';
export type ModelContextProjectionSourceKind = 'messageRevision' | 'compressionVariant' | 'runTermination' | 'toolCall' | 'runtimeContextSnapshot';

export interface ModelContextProjectionRecord {
  id: string;
  conversationId: string;
  purposeKind: ModelContextProjectionPurposeKind;
  mode: ModelContextProjectionMode;
  contents: MessageContent[];
  fingerprint: string;
  tokenCount: number;
  modelMessageId?: string;
  runId?: string;
  /** Exact method-specific compression inputs retained for replay/dry-run. */
  segments?: MessageContent[][];
  priorSummaryContents?: MessageContent[];
  /** Deterministic content appended after provider compaction (for example a task-list snapshot). */
  resultAddenda?: MessageContent[];
  diagnostics: Array<{ code: string; severity: 'info' | 'warning' | 'error'; sourceId?: string }>;
  createdAt: number;
}

export interface ModelContextProjectionSourceLinkRecord {
  id: string;
  /** Storage owner of this relation and its ModelContextProjection. */
  conversationId: string;
  /** Domain owner of the referenced source fact; may differ for source-conversation context. */
  sourceConversationId: string;
  projectionId: string;
  sourceKind: ModelContextProjectionSourceKind;
  sourceId: string;
  /** Hash of the exact immutable source fact consumed by this projection. */
  fingerprint: string;
  order: number;
  messageId?: string;
  revisionId?: string;
  blockId?: string;
  runId?: string;
  seq?: number;
}

export interface RequestModelContextProjectionLinkRecord {
  id: string;
  requestId: string;
  projectionId: string;
  role: 'input';
  createdAt: number;
}

export interface CompressionModelContextProjectionLinkRecord {
  id: string;
  blockId: string;
  projectionId: string;
  role: 'source';
  createdAt: number;
}

export interface CompressionBlockRecord {
  id: string;
  conversationId: string;
  title: string;
  status: CompressionBlockStatus;
  trigger?: 'manual' | 'auto';
  methodKind: LlmCompressionMethodKind;
  methodConfigId?: string;
  anchorMessageId?: string;
  anchorSeq?: number;
  startSeq?: number;
  endSeq?: number;
  sourceMessageCount?: number;
  summaryPreview?: string;
  tokenCountBefore?: number;
  tokenCountAfter?: number;
  tokenSaved?: number;
  sourceHash?: string;
  /** Immutable execution snapshots used for exact compact replay/dry-run. */
  providerSettingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
  compressionConfigSnapshot?: LlmCompressionConfigRecord;
  staleReason?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CompressionBlockSourceLinkRecord {
  id: string;
  blockId: string;
  sourceKind: CompressionBlockSourceKind;
  sourceId: string;
  revisionId?: string;
  role: CompressionBlockSourceRole;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface CompressionContextVariantRecord {
  id: string;
  blockId: string;
  kind: CompressionContextVariantKind;
  contents: MessageContent[];
  compatibility?: {
    provider?: LlmProviderKind;
    providerConfigId?: string;
    baseUrl?: string;
    model?: string;
    format?: string;
    endpoint?: string;
  };
  usageMetadata?: LlmUsageMetadataRecord;
  rawResponse?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface RunCompressionBlockLinkRecord {
  id: string;
  runId: string;
  blockId: string;
  variantId?: string;
  role: 'context';
  mode: CompressionContextUseMode;
  createdAt: number;
  updatedAt: number;
}

/**
 * 独立后台进程的公开投影。Process 的生命周期可以长于启动它的 Tool Attempt；
 * stdout/stderr 正文由后台进程存储持有，不进入 ClientState。
 */
export type BackgroundProcessStatus = 'running' | 'exited' | 'killed' | 'abnormal';

export interface BackgroundProcessRecord {
  id: string;
  processId: string;
  pid?: number;
  toolName: 'shell' | 'bash';
  command: string;
  cwd: string;
  status: BackgroundProcessStatus;
  exitCode: number | null;
  killed: boolean;
  startedAt: number;
  backgroundedAt: number;
  updatedAt: number;
  exitedAt?: number;
  terminalRevision: number;
  stdoutChars: number;
  stderrChars: number;
  droppedChars: number;
  outputAvailable: boolean;
  outputConsumedAt?: number;
  abnormalReason?: string;
}

/** ToolCall/Run/Conversation 与 BackgroundProcess 之间的独立来源关系。 */
export interface BackgroundProcessOriginLinkRecord {
  id: string;
  backgroundProcessId: string;
  processId: string;
  sourceToolCallId: string;
  sourceRunId: string;
  conversationId: string;
  sourceAttemptId: string;
  sourceGeneration: number;
  createdAt: number;
  updatedAt: number;
}

export interface ClientStateRecordByTable {
  agents: AgentRecord;
  toolDefinitions: ToolDefinitionRecord;
  mcpToolSources: McpToolSourceRecord;
  workflows: WorkflowRecord;
  planReviewPolicies: PlanReviewPolicyRecord;
  planReviewPolicyScopeLinks: PlanReviewPolicyScopeLinkRecord;
  planProposals: PlanProposalRecord;
  runPlanProposalLinks: RunPlanProposalLinkRecord;
  toolPolicies: ToolPolicyRecord;
  toolPolicyScopeLinks: ToolPolicyScopeLinkRecord;
  skillDefinitions: SkillDefinitionRecord;
  skillPolicies: SkillPolicyRecord;
  skillPolicyScopeLinks: SkillPolicyScopeLinkRecord;
  ruleFiles: RuleFileRecord;
  systemPrompts: SystemPromptRecord;
  systemPromptScopeLinks: SystemPromptScopeLinkRecord;
  promptPlaceholders: PromptPlaceholderRecord;
  runtimeContexts: RuntimeContextRecord;
  runtimeContextScopeLinks: RuntimeContextScopeLinkRecord;
  runtimeContextSnapshots: RuntimeContextSnapshotRecord;
  conversationRuntimeContextSnapshotLinks: ConversationRuntimeContextSnapshotLinkRecord;
  runRuntimeContextSnapshotLinks: RunRuntimeContextSnapshotLinkRecord;
  modelProfiles: ModelProfileRecord;
  modelProfileScopeLinks: ModelProfileScopeLinkRecord;
  conversationWorkflowSelections: ConversationWorkflowSelectionRecord;
  conversations: ConversationRecord;
  conversationReuseLinks: ConversationReuseLinkRecord;
  conversationBranchLinks: ConversationBranchLinkRecord;
  conversationOriginLinks: ConversationOriginLinkRecord;
  agentConversationLinks: AgentConversationLinkRecord;
  conversationAgentSelections: ConversationAgentSelectionRecord;
  projectContexts: ProjectContextRecord;
  conversationProjectLinks: ConversationProjectLinkRecord;
  workEnvironments: WorkEnvironmentRecord;
  workEnvironmentPolicies: WorkEnvironmentPolicyRecord;
  workEnvironmentPolicyScopeLinks: WorkEnvironmentPolicyScopeLinkRecord;
  conversationWorkEnvironmentLinks: ConversationWorkEnvironmentLinkRecord;
  runWorkEnvironmentLinks: RunWorkEnvironmentLinkRecord;
  checkpointPolicies: CheckpointPolicyRecord;
  checkpointPolicyScopeLinks: CheckpointPolicyScopeLinkRecord;
  shadowRepositories: ShadowRepositoryRecord;
  conversationCheckpointRepositoryLinks: ConversationCheckpointRepositoryLinkRecord;
  checkpoints: CheckpointRecord;
  checkpointTimelineAnchors: CheckpointTimelineAnchorRecord;
  messages: MessageRecord;
  messageRevisions: MessageRevisionRecord;
  messageCurrentRevisionLinks: MessageCurrentRevisionLinkRecord;
  modelContextProjections: ModelContextProjectionRecord;
  modelContextProjectionSourceLinks: ModelContextProjectionSourceLinkRecord;
  requestModelContextProjectionLinks: RequestModelContextProjectionLinkRecord;
  compressionModelContextProjectionLinks: CompressionModelContextProjectionLinkRecord;
  llmInvocations: LlmInvocationRecord;
  runLlmInvocationLinks: RunLlmInvocationLinkRecord;
  messageLlmInvocationLinks: MessageLlmInvocationLinkRecord;
  compressionBlocks: CompressionBlockRecord;
  compressionBlockSourceLinks: CompressionBlockSourceLinkRecord;
  compressionContextVariants: CompressionContextVariantRecord;
  runCompressionBlockLinks: RunCompressionBlockLinkRecord;
  compressionBlockLlmInvocationLinks: CompressionBlockLlmInvocationLinkRecord;
  toolCalls: ToolCallRecord;
  toolCallPreviews: ToolCallPreviewRecord;
  toolCallPreviewTargetLinks: ToolCallPreviewTargetLinkRecord;
  toolCallEvents: ToolCallEventRecord;
  toolResultArtifacts: ToolResultArtifactRecord;
  toolCallResultLinks: ToolCallResultLinkRecord;
  interactionRequests: DurableInteractionRequestRecord;
  backgroundProcesses: BackgroundProcessRecord;
  backgroundProcessOriginLinks: BackgroundProcessOriginLinkRecord;
  agentRuns: TurnSummaryRecord;
  turns: TurnRecord;
  turnIntents: TurnIntentRecord;
  turnIntentRevisions: TurnIntentRevisionRecord;
  pendingTurnInputs: PendingTurnInputRecord;
  executionLeases: ExecutionLeaseRecord;
  authoritySnapshots: AuthoritySnapshotRecord;
  interactionOwnerLinks: InteractionOwnerLinkRecord;
  interactionResponses: InteractionResponseRecord;
  runtimeDeliveryLinks: RuntimeDeliveryLinkRecord;
  runTerminations: RunTerminationRecord;
  agentRunSourceLinks: AgentRunSourceLinkRecord;
  agentRunTargetLinks: AgentRunTargetLinkRecord;
  messageTurnLinks: MessageTurnLinkRecord;
  toolCallRunLinks: ToolCallRunLinkRecord;
  runConversationPolicies: RunConversationPolicyRecord;
  runContextPolicies: RunContextPolicyRecord;
  runDeliveryPolicies: RunDeliveryPolicyRecord;
  runEditPolicies: RunEditPolicyRecord;
  runWorkflowLinks: RunWorkflowLinkRecord;
  runSystemPromptLinks: RunSystemPromptLinkRecord;
  runModelProfileLinks: RunModelProfileLinkRecord;
  runToolPolicyLinks: RunToolPolicyLinkRecord;
  runConversationPolicyLinks: RunConversationPolicyLinkRecord;
  runContextPolicyLinks: RunContextPolicyLinkRecord;
  runDeliveryPolicyLinks: RunDeliveryPolicyLinkRecord;
  runEditPolicyLinks: RunEditPolicyLinkRecord;
  agentRunInputRevisions: AgentRunInputRevisionRecord;
  agentAnswers: AgentAnswerRecord;
  agentAnswerSubmissionLinks: AgentAnswerSubmissionLinkRecord;
  agentAnswerTargetLinks: AgentAnswerTargetLinkRecord;
}

export type ClientStateTableKey = keyof ClientStateRecordByTable;
export type ClientStateTableRecord<TKey extends ClientStateTableKey> = ClientStateRecordByTable[TKey] & { id: string };
export type ClientState = {
  [TKey in ClientStateTableKey]: ClientStateTableRecord<TKey>[];
};

export interface ChatModelOverrideRecord {
  providerConfigId?: string;
  provider?: LlmProviderKind;
  model: string;
}

/** Next-Turn authority captured atomically with TurnStart/TurnEnqueue. */
export interface TurnAuthoritySelection {
  agentId?: string;
  model?: ChatModelOverrideRecord;
}

export interface ConversationCommandMetadata {
  commandId: string;
  expectedVersion: number;
  issuedAt: number;
}

export interface TurnStartPayload extends TurnAuthoritySelection {
  conversationId: string;
  command: ConversationCommandMetadata;
  text?: string;
  content?: MessageContent;
}

export interface TurnEnqueuePayload extends TurnAuthoritySelection {
  conversationId: string;
  command: ConversationCommandMetadata;
  text?: string;
  content?: MessageContent;
}

export interface TurnInputResultPayload {
  commandId: string;
  conversationId: string;
  requestType: BridgeMessageType.TurnStart | BridgeMessageType.TurnEnqueue;
  status: 'accepted' | 'queued' | 'replayed' | 'rejected';
  admitted: boolean;
  deduplicated: boolean;
  intentId?: string;
  turnId?: string;
  commitSeq?: string;
  message?: string;
}

export interface TurnInterruptPayload {
  conversationId: string;
  command: ConversationCommandMetadata;
  turnId: string;
  /** Positive expected ExecutionLease generation; 0 asks the host to resolve this exact Turn. */
  leaseEpoch: number;
  cascadeChildAgents?: boolean;
}

export interface TurnInterruptResultPayload {
  conversationId: string;
  turnId: string;
  status: 'accepted' | 'coalesced' | 'already_terminal';
  pendingTurnInputId?: string;
  cascadeChildAgents: boolean;
}

/**
 * Native mid-turn steering. Default action `submit` sends one user MessageContent through the
 * native steering path; `status` only reads locally persisted receipts for the conversation
 * (optionally correlated by command.commandId) and never touches the provider.
 */
export interface TurnSteerPayload {
  action?: 'submit' | 'status';
  conversationId: string;
  command: ConversationCommandMetadata;
  /** submit 必填：目标 Turn。 */
  turnId?: string;
  /** submit 必填：正数 = 期望的 ExecutionLease 代。 */
  leaseEpoch?: number;
  /** submit 必填：单条用户消息内容。 */
  content?: MessageContent;
}

export interface TurnSteerResultPayload {
  conversationId: string;
  /** submit/live 路径返回本条提交的一张收据；status 路径返回本地已知的全部收据。 */
  receipts: NativeSteeringReceipt[];
  commandId?: string;
  error?: string;
}

export interface GuidanceControlTarget {
  intentId: string;
  expectedRevisionSeq: string;
}

export interface GuidanceEditPayload extends GuidanceControlTarget {
  conversationId: string;
  command: ConversationCommandMetadata;
  text: string;
}

export interface GuidanceCancelPayload extends GuidanceControlTarget {
  conversationId: string;
  command: ConversationCommandMetadata;
}

export interface GuidanceHoldPayload extends GuidanceControlTarget {
  conversationId: string;
  command: ConversationCommandMetadata;
  hold: 'none' | 'paused';
}

export interface GuidanceReorderPayload {
  conversationId: string;
  command: ConversationCommandMetadata;
  items: GuidanceControlTarget[];
}

export interface GuidanceControlResultPayload {
  commandId: string;
  conversationId: string;
  action: 'edit' | 'cancel' | 'reorder' | 'hold';
  status: 'accepted' | 'replayed' | 'rejected';
  intentId?: string;
  commitSeq?: string;
  message?: string;
}

export interface MessageEditPayload extends TurnAuthoritySelection {
  conversationId: string;
  command: ConversationCommandMetadata;
  messageId: string;
  expectedRevisionId: string;
  text?: string;
  content?: MessageContent;
  runAfterEdit?: boolean;
  deleteFollowing?: boolean;
}
export interface ConversationOpenPayload { conversationId: string; title?: string }
export interface ConversationCreatePayload { projectFolderUri?: string }
export interface ConversationForkPayload {
  sourceConversationId: string;
  messageId: string;
  expectedRevisionId: string;
  command: ConversationCommandMetadata;
}
export interface ConversationForkResultPayload {
  sourceConversationId: string;
  messageId: string;
  expectedRevisionId: string;
  commandId: string;
  conversationId: string;
  status: 'accepted' | 'already_applied';
}
export interface AgentCreatePayload { name: string; description?: string; kind?: string }
export interface AgentUpdatePayload { agentId: string; name?: string; description?: string; kind?: string }
export interface AgentDeletePayload { agentId: string }
export interface MessageDeleteFromPayload {
  conversationId: string;
  command: ConversationCommandMetadata;
  messageId: string;
}
export type MessageRetryTarget =
  | { kind: 'message'; messageId: string }
  | { kind: 'model_request'; modelRequestId: string };

interface MessageRetryFromPayloadBase extends TurnAuthoritySelection {
  conversationId: string;
  command: ConversationCommandMetadata;
}

export type MessageRetryFromPayload = MessageRetryFromPayloadBase & (
  | { target: Extract<MessageRetryTarget, { kind: 'message' }>; expectedRevisionId: string }
  | { target: Extract<MessageRetryTarget, { kind: 'model_request' }> }
);

export type ConversationActionKind = 'edit' | 'retry' | 'delete';

export interface ConversationActionResultPayload {
  action: ConversationActionKind;
  conversationId: string;
  commandId: string;
  target: MessageRetryTarget;
  status: 'accepted' | 'already_applied' | 'busy';
  turnId?: string;
  messageRevisionId?: string;
}

export type CompressionCommandTarget =
  | { kind: 'current_head'; expectedRootId: string }
  | { kind: 'through_message'; messageId: string; expectedRevisionId: string };

/** Server-derived compression admission. Webviews never choose a Context root, range or method. */
export interface CompressionStartPayload {
  conversationId: string;
  command: ConversationCommandMetadata;
  target: CompressionCommandTarget;
}

export interface CompressionCommandResultPayload {
  conversationId: string;
  commandId: string;
  target: CompressionCommandTarget;
  status: 'accepted' | 'already_applied' | 'in_progress' | 'busy' | 'rejected';
  turnId?: string;
  modelRequestId?: string;
  compressionBlockId?: string;
  reasonCode?: string;
}
export type InteractionOutcomeStatus =
  | 'committed'
  | 'already_applied'
  | 'already_satisfied'
  | 'already_resolved'
  | 'stale'
  | 'rejected'
  | 'blocked'
  | 'outcome_unknown';

export interface InteractionResultPayload {
  requestType: string;
  conversationId: string;
  targetId: string;
  status: InteractionOutcomeStatus;
  transitionId?: string;
  /** Atomic control-plane commit proof for every conversation scope touched by the interaction. */
  controlHeads?: CommittedConversationHead[];
  /** Only projection patches emitted by this interaction; clients wait solely for views they own. */
  projectionHeads?: CommittedConversationHead[];
  result?: JsonValue;
  reason?: string;
}

export interface InteractionResolvePayload {
  conversationId: string;
  interactionRequestId: string;
  interactionRevision: number;
  ownerTurnId: string;
  decision: DurableInteractionDecision;
  response: JsonValue;
}

export interface ToolDecisionPayload {
  toolCallId: string;
  conversationId?: string;
  reason?: string;
}

export interface ProcessStopPayload {
  processId: string;
  conversationId?: string;
  reason?: string;
}

export interface PlanProposalOpenPayload {
  conversationId?: string;
  toolCallId?: string;
  planProposalId?: string;
  title?: string;
}
export interface PlanProposalExportPayload {
  suggestedFileName?: string;
  markdown: string;
}
export interface ToolDiffOpenPayload {
  toolCallId: string;
  conversationId?: string;
}

export interface ToolPolicyScopeSetPayload {
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
  name?: string;
  allowedTools: string[];
  preset?: ToolPolicyPresetKind;
  toolConfigs?: Record<string, ToolPolicyToolConfigRecord>;
  sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>;
}
export interface ToolPolicyScopeClearPayload {
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
}
export interface SkillPolicyScopeSetPayload {
  scopeKind: SkillPolicyScopeKind;
  scopeId?: string;
  name?: string;
  sourceConfigs?: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>>;
}
export interface SkillPolicyScopeClearPayload {
  scopeKind: SkillPolicyScopeKind;
  scopeId?: string;
}
export interface CheckpointPolicyScopeSetPayload {
  scopeKind: CheckpointPolicyScopeKind;
  scopeId?: string;
  name?: string;
  enabled?: boolean;
  initialSnapshotMaxBytes?: number;
  preserveEmptyDirectories?: boolean;
  useGitignore?: boolean;
  skipPatterns?: string[];
  triggers?: Partial<CheckpointTriggerConfigRecord>;
  toolTriggers?: Record<string, Partial<CheckpointToolTriggerConfigRecord>>;
}
export interface CheckpointPolicyScopeClearPayload {
  scopeKind: CheckpointPolicyScopeKind;
  scopeId?: string;
}
export interface PlanReviewPolicyScopeSetPayload {
  scopeKind: PlanReviewPolicyScopeKind;
  scopeId?: string;
  mode: PlanReviewMode;
  allowReadonlyBeforeApproval?: boolean;
  requireForToolRiskLevels?: PlanReviewRequiredToolRiskLevel[];
}
export interface PlanReviewPolicyScopeClearPayload {
  scopeKind: PlanReviewPolicyScopeKind;
  scopeId?: string;
}
export interface SystemPromptScopeSetPayload {
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  name?: string;
  text: string;
  order?: number;
}
export interface SystemPromptScopeClearPayload { scopeKind: ConfigScopeKind; scopeId?: string }
export interface RuntimeContextScopeSetPayload {
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  name?: string;
  template: string;
  order?: number;
}
export interface RuntimeContextScopeClearPayload { scopeKind: ConfigScopeKind; scopeId?: string }
export interface ModelProfileScopeSetPayload {
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  name?: string;
  providerConfigId?: string;
  provider?: LlmProviderKind;
  model: string;
}
export interface ModelProfileScopeClearPayload { scopeKind: ConfigScopeKind; scopeId?: string }
export interface ClientResyncPayload {
  streamId?: string;
  conversationId?: string;
}

export interface WorkflowCreatePayload {
  name: string;
  description?: string;
}
export interface WorkflowUpdatePayload {
  workflowId: string;
  name?: string;
  description?: string;
  icon?: WorkflowIconKey;
}
export interface WorkflowDeletePayload {
  workflowId: string;
}
export type ConversationWorkflowSelectPayload =
  | { conversationId: string; scopeKind: 'global' }
  | { conversationId: string; scopeKind: 'workflow'; workflowId: string };
export interface ConversationAgentSelectPayload {
  conversationId: string; agentId: string;
}

export interface ConfigurationSnapshotPayload {
  state: ClientState;
  loadedAt: number;
}

export interface LlmProviderModelsGetPayload {
  config: LlmProviderConfigRecord;
}

export interface LlmProviderModelsSnapshotPayload {
  configId: string;
  provider: LlmProviderKind;
  baseUrl: string;
  models: LlmProviderModelRecord[];
}


export interface GlobalSettingsRecord {
  dataFilePath: string;
  proxy: string;
  /** 代理是否同时覆盖 shell 子进程与 MCP 连接；默认 false，仅 LLM 链路使用代理。 */
  proxyShellAndMcp: boolean;
  activeDataRootPath: string;
  defaultDataRootPath: string;
}
export interface NetworkSettingsRecord {
  /** LLM 请求的默认 User-Agent；空字符串使用扩展默认值，渠道或模型请求头可覆盖。 */
  userAgent: string;
}
export interface CheckpointMaintenanceSettingsRecord {
  autoCleanupEnabled: boolean;
  autoCleanupDays: number;
  autoDismissEnabled: boolean;
  autoDismissSeconds: number;
}
export interface AttachmentSettingsRecord {
  /** base64 附件超过该大小时不复制进 dataRoot/attachments，默认 20MB。 */
  maxStoredInlineFileMb: number;
}
export type McpServerTransportRecord =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string; headers?: Record<string, string> };
export interface McpServerConfigRecord {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpServerTransportRecord;
  createdAt: number;
  updatedAt: number;
}
export interface McpServersSettingsRecord {
  servers: McpServerConfigRecord[];
}
export type McpToolSourceStatus = 'disabled' | 'idle' | 'connecting' | 'connected' | 'error';
export interface McpToolSourceRecord {
  id: string;
  name: string;
  transportKind: McpServerTransportRecord['kind'];
  enabled: boolean;
  status: McpToolSourceStatus;
  toolCount: number;
  lastError?: string;
  updatedAt: number;
}
export interface AppearanceSettingsRecord {
  /** 应用内部正在整理上下文、调度下一轮模型响应时显示的文字。 */
  streamingTextPreparing: string;
  /** AI 等待响应时显示的文字（流式中但还没有任何内容块时）。 */
  streamingTextWaiting: string;
  /** AI 思考中显示的文字（思考内容正在流式输出时）。 */
  streamingTextThinking: string;
  /** AI 输出正文时显示的文字（正文正在流式输出时）。 */
  streamingTextWriting: string;
  /** AI 已输出工具调用、工具正在排队或执行时显示的文字。 */
  streamingTextToolExecuting: string;
}
export type GlobalSettingsSectionValue = GlobalSettingsRecord | NetworkSettingsRecord | LlmSettingsRecord | LlmProviderConfigsRecord | LlmCompressionSettingsRecord | LlmCompressionConfigsRecord | CheckpointMaintenanceSettingsRecord | AppearanceSettingsRecord | AttachmentSettingsRecord | McpServersSettingsRecord | DebugCaptureSettings;
export interface GlobalSettingsGetPayload {
  section: GlobalSettingsSection;
}
export interface GlobalSettingsFlushResultPayload {
  status: 'saved' | 'failed';
  message?: string;
}
export interface GlobalSettingsSnapshotPayload {
  section: GlobalSettingsSection;
  settings: GlobalSettingsSectionValue;
  filePath: string;
  /** 该 section 一致内容的指纹；保存时必须原样回传。 */
  revision: string;
}
export interface GlobalSettingsUpdatePayload {
  section: GlobalSettingsSection;
  settings: GlobalSettingsSectionValue;
  refreshMcpTools?: boolean;
  /** 本次编辑所基于的设置指纹，防止旧窗口覆盖新内容。 */
  expectedRevision: string;
}
export interface ConversationSettingsRecord {
  conversationId: string;
  name: string;
}
export interface ConversationLlmSettingsRecord {
  conversationId: string;
  activeProviderConfigId: string;
  /** 当前对话对各渠道配置的模型选择覆盖；key 为 providerConfigId，value 为 model id。 */
  modelOverrides?: Record<string, string>;
}
export type ConversationSettingsSectionValue = ConversationSettingsRecord | ConversationLlmSettingsRecord;
export interface ConversationSettingsGetPayload {
  conversationId: string;
  section: ConversationSettingsSection;
}
export interface ConversationSettingsSnapshotPayload {
  conversationId: string;
  section: ConversationSettingsSection;
  settings: ConversationSettingsSectionValue;
  filePath: string;
}
export interface ConversationSettingsUpdatePayload {
  section: ConversationSettingsSection;
  settings: ConversationSettingsSectionValue;
}

export interface ProjectFolderCandidateRecord {
  uri: string;
  name: string;
  index: number;
}

export interface ProjectFoldersSnapshotPayload {
  folders: ProjectFolderCandidateRecord[];
}

export interface WorkEnvironmentSelectPayload {
  conversationId: string;
  workEnvironmentId: string;
}

export interface WorkEnvironmentUpsertPayload {
  workEnvironment: WorkEnvironmentRecord;
}

export interface WorkEnvironmentRemovePayload {
  workEnvironmentId: string;
}

export interface WorkEnvironmentImportFromVscodePayload {
  includeDefaultSshConfig?: boolean;
}

export interface SkillCatalogRefreshPayload {
  reason?: string;
}

export interface RulesFileSavePayload {
  scope: RuleScope;
  /** 仅 AGENTS.md 可写；CLAUDE.md 为只读兼容读取，不通过此通道保存。 */
  content: string;
}

export interface RulesCatalogRefreshPayload {
  reason?: string;
}

export interface WorkEnvironmentPolicyScopeSetPayload {
  scopeKind: WorkEnvironmentPolicyScopeKind;
  scopeId?: string;
  name?: string;
  enabled?: boolean;
  allowedWorkEnvironmentIds: string[];
  defaultWorkEnvironmentId?: string;
}

export interface WorkEnvironmentPolicyScopeClearPayload {
  scopeKind: WorkEnvironmentPolicyScopeKind;
  scopeId?: string;
}

export interface LocalFileOpenPayload {
  source: string;
}

export interface AttachmentOpenPayload {
  attachmentId?: string;
  sourcePath?: string;
  data?: string;
  mimeType?: string;
  name?: string;
}

export type AttachmentReloadPayload = Omit<AttachmentOpenPayload, 'data'>;

export interface AttachmentOpenResultPayload {
  request: Omit<AttachmentOpenPayload, 'data'>;
  status: 'opened' | 'failed';
  error?: string;
}

export interface AttachmentReloadResultPayload {
  request: AttachmentReloadPayload;
  part?: InlineDataPart;
  status: AttachmentAvailabilityStatus;
  error?: string;
}

export type WebviewToExtensionMessage =
  | BridgeEnvelope<BridgeMessageType.DebugCaptureCommand, DebugCaptureCommand>
  | BridgeEnvelope<BridgeMessageType.DebugCaptureObservation, DebugCaptureUiBatch>
  | BridgeEnvelope<BridgeMessageType.Ready, undefined>
  | BridgeEnvelope<BridgeMessageType.Ack, BridgeAckPayload>
  | BridgeEnvelope<BridgeMessageType.Ping, { text: string; sentAt: number }>
  | BridgeEnvelope<BridgeMessageType.GetWorkspaceInfo, undefined>
  | BridgeEnvelope<BridgeMessageType.ShowInfo, { message: string }>
  | BridgeEnvelope<BridgeMessageType.TurnStart, TurnStartPayload>
  | BridgeEnvelope<BridgeMessageType.TurnEnqueue, TurnEnqueuePayload>
  | BridgeEnvelope<BridgeMessageType.TurnInterrupt, TurnInterruptPayload>
  | BridgeEnvelope<BridgeMessageType.TurnSteer, TurnSteerPayload>
  | BridgeEnvelope<BridgeMessageType.GuidanceEdit, GuidanceEditPayload>
  | BridgeEnvelope<BridgeMessageType.GuidanceCancel, GuidanceCancelPayload>
  | BridgeEnvelope<BridgeMessageType.GuidanceReorder, GuidanceReorderPayload>
  | BridgeEnvelope<BridgeMessageType.GuidanceHold, GuidanceHoldPayload>
  | BridgeEnvelope<BridgeMessageType.InteractionResolve, InteractionResolvePayload>
  | BridgeEnvelope<BridgeMessageType.ConversationOpen, ConversationOpenPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationCreate, ConversationCreatePayload>
  | BridgeEnvelope<BridgeMessageType.ConversationFork, ConversationForkPayload>
  | BridgeEnvelope<BridgeMessageType.AgentCreate, AgentCreatePayload>
  | BridgeEnvelope<BridgeMessageType.AgentUpdate, AgentUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.AgentDelete, AgentDeletePayload>
  | BridgeEnvelope<BridgeMessageType.ConversationAgentSelect, ConversationAgentSelectPayload>
  | BridgeEnvelope<BridgeMessageType.SystemPromptScopeSet, SystemPromptScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.SystemPromptScopeClear, SystemPromptScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.RuntimeContextScopeSet, RuntimeContextScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.RuntimeContextScopeClear, RuntimeContextScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.ModelProfileScopeSet, ModelProfileScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.ModelProfileScopeClear, ModelProfileScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.MessageEdit, MessageEditPayload>
  | BridgeEnvelope<BridgeMessageType.MessageDeleteFrom, MessageDeleteFromPayload>
  | BridgeEnvelope<BridgeMessageType.MessageRetryFrom, MessageRetryFromPayload>
  | BridgeEnvelope<BridgeMessageType.CompressionStart, CompressionStartPayload>
  | BridgeEnvelope<BridgeMessageType.ToolPolicyScopeSet, ToolPolicyScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.ToolPolicyScopeClear, ToolPolicyScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.SkillPolicyScopeSet, SkillPolicyScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.SkillPolicyScopeClear, SkillPolicyScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.SkillCatalogRefresh, SkillCatalogRefreshPayload>
  | BridgeEnvelope<BridgeMessageType.RulesFileSave, RulesFileSavePayload>
  | BridgeEnvelope<BridgeMessageType.RulesCatalogRefresh, RulesCatalogRefreshPayload>
  | BridgeEnvelope<BridgeMessageType.PlanReviewPolicyScopeSet, PlanReviewPolicyScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.PlanReviewPolicyScopeClear, PlanReviewPolicyScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointPolicyScopeSet, CheckpointPolicyScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointPolicyScopeClear, CheckpointPolicyScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.ToolExecutionCancel, ToolDecisionPayload>
  | BridgeEnvelope<BridgeMessageType.ProcessStop, ProcessStopPayload>
  | BridgeEnvelope<BridgeMessageType.ToolDiffOpen, ToolDiffOpenPayload>
  | BridgeEnvelope<BridgeMessageType.PlanProposalOpen, PlanProposalOpenPayload>
  | BridgeEnvelope<BridgeMessageType.PlanProposalExport, PlanProposalExportPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointDiffOpen, CheckpointDiffOpenPayload>
  | BridgeEnvelope<BridgeMessageType.LocalFileOpen, LocalFileOpenPayload>
  | BridgeEnvelope<BridgeMessageType.AttachmentOpen, AttachmentOpenPayload>
  | BridgeEnvelope<BridgeMessageType.AttachmentReload, AttachmentReloadPayload>
  | BridgeEnvelope<BridgeMessageType.ClientResync, ClientResyncPayload>
  | BridgeEnvelope<BridgeMessageType.LlmProviderModelsGet, LlmProviderModelsGetPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointGitStatusGet, undefined>
  | BridgeEnvelope<BridgeMessageType.CheckpointShadowStatsGet, undefined>
  | BridgeEnvelope<BridgeMessageType.CheckpointShadowDelete, CheckpointShadowDeletePayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointDismiss, CheckpointDismissPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointRestore, CheckpointRestorePayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsGet, GlobalSettingsGetPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsUpdate, GlobalSettingsUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsFlushResult, GlobalSettingsFlushResultPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsGet, ConversationSettingsGetPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsUpdate, ConversationSettingsUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.ProjectFoldersGet, undefined>
  | BridgeEnvelope<BridgeMessageType.WorkflowCreate, WorkflowCreatePayload>
  | BridgeEnvelope<BridgeMessageType.WorkflowUpdate, WorkflowUpdatePayload>
  | BridgeEnvelope<BridgeMessageType.WorkflowDelete, WorkflowDeletePayload>
  | BridgeEnvelope<BridgeMessageType.ConversationWorkflowSelect, ConversationWorkflowSelectPayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentSelect, WorkEnvironmentSelectPayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentUpsert, WorkEnvironmentUpsertPayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentRemove, WorkEnvironmentRemovePayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentImportFromVscode, WorkEnvironmentImportFromVscodePayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentPolicyScopeSet, WorkEnvironmentPolicyScopeSetPayload>
  | BridgeEnvelope<BridgeMessageType.WorkEnvironmentPolicyScopeClear, WorkEnvironmentPolicyScopeClearPayload>
  | BridgeEnvelope<BridgeMessageType.FsStatGet, FsStatGetPayload>;

export type ExtensionToWebviewMessage =
  | BridgeEnvelope<BridgeMessageType.DebugCaptureResult, DebugCaptureResult>
  | BridgeEnvelope<BridgeMessageType.DebugCaptureObservationAck, DebugCaptureUiAck>
  | BridgeEnvelope<BridgeMessageType.Hello, BridgeHelloPayload>
  | BridgeEnvelope<BridgeMessageType.Pong, { text: string; receivedAt: number }>
  | BridgeEnvelope<BridgeMessageType.WorkspaceInfo, WorkspaceInfo>
  | BridgeEnvelope<BridgeMessageType.Error, {
      requestType?: string;
      message: string;
      code?: 'settings_revision_conflict';
      actualRevision?: string;
    }>
  | BridgeEnvelope<BridgeMessageType.InteractionResult, InteractionResultPayload>
  | BridgeEnvelope<BridgeMessageType.TurnInputResult, TurnInputResultPayload>
  | BridgeEnvelope<BridgeMessageType.TurnInterruptResult, TurnInterruptResultPayload>
  | BridgeEnvelope<BridgeMessageType.TurnSteerResult, TurnSteerResultPayload>
  | BridgeEnvelope<BridgeMessageType.GuidanceControlResult, GuidanceControlResultPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationActionResult, ConversationActionResultPayload>
  | BridgeEnvelope<BridgeMessageType.ConversationForkResult, ConversationForkResultPayload>
  | BridgeEnvelope<BridgeMessageType.CompressionCommandResult, CompressionCommandResultPayload>
  | BridgeEnvelope<BridgeMessageType.ConfigurationSnapshot, ConfigurationSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.LlmProviderModelsSnapshot, LlmProviderModelsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointGitStatusSnapshot, CheckpointGitStatusSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointShadowStatsSnapshot, CheckpointShadowStatsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointRestoreResult, CheckpointRestoreResultPayload>
  | BridgeEnvelope<BridgeMessageType.CheckpointDiffOpenResult, CheckpointDiffOpenResultPayload>
  | BridgeEnvelope<BridgeMessageType.AttachmentOpenResult, AttachmentOpenResultPayload>
  | BridgeEnvelope<BridgeMessageType.AttachmentReloadResult, AttachmentReloadResultPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsSnapshot, GlobalSettingsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.GlobalSettingsFlush, undefined>
  | BridgeEnvelope<BridgeMessageType.ConversationSettingsSnapshot, ConversationSettingsSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.ProjectFoldersSnapshot, ProjectFoldersSnapshotPayload>
  | BridgeEnvelope<BridgeMessageType.FsStatResult, FsStatResultPayload>;

export function createMessageId(): MessageId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
