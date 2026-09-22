import { BridgeMessageType, type BridgeChannel, type WebviewToExtensionMessage } from '@shared/protocol';

/** 把出站消息类型映射到桥接通道。逻辑与旧 vscodeBridge 保持一致。 */
export function channelForType(type: WebviewToExtensionMessage['type']): BridgeChannel {
  switch (type) {
    case BridgeMessageType.DebugCaptureCommand:
    case BridgeMessageType.DebugCaptureObservation:
      return 'diagnostics';
    case BridgeMessageType.TurnStart:
    case BridgeMessageType.TurnEnqueue:
    case BridgeMessageType.TurnInterrupt:
    case BridgeMessageType.TurnSteer:
    case BridgeMessageType.GuidanceEdit:
    case BridgeMessageType.GuidanceCancel:
    case BridgeMessageType.GuidanceReorder:
    case BridgeMessageType.GuidanceHold:
    case BridgeMessageType.InteractionResolve:
    case BridgeMessageType.ConversationCreate:
    case BridgeMessageType.ConversationFork:
    case BridgeMessageType.MessageEdit:
    case BridgeMessageType.MessageDeleteFrom:
    case BridgeMessageType.MessageRetryFrom:
    case BridgeMessageType.CompressionStart:
    case BridgeMessageType.WorkflowCreate:
    case BridgeMessageType.WorkflowUpdate:
    case BridgeMessageType.WorkflowDelete:
    case BridgeMessageType.ConversationWorkflowSelect:
    case BridgeMessageType.ModelProfileScopeRead:
    case BridgeMessageType.ModelProfileScopeSet:
    case BridgeMessageType.ModelProfileScopeClear:
    case BridgeMessageType.WorkEnvironmentSelect:
    case BridgeMessageType.WorkEnvironmentUpsert:
    case BridgeMessageType.WorkEnvironmentRemove:
    case BridgeMessageType.WorkEnvironmentImportFromVscode:
    case BridgeMessageType.WorkEnvironmentPolicyScopeSet:
    case BridgeMessageType.WorkEnvironmentPolicyScopeClear:
    case BridgeMessageType.ToolPolicyScopeSet:
    case BridgeMessageType.ToolPolicyScopeClear:
    case BridgeMessageType.SkillPolicyScopeSet:
    case BridgeMessageType.SkillPolicyScopeClear:
    case BridgeMessageType.SkillCatalogRefresh:
    case BridgeMessageType.RulesFileSave:
    case BridgeMessageType.RulesCatalogRefresh:
    case BridgeMessageType.RuntimeContextScopeSet:
    case BridgeMessageType.RuntimeContextScopeClear:
    case BridgeMessageType.PlanReviewPolicyScopeSet:
    case BridgeMessageType.PlanReviewPolicyScopeClear:
    case BridgeMessageType.CheckpointPolicyScopeSet:
    case BridgeMessageType.CheckpointPolicyScopeClear:
    case BridgeMessageType.CheckpointShadowDelete:
    case BridgeMessageType.CheckpointDismiss:
    case BridgeMessageType.CheckpointRestore:
    case BridgeMessageType.ToolExecutionCancel:
    case BridgeMessageType.ProcessStop:
    case BridgeMessageType.ToolDiffOpen:
    case BridgeMessageType.PlanProposalOpen:
    case BridgeMessageType.PlanProposalExport:
    case BridgeMessageType.CheckpointDiffOpen:
    case BridgeMessageType.LocalFileOpen:
    case BridgeMessageType.AttachmentOpen:
      return 'command';
    case BridgeMessageType.ClientResync:
    case BridgeMessageType.FsStatGet:
    case BridgeMessageType.ProjectFoldersGet:
    case BridgeMessageType.LlmProviderModelsGet:
    case BridgeMessageType.CheckpointGitStatusGet:
    case BridgeMessageType.CheckpointShadowStatsGet:
    case BridgeMessageType.AttachmentReload:
      return 'state';
    case BridgeMessageType.GlobalSettingsGet:
    case BridgeMessageType.GlobalSettingsUpdate:
    case BridgeMessageType.GlobalSettingsFlushResult:
    case BridgeMessageType.ConversationSettingsGet:
    case BridgeMessageType.ConversationSettingsUpdate:
      return 'settings';
    default:
      return 'control';
  }
}
