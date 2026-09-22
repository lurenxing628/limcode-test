import { ModelProfileMutationCompletions, modelProfileCompletionKey } from './ModelProfileMutationCompletions';
import type { ModelProfileScopeReadPayload, ModelProfileScopeSetPayload, ModelProfileScopeSnapshotPayload } from '../../../shared/protocol';

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { toStructuredClonePlainData } from '../../../shared/plainData';
import type { DebugCaptureCommand, DebugCaptureSettings } from '../../../shared/debugCapture';
import {
  BridgeMessageType,
  type AttachmentOpenPayload,
  type AttachmentReloadPayload,
  type ConversationAgentSelectPayload,
  type ConversationActionResultPayload,
  type CompressionCommandResultPayload,
  type CompressionStartPayload,
  type ConversationForkPayload,
  type ConversationForkResultPayload,
  type ConversationSettingsGetPayload,
  type ConversationSettingsUpdatePayload,
  type GlobalSettingsGetPayload,
  type GlobalSettingsRecord,
  type GlobalSettingsUpdatePayload,
  type GuidanceCancelPayload,
  type GuidanceControlResultPayload,
  type GuidanceEditPayload,
  type GuidanceHoldPayload,
  type GuidanceReorderPayload,
  type InteractionResolvePayload,
  type LlmProviderModelsGetPayload,
  type MessageDeleteFromPayload,
  type MessageEditPayload,
  type MessageRetryFromPayload,
  type PlanProposalExportPayload,
  type ProcessStopPayload,
  type ToolDecisionPayload,
  type TurnInterruptPayload,
  type TurnInputResultPayload,
  type TurnStartPayload,
  type TurnSteerPayload,
  type WebviewToExtensionMessage
} from '../../../shared/protocol';
import { isConversationHistoryBusyError } from '../../reliableKernel/turnControlPlane';
import { isSettingsRevisionConflictError } from '../../capabilities/settingsRevisionConflict';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import { listAllDomainRows } from '../../reliableKernel/repositoryPagination';
import type { VscodeReliableKernelProductRuntime } from './VscodeReliableKernelProductRuntime';
import { readVscodeSshWorkEnvironments } from './VscodeSshConfigurationReader';
import { applyProxyEnvironment, currentProxyEnvironment, proxyForShellAndMcp } from './proxyEnvironment';
import { GlobalSettingsSaveBarrier } from './GlobalSettingsSaveBarrier';

export interface VscodeReliableKernelCommandRouterOptions {
  broadcast?(message: unknown): void;
  /** Delivers a Conversation-scoped message only to panels currently bound to that Conversation. */
  postToConversation?(conversationId: string, message: unknown): void;
  createConversation?(options: { projectFolderUri?: string }): Promise<string>;
  forkConversation?(request: ConversationForkPayload): Promise<{
    conversationId: string;
    deduplicated: boolean;
  }>;
  openPlanProposal?(payload: { conversationId?: string; toolCallId?: string; planProposalId?: string; title?: string }): void;
  /**
   * The Conversation bound at attach time for one client. A feed may reconnect/resync only to
   * this binding; in-panel navigation must go through the Host panel claim-before-open path.
   */
  conversationIdForClient?(clientId: string): string | undefined;
}

/** Normal Webview command route for reliable Runtime mutations. Bounded Feed remains the only data route. */
export class VscodeReliableKernelCommandRouter {
  private readonly modelProfileSessions = new Map<string, { id: string; inFlight: number }>();
  private readonly modelProfileCompletions = new ModelProfileMutationCompletions();
  private configurationMutationQueue: Promise<void> = Promise.resolve();
  private readonly clientIdByWebview = new WeakMap<vscode.Webview, string>();
  private readonly settingsSaveBarrier = new GlobalSettingsSaveBarrier();

  public constructor(
    private readonly product: VscodeReliableKernelProductRuntime,
    private readonly options: VscodeReliableKernelCommandRouterOptions = {}
  ) {
    this.product.debugCapture.setListener(state => this.options.broadcast?.({ id: randomUUID(), type: BridgeMessageType.DebugCaptureResult, channel: 'diagnostics', payload: { state } }));
    this.product.toolHost.setStateChangeListener(() => {
      if (!this.options.broadcast) return;
      void this.product.ensureCapabilitiesReady()
        .then(() => this.configurationSnapshot())
        .then((snapshot) => this.options.broadcast?.(snapshot))
        .catch((error) => console.warn('[LimCode] Failed to publish refreshed capability catalog.', error));
    });
  }

  public handle(
    clientId: string,
    webview: vscode.Webview,
    message: WebviewToExtensionMessage
  ): void {
    this.clientIdByWebview.set(webview, clientId);
    if (message.type === BridgeMessageType.ModelProfileScopeSet || message.type === BridgeMessageType.ModelProfileScopeClear || message.type === BridgeMessageType.ModelProfileScopeRead) {
      this.handleModelProfileScope(clientId, webview, message);
      return;
    }
    void this.dispatch(clientId, webview, message).catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      console.error('[LimCode] Reliable Webview command failed.', message.type, error);
      if (
        (message.type === BridgeMessageType.TurnStart || message.type === BridgeMessageType.TurnEnqueue)
        && message.payload?.command?.commandId
        && message.payload.conversationId
      ) {
        this.postTurnInputResult(webview, message.id, {
          commandId: message.payload.command.commandId,
          conversationId: message.payload.conversationId,
          requestType: message.type,
          status: 'rejected',
          admitted: false,
          deduplicated: false,
          message: text
        });
      } else if (message.type === BridgeMessageType.TurnSteer && message.payload?.conversationId) {
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.TurnSteerResult,
          channel: 'control',
          correlationId: message.id,
          payload: {
            conversationId: message.payload.conversationId,
            ...(message.payload.command?.commandId ? { commandId: message.payload.command.commandId } : {}),
            receipts: [],
            error: text
          }
        });
      } else if (
        (message.type === BridgeMessageType.GlobalSettingsGet || message.type === BridgeMessageType.GlobalSettingsUpdate)
        && message.payload?.section
      ) {
        // The Webview tracks loading/failure independently per section. Preserve that scope on generic
        // read/write failures so one invalid settings store does not leave the whole channel page pending.
        this.postRequestError(webview, message.type, text, message.id, { section: message.payload.section });
      } else if (
        message.type === BridgeMessageType.ConversationSettingsGet
        || message.type === BridgeMessageType.ConversationSettingsUpdate
      ) {
        const conversationId = message.type === BridgeMessageType.ConversationSettingsGet
          ? message.payload?.conversationId
          : message.payload?.settings?.conversationId;
        this.postRequestError(webview, message.type, text, message.id, {
          ...(typeof conversationId === 'string' && conversationId.trim()
            ? { conversationId: conversationId.trim() }
            : {})
        });
      } else if (isGuidanceControlType(message.type)) {
        const payload = message.payload as
          | GuidanceEditPayload
          | GuidanceCancelPayload
          | GuidanceReorderPayload
          | GuidanceHoldPayload
          | undefined;
        if (payload) {
          this.postGuidanceControlResult(webview, message.id, {
            commandId: payload.command.commandId,
            conversationId: payload.conversationId,
            action: guidanceControlAction(message.type),
            status: 'rejected',
            ...('intentId' in payload && typeof payload.intentId === 'string'
              ? { intentId: payload.intentId }
              : {}),
            message: text
          });
        } else {
          this.postRequestError(webview, message.type, text, message.id);
        }
      } else {
        this.postRequestError(webview, message.type, text, message.id);
      }
      if (isConfigurationMutationType(message.type)) {
        void this.postConfigurationSnapshot(webview).catch((snapshotError) =>
          console.warn('[LimCode] Failed to reconcile configuration snapshot after mutation error.', snapshotError)
        );
      }
      void vscode.window.showWarningMessage(`LimCode：${text}`);
    });
  }

  public detachClient(clientId: string): void {
    this.settingsSaveBarrier.detach(clientId);
  }

  /**
   * Every Conversation-mutating command runs under the Conversation Runtime owner: this Host
   * claims (or re-enters) ownership and pins it for the whole mutation, so a peer Host owning
   * the Conversation rejects the command with `conversation-runtime-owner-busy` instead of
   * racing it.
   */
  private runConversationCommand<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    return this.product.application.database.conversationOwners.run(conversationId, operation);
  }

  /** 文件监听器发现其他 Extension Host 已提交设置后，重新读盘并广播。 */
  public async refreshGlobalSettings(section: GlobalSettingsGetPayload['section']): Promise<void> {
    const stored = await this.product.configuration.loadGlobalSettings(section);
    const snapshot = this.globalSettingsSnapshot(stored);
    this.options.broadcast?.(snapshot);
    if (section === 'common') {
      await this.applyCommonProxyRuntime(stored.settings as GlobalSettingsRecord);
    }
  }

  private async debugCommand(webview: vscode.Webview, command: DebugCaptureCommand, correlationId: string): Promise<void> {
    const capture = this.product.debugCapture;
    let analysis;
    switch (command.action) {
      case 'status': break;
      case 'start': {
        const stored = await this.product.configuration.loadGlobalSettings('debugCapture');
        await capture.start({ commandId: command.commandId, conversationId: command.conversationId, settings: stored.settings as DebugCaptureSettings });
        break;
      }
      case 'stop': await capture.stop(command.runId); break;
      case 'analyze': analysis = await capture.analyze(command.runId); break;
      case 'delete': await capture.files.remove(command.runId); break;
      case 'open':
        await capture.files.withRead(command.runId, async root => { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(root)); });
        break;
      case 'export': {
        const target = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '导出到此目录' });
        if (target?.[0]) await capture.files.export(command.runId, path.join(target[0].fsPath, command.runId));
        break;
      }
      default: throw new Error('未知取证操作。');
    }
    this.post(webview, { id: randomUUID(), type: BridgeMessageType.DebugCaptureResult, channel: 'diagnostics', correlationId,
      payload: { state: await capture.state(), ...(analysis ? { analysis } : {}) } });
  }

  private async dispatch(
    clientId: string,
    webview: vscode.Webview,
    message: WebviewToExtensionMessage
  ): Promise<void> {
    if (message.type === BridgeMessageType.TurnStart || message.type === BridgeMessageType.TurnEnqueue
      || message.type === BridgeMessageType.MessageEdit || message.type === BridgeMessageType.MessageRetryFrom) {
      if (this.settingsSaveBarrier.hasClients) {
        const commandId = requireText(message.payload?.command?.commandId, 'commandId');
        const committed = await this.list('CommandReceipt', { source_kind: 'command', source_key: commandId }, 1);
        if (committed.length === 0) {
          await this.settingsSaveBarrier.flush();
          await this.configurationMutationQueue;
        }
      }
    }
    switch (message.type) {
      case BridgeMessageType.Ready:
        this.settingsSaveBarrier.attach(clientId, webview);
        this.product.application.webviewFeed.reconnect(clientId);
        await this.postConfigurationSnapshot(webview, message.id);
        if (this.product.debugCapture.active()) this.post(webview, { id: randomUUID(), type: BridgeMessageType.DebugCaptureResult, channel: 'diagnostics', payload: { state: await this.product.debugCapture.state() } });
        return;
      case BridgeMessageType.GlobalSettingsFlushResult:
        this.settingsSaveBarrier.receive(clientId, message.correlationId, requirePayload(message.payload, '设置保存确认'));
        return;
      case BridgeMessageType.DebugCaptureCommand:
        await this.debugCommand(webview, requirePayload(message.payload, '取证操作'), message.id);
        return;
      case BridgeMessageType.DebugCaptureObservation:
        this.post(webview, { id: randomUUID(), type: BridgeMessageType.DebugCaptureObservationAck, channel: 'diagnostics', correlationId: message.id,
          payload: this.product.debugCapture.observeUi(clientId, requirePayload(message.payload, '界面取证')) });
        return;
      case BridgeMessageType.ConversationOpen: {
        const conversationId = message.payload?.conversationId?.trim();
        if (conversationId) {
          if (this.options.conversationIdForClient?.(clientId) !== conversationId) {
            // A feed may never retarget to a Conversation this view does not own. Navigation
            // belongs to the Host panel claim-before-open path, which panels intercept first.
            throw new Error('该对话导航必须由宿主面板路径完成；当前视图未持有目标会话。');
          }
          await this.product.application.webviewFeed.setActiveConversation(clientId, conversationId);
        }
        return;
      }
      case BridgeMessageType.ClientResync: {
        const requested = message.payload?.conversationId?.trim() || null;
        const bound = this.options.conversationIdForClient?.(clientId) ?? null;
        if (requested !== bound) {
          // A hidden/reconnecting session must not silently bind a Conversation other than the
          // one its view reference owns; resync always re-attaches to the view binding.
          console.warn('[LimCode] Ignored ClientResync Conversation mismatch; reconnecting to the bound Conversation.');
        }
        this.product.application.webviewFeed.reconnect(clientId, bound);
        return;
      }
      case BridgeMessageType.Ping:
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.Pong,
          channel: 'control',
          correlationId: message.id,
          payload: { text: message.payload?.text ?? 'pong', receivedAt: Date.now() }
        });
        return;
      case BridgeMessageType.GetWorkspaceInfo:
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.WorkspaceInfo,
          channel: 'control',
          correlationId: message.id,
          payload: {
            name: vscode.workspace.name ?? '',
            folders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
          }
        });
        return;
      case BridgeMessageType.ProjectFoldersGet:
        this.postProjectFolders(webview, message.id);
        return;
      case BridgeMessageType.GlobalSettingsGet:
        await this.postGlobalSettings(webview, requirePayload(message.payload, 'Global settings get'), message.id);
        return;
      case BridgeMessageType.GlobalSettingsUpdate:
        await this.updateGlobalSettings(webview, requirePayload(message.payload, 'Global settings update'), message.id);
        return;
      case BridgeMessageType.ConversationSettingsGet:
        await this.postConversationSettings(webview, requirePayload(message.payload, 'Conversation settings get'), message.id);
        return;
      case BridgeMessageType.ConversationSettingsUpdate:
        await this.updateConversationSettings(webview, requirePayload(message.payload, 'Conversation settings update'), message.id);
        return;
      case BridgeMessageType.LlmProviderModelsGet:
        await this.postProviderModels(webview, requirePayload(message.payload, 'Provider models get'), message.id);
        return;
      case BridgeMessageType.FsStatGet:
        await this.postFsStats(webview, message.payload?.paths ?? [], message.id);
        return;
      case BridgeMessageType.ConversationCreate: {
        if (!this.options.createConversation) throw new Error('当前 Webview 容器不能创建 Conversation。');
        await this.options.createConversation({
          ...(message.payload?.projectFolderUri?.trim() ? { projectFolderUri: message.payload.projectFolderUri.trim() } : {})
        });
        // Navigation to the new Conversation belongs to the Host panel claim-before-open path.
        // This view's feed is never retargeted behind panel ownership; the creating Webview
        // reaches the new Conversation through the intercepted ConversationOpen navigation.
        return;
      }
      case BridgeMessageType.ConversationFork: {
        if (!this.options.forkConversation) throw new Error('当前 Webview 容器不能创建 Conversation 分支。');
        const payload = requirePayload(message.payload, 'Conversation fork');
        const result = await this.options.forkConversation(payload);
        this.postConversationForkResult(webview, message.id, {
          sourceConversationId: payload.sourceConversationId,
          messageId: payload.messageId,
          expectedRevisionId: payload.expectedRevisionId,
          commandId: payload.command.commandId,
          conversationId: result.conversationId,
          status: result.deduplicated ? 'already_applied' : 'accepted'
        });
        return;
      }
      case BridgeMessageType.AgentCreate:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.createAgent(requirePayload(message.payload, 'Agent create')));
        return;
      case BridgeMessageType.AgentUpdate:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.updateAgent(requirePayload(message.payload, 'Agent update')));
        return;
      case BridgeMessageType.AgentDelete: {
        const payload = requirePayload(message.payload, 'Agent delete');
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.deleteAgent(payload));
        return;
      }
      case BridgeMessageType.ConversationAgentSelect:
        await this.handleConversationAgentSelect(requirePayload(message.payload, 'Conversation Agent select'));
        return;
      case BridgeMessageType.WorkflowCreate:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.createWorkflow(requirePayload(message.payload, 'Workflow create')));
        return;
      case BridgeMessageType.WorkflowUpdate:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.updateWorkflow(requirePayload(message.payload, 'Workflow update')));
        return;
      case BridgeMessageType.WorkflowDelete:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.deleteWorkflow(requirePayload(message.payload, 'Workflow delete').workflowId));
        return;
      case BridgeMessageType.ConversationWorkflowSelect: {
        const payload = requirePayload(message.payload, 'Conversation Workflow select');
        await this.runConversationCommand(payload.conversationId, async () => {
          await this.requireRow('Conversation', payload.conversationId);
          await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.selectConversationWorkflow(payload));
        });
        return;
      }
      case BridgeMessageType.ModelProfileScopeSet:
      case BridgeMessageType.ModelProfileScopeClear:
      case BridgeMessageType.ModelProfileScopeRead:
        throw new Error('ModelProfile scope commands must enter the registered observation boundary.');
      case BridgeMessageType.ToolPolicyScopeSet: {
        const payload = requirePayload(message.payload, 'Tool Policy scope set');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.setToolPolicy(payload));
        return;
      }
      case BridgeMessageType.ToolPolicyScopeClear: {
        const payload = requirePayload(message.payload, 'Tool Policy scope clear');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.clearToolPolicy(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.SkillPolicyScopeSet: {
        const payload = requirePayload(message.payload, 'Skill Policy scope set');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.setSkillPolicy(payload));
        return;
      }
      case BridgeMessageType.SkillPolicyScopeClear: {
        const payload = requirePayload(message.payload, 'Skill Policy scope clear');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.clearSkillPolicy(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.SystemPromptScopeSet: {
        const payload = requirePayload(message.payload, 'System Prompt scope set');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.setSystemPrompt(payload));
        return;
      }
      case BridgeMessageType.SystemPromptScopeClear: {
        const payload = requirePayload(message.payload, 'System Prompt scope clear');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.clearSystemPrompt(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.RuntimeContextScopeSet: {
        const payload = requirePayload(message.payload, 'Runtime Context scope set');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.setRuntimeContext(payload));
        return;
      }
      case BridgeMessageType.RuntimeContextScopeClear: {
        const payload = requirePayload(message.payload, 'Runtime Context scope clear');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.clearRuntimeContext(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.PlanReviewPolicyScopeSet: {
        const payload = requirePayload(message.payload, 'Plan Review Policy scope set');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.setPlanReviewPolicy(payload));
        return;
      }
      case BridgeMessageType.PlanReviewPolicyScopeClear: {
        const payload = requirePayload(message.payload, 'Plan Review Policy scope clear');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.clearPlanReviewPolicy(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.CheckpointPolicyScopeSet: {
        const payload = requirePayload(message.payload, 'Checkpoint Policy scope set');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.setCheckpointPolicy(payload));
        return;
      }
      case BridgeMessageType.CheckpointPolicyScopeClear: {
        const payload = requirePayload(message.payload, 'Checkpoint Policy scope clear');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.clearCheckpointPolicy(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.WorkEnvironmentPolicyScopeSet: {
        const payload = requirePayload(message.payload, 'Work Environment Policy scope set');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.setWorkEnvironmentPolicy(payload));
        return;
      }
      case BridgeMessageType.WorkEnvironmentPolicyScopeClear: {
        const payload = requirePayload(message.payload, 'Work Environment Policy scope clear');
        await this.mutateScopedConfiguration(webview, message.id, payload, () => this.product.configuration.mutations.clearWorkEnvironmentPolicy(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.WorkEnvironmentUpsert:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.upsertWorkEnvironment(requirePayload(message.payload, 'Work Environment upsert').workEnvironment));
        return;
      case BridgeMessageType.WorkEnvironmentRemove:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.removeWorkEnvironment(requirePayload(message.payload, 'Work Environment remove').workEnvironmentId));
        return;
      case BridgeMessageType.WorkEnvironmentSelect: {
        const payload = requirePayload(message.payload, 'Work Environment select');
        await this.runConversationCommand(payload.conversationId, async () => {
          await this.requireRow('Conversation', payload.conversationId);
          await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.selectConversationWorkEnvironment(payload.conversationId, payload.workEnvironmentId));
        });
        return;
      }
      case BridgeMessageType.WorkEnvironmentImportFromVscode: {
        const payload = requirePayload(message.payload, 'Work Environment import');
        const records = await readVscodeSshWorkEnvironments(payload.includeDefaultSshConfig !== false);
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.upsertWorkEnvironments(records));
        void vscode.window.showInformationMessage(`LimCode：已从 VS Code SSH 配置导入 ${records.length} 个工作环境。`);
        return;
      }
      case BridgeMessageType.SkillCatalogRefresh:
        await this.product.toolHost.refreshSkillCatalog();
        await this.broadcastConfigurationSnapshot(webview, message.id);
        return;
      case BridgeMessageType.RulesCatalogRefresh:
        await this.product.toolHost.refreshRulesCatalog();
        await this.broadcastConfigurationSnapshot(webview, message.id);
        return;
      case BridgeMessageType.RulesFileSave: {
        const payload = requirePayload(message.payload, 'Rules file save');
        await this.product.toolHost.saveRulesFile(payload.scope, payload.content);
        await this.broadcastConfigurationSnapshot(webview, message.id);
        return;
      }
      case BridgeMessageType.PlanProposalExport:
        await this.exportPlanProposal(requirePayload(message.payload, 'Plan Proposal export'));
        return;
      case BridgeMessageType.PlanProposalOpen:
        if (!this.options.openPlanProposal) throw new Error('当前 Webview 容器不能打开 Plan Proposal。');
        this.options.openPlanProposal(requirePayload(message.payload, 'Plan Proposal open'));
        return;
      case BridgeMessageType.AttachmentOpen:
        await this.openAttachment(
          webview,
          message.id,
          requirePayload(message.payload, 'Attachment open')
        );
        return;
      case BridgeMessageType.AttachmentReload:
        await this.reloadAttachment(webview, message.id, requirePayload(message.payload, 'Attachment reload'));
        return;
      case BridgeMessageType.CheckpointGitStatusGet:
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.CheckpointGitStatusSnapshot,
          channel: 'state',
          correlationId: message.id,
          payload: { status: { available: false, checkedAt: Date.now(), message: 'Checkpoint 功能当前未启用。' } }
        });
        return;
      case BridgeMessageType.CheckpointShadowStatsGet:
      case BridgeMessageType.CheckpointShadowDelete:
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.CheckpointShadowStatsSnapshot,
          channel: 'state',
          correlationId: message.id,
          payload: { stats: [] }
        });
        return;
      case BridgeMessageType.CheckpointRestore: {
        const payload = requirePayload(message.payload, 'Checkpoint restore');
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.CheckpointRestoreResult,
          channel: 'state',
          correlationId: message.id,
          payload: {
            checkpointId: payload.checkpointId,
            conversationId: payload.conversationId,
            result: { status: 'failed', message: 'Checkpoint 功能当前未启用。' }
          }
        });
        return;
      }
      case BridgeMessageType.CheckpointDiffOpen: {
        const payload = requirePayload(message.payload, 'Checkpoint Diff');
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.CheckpointDiffOpenResult,
          channel: 'state',
          correlationId: message.id,
          payload: { ...payload, status: 'failed', message: 'Checkpoint 功能当前未启用。' }
        });
        return;
      }
      case BridgeMessageType.CheckpointDismiss:
        throw new Error('Checkpoint 功能当前未启用。');
      case BridgeMessageType.TurnStart:
      case BridgeMessageType.TurnEnqueue:
        await this.handleTurnInput(
          webview,
          message.id,
          message.type,
          requirePayload(message.payload, 'Turn input')
        );
        return;
      case BridgeMessageType.TurnSteer:
        await this.handleTurnSteer(webview, message.id, requirePayload(message.payload, 'Turn steer'));
        return;
      case BridgeMessageType.TurnInterrupt:
        await this.handleInterrupt(
          webview,
          message.id,
          requirePayload(message.payload, 'Turn interrupt')
        );
        return;
      case BridgeMessageType.GuidanceEdit:
        await this.handleGuidanceEdit(webview, message.id, requirePayload(message.payload, 'Guidance edit'));
        return;
      case BridgeMessageType.GuidanceCancel:
        await this.handleGuidanceCancel(webview, message.id, requirePayload(message.payload, 'Guidance cancel'));
        return;
      case BridgeMessageType.GuidanceHold:
        await this.handleGuidanceHold(webview, message.id, requirePayload(message.payload, 'Guidance hold'));
        return;
      case BridgeMessageType.GuidanceReorder:
        await this.handleGuidanceReorder(webview, message.id, requirePayload(message.payload, 'Guidance reorder'));
        return;
      case BridgeMessageType.MessageEdit:
        await this.handleMessageEdit(webview, message.id, requirePayload(message.payload, 'Message edit'));
        return;
      case BridgeMessageType.MessageDeleteFrom:
        await this.handleMessageDelete(webview, message.id, requirePayload(message.payload, 'Message delete'));
        return;
      case BridgeMessageType.MessageRetryFrom:
        await this.handleMessageRetry(webview, message.id, requirePayload(message.payload, 'Message retry'));
        return;
      case BridgeMessageType.CompressionStart:
        await this.handleCompressionStart(
          webview,
          message.id,
          requirePayload(message.payload, 'Compression start')
        );
        return;
      case BridgeMessageType.InteractionResolve:
        await this.handleInteractionResolve(webview, message.id, requirePayload(message.payload, 'Interaction resolve'));
        return;
      case BridgeMessageType.ToolExecutionCancel:
        await this.handleToolCancel(webview, message.id, requirePayload(message.payload, 'Tool cancel'));
        return;
      case BridgeMessageType.ProcessStop:
        await this.handleProcessStop(webview, message.id, requirePayload(message.payload, 'Process stop'));
        return;
      case BridgeMessageType.ToolDiffOpen: {
        const payload = requirePayload(message.payload, 'Tool Diff');
        const result = await this.product.fileDiffs.openToolCallDiff(payload.toolCallId);
        if (result.status === 'failed') void vscode.window.showWarningMessage(`LimCode：${result.message}`);
        return;
      }
      case BridgeMessageType.ShowInfo:
        if (message.payload?.message) void vscode.window.showInformationMessage(message.payload.message);
        return;
      default:
        this.postRequestError(webview, message.type, `可靠 Runtime 尚不支持该命令：${message.type}`, message.id);
        return;
    }
  }

  /** ModelProfile-only observation boundary; register completion before provider preflight or claim. */
  private handleModelProfileScope(clientId: string, webview: vscode.Webview, message: WebviewToExtensionMessage): void {
    const input = message.payload as ModelProfileScopeReadPayload & Partial<ModelProfileScopeSetPayload>;
    let authorityId = input?.authorityId ?? '';
    let sessionId = input?.sessionId ?? '';
    const reply = (payload: ModelProfileScopeSnapshotPayload): void => this.post(webview, {
      id: randomUUID(), type: BridgeMessageType.ModelProfileScopeSnapshot, channel: 'state', correlationId: message.id, payload: { ...payload, sessionId }
    });
    const failed = (error: unknown): void => reply({ scopeKind: input?.scopeKind, ...(input?.scopeId ? { scopeId: input.scopeId } : {}), authorityId,
      sequence: 0, revision: '', profileState: 'unknown', outcome: 'uncertain', error: error instanceof Error ? error.message : String(error) });
    try {
      const mutation = this.product.configuration.mutations;
      const capture = mutation.captureModelProfileRoot(input.authorityId);
      authorityId = capture.authorityId;
      const scope = { scopeKind: input.scopeKind, ...(input.scopeId ? { scopeId: input.scopeId } : {}) };
      const sessionKey = JSON.stringify([clientId, capture.authorityId, scope]);
      let session = this.modelProfileSessions.get(sessionKey);
      if (message.type === BridgeMessageType.ModelProfileScopeRead && (input.renewSession || !input.sessionId)) {
        if (!session) {
          // Never evict another client/scope's executing read or write. Evicted idle tokens fail
          // closed; explicit reconnect must re-read under the settings mutation lock.
          if (this.modelProfileSessions.size >= 256) {
            const idle = [...this.modelProfileSessions].find(([, entry]) => entry.inFlight === 0);
            if (idle) this.modelProfileSessions.delete(idle[0]);
            else throw new Error('ModelProfile 编辑会话容量已满且操作仍在途；结果未确定，请稍后显式重新连接。');
          }
          session = { id: randomUUID(), inFlight: 0 };
          this.modelProfileSessions.set(sessionKey, session);
        } else if (input.renewSession) session.id = randomUUID();
        // Ordinary mount/read without a token reuses the session; only explicit renew fences it.
        sessionId = session.id;
      } else if (!sessionId || session?.id !== sessionId) {
        throw new Error('ModelProfile 编辑会话已失效；请显式连接当前配置根，旧草稿不会自动提交。');
      }
      const activeSession = session!;
      const fence = () => {
        if (this.modelProfileSessions.get(sessionKey)?.id !== sessionId) throw new Error('ModelProfile 编辑会话已更换；旧操作不得继续写入。');
      };
      const effective = async () => {
        if (scope.scopeKind !== 'conversation' || !scope.scopeId) return undefined;
        const links = await this.list('AgentConversationLink', { conversation_id: scope.scopeId, role: 'default' }, 2);
        if (links.length !== 1) throw new Error('当前会话没有唯一的有效 Agent。');
        return this.product.configuration.effectiveConversationModel(scope.scopeId, requireText(links[0].agent_id, 'agentId'));
      };
      const key = (requestId: string) => modelProfileCompletionKey(clientId, capture.authorityId, scope.scopeKind, scope.scopeId, requestId);
      const mutationRequestKey = message.type === BridgeMessageType.ModelProfileScopeRead ? undefined : key(requireText(message.id, 'requestId'));
      activeSession.inFlight++;
      if (message.type === BridgeMessageType.ModelProfileScopeRead) {
        void (async () => {
          if (input.afterRequestId) await this.modelProfileCompletions.after(key(input.afterRequestId));
          const result = await mutation.readModelProfileScope(capture, input, effective, fence);
          reply({ ...result, ...(input.afterRequestId ? { afterRequestId: input.afterRequestId } : {}) });
        })().catch(failed).finally(() => { activeSession.inFlight--; });
        return;
      }
      const operation = this.modelProfileCompletions.register(mutationRequestKey!, async () => {
        const work = async () => {
          if (!input.expectedRevision || !input.authorityId) throw new Error('ModelProfile UI 保存必须带已确认 revision/authority；未执行写入。');
          if (input.providerConfigId) await this.product.configuration.providerConfig(input.providerConfigId);
          const write = () => mutation.writeModelProfileScope(capture, input as ModelProfileScopeSetPayload, message.type === BridgeMessageType.ModelProfileScopeClear, effective, fence);
          return scope.scopeKind === 'conversation' && scope.scopeId ? this.runConversationCommand(scope.scopeId, write) : write();
        };
        // Registering above is synchronous. The existing configuration queue now includes preflight.
        const queued = this.configurationMutationQueue.then(work, work);
        this.configurationMutationQueue = queued.then(() => undefined, () => undefined);
        return queued;
      });
      void operation.then(result => {
        reply(result);
        // The correlated reply is the only save acknowledgement. Peers receive a bounded
        // scope invalidation, never the writer's session token or a full configuration catalog.
        this.options.broadcast?.({ id: randomUUID(), type: BridgeMessageType.ModelProfileScopeSnapshot,
          channel: 'state', payload: result });
      }, failed).finally(() => { activeSession.inFlight--; });
    } catch (error) { failed(error); }
  }

  private async postConfigurationSnapshot(webview: vscode.Webview, correlationId?: string): Promise<void> {
    this.post(webview, await this.configurationSnapshot(correlationId));
  }

  public async refreshConfiguration(): Promise<void> {
    this.options.broadcast?.(await this.configurationSnapshot());
  }

  private async broadcastConfigurationSnapshot(webview: vscode.Webview, correlationId?: string): Promise<void> {
    this.broadcastOrPost(webview, await this.configurationSnapshot(correlationId));
  }

  private async configurationSnapshot(correlationId?: string): Promise<unknown> {
    const state = await this.product.configuration.configurationClientState();
    state.toolDefinitions = this.product.toolHost.definitionRecords();
    state.mcpToolSources = this.product.toolHost.mcp.sourceRecords();
    state.skillDefinitions = this.product.toolHost.skillDefinitions();
    state.ruleFiles = this.product.toolHost.ruleFiles();
    return {
      id: randomUUID(),
      type: BridgeMessageType.ConfigurationSnapshot,
      channel: 'state',
      scope: { kind: 'global' },
      correlationId,
      payload: {
        state,
        loadedAt: Date.now()
      }
    };
  }

  private async mutateConfiguration(
    webview: vscode.Webview,
    correlationId: string | undefined,
    operation: () => Promise<unknown>
  ): Promise<void> {
    const queued = this.configurationMutationQueue.then(
      async () => { await operation(); },
      async () => { await operation(); }
    );
    this.configurationMutationQueue = queued.catch(() => undefined);
    await queued;
    await this.broadcastConfigurationSnapshot(webview, correlationId);
  }

  /** Conversation-scoped configuration binds to a Conversation the same way turns do. */
  private async mutateScopedConfiguration(
    webview: vscode.Webview,
    correlationId: string | undefined,
    scope: { scopeKind: string; scopeId?: string },
    operation: () => Promise<unknown>
  ): Promise<void> {
    const conversationId = scope.scopeKind === 'conversation' ? scope.scopeId?.trim() : undefined;
    if (conversationId) {
      await this.runConversationCommand(conversationId, () => this.mutateConfiguration(webview, correlationId, operation));
      return;
    }
    await this.mutateConfiguration(webview, correlationId, operation);
  }

  private postProjectFolders(webview: vscode.Webview, correlationId?: string): void {
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.ProjectFoldersSnapshot,
      channel: 'state',
      correlationId,
      payload: {
        folders: (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
          uri: folder.uri.toString(),
          name: folder.name,
          index
        }))
      }
    });
  }

  private async postGlobalSettings(
    webview: vscode.Webview,
    payload: GlobalSettingsGetPayload,
    correlationId?: string
  ): Promise<void> {
    const stored = await this.product.configuration.loadGlobalSettings(payload.section);
    this.post(webview, this.globalSettingsSnapshot(stored, correlationId));
  }

  private async updateGlobalSettings(
    webview: vscode.Webview,
    payload: GlobalSettingsUpdatePayload,
    correlationId?: string
  ): Promise<void> {
    let stored: Awaited<ReturnType<VscodeReliableKernelProductRuntime['configuration']['loadGlobalSettings']>>;
    try {
      stored = await this.product.configuration.saveGlobalSettings(
        payload.section,
        payload.settings,
        payload.expectedRevision
      );
    } catch (error) {
      if (!isSettingsRevisionConflictError(error)) throw error;
      const latest = await this.product.configuration.loadGlobalSettings(payload.section);
      this.broadcastOrPost(webview, this.globalSettingsSnapshot(latest));
      if (payload.section === 'common') {
        await this.applyCommonProxyRuntime(latest.settings as GlobalSettingsRecord)
          .catch((proxyError) => console.warn('[LimCode] Failed to apply latest common proxy settings after conflict.', proxyError));
      }
      this.postRequestError(
        webview,
        BridgeMessageType.GlobalSettingsUpdate,
        error.message,
        correlationId,
        { section: payload.section, code: 'settings_revision_conflict', actualRevision: error.actualRevision }
      );
      return;
    }
    const snapshot = this.globalSettingsSnapshot(stored, correlationId);
    this.broadcastOrPost(webview, snapshot);
    if (payload.section === 'common') {
      await this.applyCommonProxyRuntime(stored.settings as GlobalSettingsRecord);
    }
    if (payload.section === 'mcpServers') {
      await this.product.toolHost.mcp.refreshFromSettings({ discover: true });
    }
  }

  private async applyCommonProxyRuntime(settings: GlobalSettingsRecord): Promise<void> {
    // shell 覆盖开关变更即时生效；LLM 链路本身按请求读取代理设置。
    const proxy = proxyForShellAndMcp(settings);
    const proxyChanged = currentProxyEnvironment() !== proxy;
    applyProxyEnvironment(proxy);
    // 代理地址或 shell/MCP 开关变化时重建 MCP 连接；存量连接无法热切换 transport。
    if (proxyChanged) await this.product.toolHost.mcp.refreshFromSettings({ discover: true });
  }

  private globalSettingsSnapshot(
    stored: Awaited<ReturnType<VscodeReliableKernelProductRuntime['configuration']['loadGlobalSettings']>>,
    correlationId?: string
  ): unknown {
    return {
      id: randomUUID(),
      type: BridgeMessageType.GlobalSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'global', id: stored.section },
      correlationId,
      payload: stored
    };
  }

  private async postConversationSettings(
    webview: vscode.Webview,
    payload: ConversationSettingsGetPayload,
    correlationId?: string
  ): Promise<void> {
    const stored = await this.readConversationSettings(payload.conversationId, payload.section, true);
    if (!stored) {
      console.info(`[LimCode] Ignored stale Conversation settings request: ${payload.conversationId}`);
      this.postRequestError(
        webview,
        BridgeMessageType.ConversationSettingsGet,
        '该对话已被删除或不再存在。',
        correlationId,
        { code: 'stale_conversation', conversationId: payload.conversationId }
      );
      return;
    }
    this.post(webview, this.conversationSettingsSnapshot(stored, correlationId));
  }

  private async updateConversationSettings(
    webview: vscode.Webview,
    payload: ConversationSettingsUpdatePayload,
    correlationId?: string
  ): Promise<void> {
    const conversationId = payload.settings.conversationId?.trim();
    if (!conversationId) throw new TypeError('Conversation settings 缺少 conversationId。');
    if (payload.section !== 'common') {
      throw new Error('对话模型选择只由 ModelProfile 控制；ConversationSettings.llm 已停用。');
    }
    const name = 'name' in payload.settings ? payload.settings.name.trim() : '';
    if (!name) throw new TypeError('Conversation 名称不能为空。');
    await this.runConversationCommand(conversationId, async () => {
      await this.requireRow('Conversation', conversationId);
      await this.product.application.database.transaction([
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, {
          title: name,
          updated_at: new Date().toISOString()
        })
      ]);
    });
    const stored = await this.readConversationSettings(conversationId, payload.section);
    if (!stored) throw new Error(`Conversation ${conversationId} 不存在。`);
    const snapshot = this.conversationSettingsSnapshot(stored, correlationId);
    // 会话设置只同步当前绑定该会话的面板；缺少定向通道时只回请求方，绝不退化为全局广播。
    if (this.options.postToConversation) this.options.postToConversation(conversationId, snapshot);
    else this.post(webview, snapshot);
  }

  private async readConversationSettings(
    conversationId: string,
    section: ConversationSettingsGetPayload['section'],
    allowMissing = false
  ): Promise<{
    conversationId: string;
    section: ConversationSettingsGetPayload['section'];
    settings: unknown;
    filePath: string;
  } | undefined> {
    const conversation = allowMissing
      ? await this.maybeRow('Conversation', conversationId)
      : await this.requireRow('Conversation', conversationId);
    if (!conversation) return undefined;
    if (section !== 'common') {
      throw new Error('对话模型选择只由 ModelProfile 控制；ConversationSettings.llm 已停用。');
    }
    return {
      conversationId,
      section,
      settings: { conversationId, name: String(conversation.title) },
      filePath: ''
    };
  }

  private conversationSettingsSnapshot(
    stored: { conversationId: string; section: string; settings: unknown; filePath: string },
    correlationId?: string
  ): unknown {
    return {
      id: randomUUID(),
      type: BridgeMessageType.ConversationSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'conversation', id: stored.conversationId },
      correlationId,
      payload: stored
    };
  }

  private async postProviderModels(
    webview: vscode.Webview,
    payload: LlmProviderModelsGetPayload,
    correlationId?: string
  ): Promise<void> {
    const models = await this.product.providerRegistry.listModels(payload.config);
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.LlmProviderModelsSnapshot,
      channel: 'state',
      correlationId,
      payload: {
        configId: payload.config.id,
        provider: payload.config.provider,
        baseUrl: payload.config.baseUrl,
        models
      }
    });
  }

  private async postFsStats(webview: vscode.Webview, paths: string[], correlationId?: string): Promise<void> {
    const results = await Promise.all(paths.map(async (inputPath) => {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(inputPath));
        return {
          path: inputPath,
          isDirectory: (stat.type & vscode.FileType.Directory) !== 0,
          exists: true
        };
      } catch {
        return { path: inputPath, isDirectory: false, exists: false };
      }
    }));
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.FsStatResult,
      channel: 'state',
      correlationId,
      payload: { results }
    });
  }

  private async handleConversationAgentSelect(payload: ConversationAgentSelectPayload): Promise<void> {
    const conversationId = requireText(payload.conversationId, 'conversationId');
    const agentId = requireText(payload.agentId, 'agentId');
    await this.runConversationCommand(conversationId, async () => {
      await this.requireRow('Conversation', conversationId);
      await this.product.configuration.resolveAgent({ agentId });
      const links = await this.list('AgentConversationLink', { conversation_id: conversationId, role: 'default' }, 2);
      if (links.length !== 1) throw new Error('Conversation 缺少唯一默认 Agent Link。');
      await this.product.application.database.transaction([
        DOMAIN_REPOSITORIES.domain('AgentConversationLink').update(String(links[0].id), {
          agent_id: agentId,
          updated_at: new Date().toISOString()
        })
      ]);
    });
  }

  private async exportPlanProposal(payload: PlanProposalExportPayload): Promise<void> {
    const markdown = payload.markdown;
    if (typeof markdown !== 'string') throw new TypeError('Plan Proposal markdown 必须是字符串。');
    const suggested = sanitizeFileName(payload.suggestedFileName ?? 'plan.md');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, suggested)
        : vscode.Uri.file(suggested),
      filters: { Markdown: ['md'], Text: ['txt'] },
      saveLabel: '导出计划'
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'));
  }

  private async openAttachment(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: AttachmentOpenPayload
  ): Promise<void> {
    try {
      let uri: vscode.Uri;
      if (payload.sourcePath?.trim()) {
        uri = vscode.Uri.file(payload.sourcePath.trim());
      } else {
        const attachmentId = payload.attachmentId?.trim();
        let data: string;
        let attachmentKey: string;
        let attachmentName: string | undefined;
        let attachmentMimeType: string;
        if (attachmentId) {
          const part = await this.product.application.attachments.resolveInlineData(attachmentId);
          if (typeof part.inlineData.data !== 'string') throw new Error('CAS 附件没有可读取的正文。');
          data = part.inlineData.data;
          attachmentKey = attachmentId;
          attachmentName = part.inlineData.name ?? payload.name;
          attachmentMimeType = part.inlineData.mimeType || payload.mimeType || 'application/octet-stream';
        } else if (payload.data) {
          const bytes = decodeInlineAttachmentBase64(payload.data);
          data = bytes.toString('base64');
          attachmentKey = `embedded-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`;
          attachmentName = payload.name;
          attachmentMimeType = payload.mimeType?.trim() || 'application/octet-stream';
        } else {
          throw new TypeError('Attachment open 缺少 attachmentId、sourcePath 或内联数据。');
        }
        const fileName = safeAttachmentFileName(
          attachmentKey,
          attachmentName,
          attachmentMimeType
        );
        const openedRoot = path.join(
          this.product.application.database.binding.paths.dataRootPath,
          'opened-attachments'
        );
        await fs.mkdir(openedRoot, { recursive: true });
        const targetPath = path.join(openedRoot, fileName);
        await fs.writeFile(targetPath, Buffer.from(data, 'base64'));
        uri = vscode.Uri.file(targetPath);
      }
      await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
      this.post(webview, {
        id: randomUUID(),
        type: BridgeMessageType.AttachmentOpenResult,
        channel: 'command',
        correlationId,
        payload: { request: attachmentOpenRequest(payload), status: 'opened' }
      });
    } catch (error) {
      const message = errorMessage(error);
      this.post(webview, {
        id: randomUUID(),
        type: BridgeMessageType.AttachmentOpenResult,
        channel: 'command',
        correlationId,
        payload: { request: attachmentOpenRequest(payload), status: 'failed', error: message }
      });
      void vscode.window.showWarningMessage(`LimCode：${message}`);
    }
  }

  private async reloadAttachment(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: AttachmentReloadPayload
  ): Promise<void> {
    try {
      let part;
      if (payload.attachmentId?.trim()) {
        part = await this.product.application.attachments.resolveInlineData(payload.attachmentId.trim());
      } else if (payload.sourcePath?.trim()) {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(payload.sourcePath.trim()));
        part = {
          inlineData: {
            data: Buffer.from(bytes).toString('base64'),
            mimeType: payload.mimeType?.trim() || 'application/octet-stream',
            ...(payload.name?.trim() ? { name: payload.name.trim() } : {}),
            sourcePath: payload.sourcePath.trim(),
            storage: 'localPath' as const,
            status: 'available' as const,
            sizeBytes: bytes.byteLength
          }
        };
      } else {
        throw new TypeError('Attachment reload 缺少 attachmentId 或 sourcePath。');
      }
      this.post(webview, {
        id: randomUUID(),
        type: BridgeMessageType.AttachmentReloadResult,
        channel: 'state',
        correlationId,
        payload: { request: payload, part, status: 'available' }
      });
    } catch (error) {
      const message = errorMessage(error);
      this.post(webview, {
        id: randomUUID(),
        type: BridgeMessageType.AttachmentReloadResult,
        channel: 'state',
        correlationId,
        payload: {
          request: payload,
          status: isFileNotFoundError(error) ? 'missing' : 'failed',
          error: message
        }
      });
    }
  }

  private async handleTurnInput(
    webview: vscode.Webview,
    correlationId: string,
    requestType: BridgeMessageType.TurnStart | BridgeMessageType.TurnEnqueue,
    payload: TurnStartPayload
  ): Promise<void> {
    await this.runConversationCommand(payload.conversationId, () =>
      this.handleTurnInputUnderOwnership(webview, correlationId, requestType, payload));
  }

  private async handleTurnInputUnderOwnership(
    webview: vscode.Webview,
    correlationId: string,
    requestType: BridgeMessageType.TurnStart | BridgeMessageType.TurnEnqueue,
    payload: TurnStartPayload
  ): Promise<void> {
    await this.product.ensureCapabilitiesReady();
    const childExecutionId = await this.childExecutionIdForConversation(payload.conversationId);
    const childContent = childExecutionId
      ? serializeMessagePayload(payload.text, payload.content)
      : undefined;
    const result = childExecutionId
      ? await this.product.childAgents.inputFromConversation({
          commandId: payload.command.commandId,
          childExecutionId,
          conversationId: payload.conversationId,
          content: childContent!.value,
          contentType: childContent!.contentType,
          ...(payload.agentId?.trim() ? { executorAgentId: payload.agentId.trim() } : {}),
          ...(payload.model ? { modelOverride: payload.model } : {})
        })
      : await this.product.conversations.input({
          commandId: payload.command.commandId,
          conversationId: payload.conversationId,
          ...(payload.text ? { text: payload.text } : {}),
          ...(payload.content ? { content: payload.content } : {}),
          ...(payload.agentId?.trim() ? { agentId: payload.agentId.trim() } : {}),
          ...(payload.model ? { model: payload.model } : {})
        });
    this.postTurnInputResult(webview, correlationId, {
      commandId: payload.command.commandId,
      conversationId: payload.conversationId,
      requestType,
      status: result.deduplicated ? 'replayed' : result.admitted ? 'accepted' : 'queued',
      admitted: result.admitted === true,
      deduplicated: result.deduplicated,
      ...(result.intentId ? { intentId: result.intentId } : {}),
      ...(result.turnId ? { turnId: result.turnId } : {}),
      ...(result.commitSeq ? { commitSeq: result.commitSeq } : {})
    });
  }

  private async handleTurnSteer(
    webview: vscode.Webview,
    correlationId: string,
    payload: TurnSteerPayload
  ): Promise<void> {
    const conversationId = requireText(payload.conversationId, 'conversationId');
    const provider = this.product.application.modelProvider;
    if (payload.action === 'status') {
      this.post(webview, {
        id: randomUUID(),
        type: BridgeMessageType.TurnSteerResult,
        channel: 'control',
        correlationId,
        payload: {
          conversationId,
          ...(payload.command?.commandId ? { commandId: payload.command.commandId } : {}),
          receipts: await provider.steeringReceipts(conversationId)
        }
      });
      return;
    }
    const leaseEpoch = payload.leaseEpoch;
    if (typeof leaseEpoch !== 'number' || !Number.isSafeInteger(leaseEpoch) || leaseEpoch <= 0) {
      throw new TypeError('Turn steer 缺少有效的 ExecutionLease generation。');
    }
    await this.product.ensureCapabilitiesReady();
    const receipt = await provider.steer({
      commandId: requireText(payload.command.commandId, 'commandId'),
      conversationId,
      turnId: requireText(payload.turnId, 'turnId'),
      leaseEpoch: BigInt(leaseEpoch),
      content: requirePayload(payload.content, 'Turn steer content')
    });
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.TurnSteerResult,
      channel: 'control',
      correlationId,
      payload: { conversationId, commandId: payload.command.commandId, receipts: [receipt] }
    });
  }

  private postTurnInputResult(
    webview: vscode.Webview,
    correlationId: string,
    payload: TurnInputResultPayload
  ): void {
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.TurnInputResult,
      channel: 'control',
      correlationId,
      payload
    });
  }

  private async handleGuidanceEdit(
    webview: vscode.Webview,
    correlationId: string,
    payload: GuidanceEditPayload
  ): Promise<void> {
    const result = await this.runConversationCommand(payload.conversationId, () =>
      this.product.conversations.editGuidance({
        commandId: payload.command.commandId,
        conversationId: payload.conversationId,
        intentId: payload.intentId,
        expectedRevisionSeq: payload.expectedRevisionSeq,
        text: payload.text
      }));
    this.postGuidanceControlResult(webview, correlationId, {
      commandId: payload.command.commandId,
      conversationId: payload.conversationId,
      action: 'edit',
      status: result.deduplicated ? 'replayed' : 'accepted',
      intentId: payload.intentId,
      ...(result.commitSeq ? { commitSeq: result.commitSeq } : {})
    });
  }

  private async handleGuidanceCancel(
    webview: vscode.Webview,
    correlationId: string,
    payload: GuidanceCancelPayload
  ): Promise<void> {
    const result = await this.runConversationCommand(payload.conversationId, () =>
      this.product.conversations.cancelGuidance({
        commandId: payload.command.commandId,
        conversationId: payload.conversationId,
        intentId: payload.intentId,
        expectedRevisionSeq: payload.expectedRevisionSeq
      }));
    this.postGuidanceControlResult(webview, correlationId, {
      commandId: payload.command.commandId,
      conversationId: payload.conversationId,
      action: 'cancel',
      status: result.deduplicated ? 'replayed' : 'accepted',
      intentId: payload.intentId,
      ...(result.commitSeq ? { commitSeq: result.commitSeq } : {})
    });
  }

  private async handleGuidanceHold(
    webview: vscode.Webview,
    correlationId: string,
    payload: GuidanceHoldPayload
  ): Promise<void> {
    const result = await this.runConversationCommand(payload.conversationId, () =>
      this.product.conversations.setGuidanceHold({
        commandId: payload.command.commandId,
        conversationId: payload.conversationId,
        intentId: payload.intentId,
        expectedRevisionSeq: payload.expectedRevisionSeq,
        hold: payload.hold
      }));
    this.postGuidanceControlResult(webview, correlationId, {
      commandId: payload.command.commandId,
      conversationId: payload.conversationId,
      action: 'hold',
      status: result.deduplicated ? 'replayed' : 'accepted',
      intentId: payload.intentId,
      ...(result.commitSeq ? { commitSeq: result.commitSeq } : {})
    });
  }

  private async handleGuidanceReorder(
    webview: vscode.Webview,
    correlationId: string,
    payload: GuidanceReorderPayload
  ): Promise<void> {
    const result = await this.runConversationCommand(payload.conversationId, () =>
      this.product.conversations.reorderGuidance({
        commandId: payload.command.commandId,
        conversationId: payload.conversationId,
        items: payload.items
      }));
    this.postGuidanceControlResult(webview, correlationId, {
      commandId: payload.command.commandId,
      conversationId: payload.conversationId,
      action: 'reorder',
      status: result.deduplicated ? 'replayed' : 'accepted',
      ...(result.commitSeq ? { commitSeq: result.commitSeq } : {})
    });
  }

  private postGuidanceControlResult(
    webview: vscode.Webview,
    correlationId: string,
    payload: GuidanceControlResultPayload
  ): void {
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.GuidanceControlResult,
      channel: 'control',
      correlationId,
      payload
    });
  }

  private async handleInterrupt(
    webview: vscode.Webview,
    correlationId: string,
    payload: TurnInterruptPayload
  ): Promise<void> {
    if (!Number.isSafeInteger(payload.leaseEpoch) || payload.leaseEpoch < 0) {
      throw new TypeError('Turn interrupt 缺少有效的 ExecutionLease generation。');
    }
    await this.runConversationCommand(payload.conversationId, () =>
      this.handleInterruptUnderOwnership(webview, correlationId, payload));
  }

  private async handleInterruptUnderOwnership(
    webview: vscode.Webview,
    correlationId: string,
    payload: TurnInterruptPayload
  ): Promise<void> {
    const turn = await this.maybeRow('Turn', payload.turnId);
    if (!turn) {
      console.info(`[LimCode] Treated stale Turn interrupt as already terminal: ${payload.turnId}`);
      this.post(webview, {
        id: randomUUID(),
        type: BridgeMessageType.TurnInterruptResult,
        channel: 'control',
        correlationId,
        payload: {
          conversationId: payload.conversationId,
          turnId: payload.turnId,
          status: 'already_terminal',
          cascadeChildAgents: payload.cascadeChildAgents === true
        }
      });
      return;
    }
    if (turn.conversation_id !== payload.conversationId) {
      throw new Error('Turn interrupt 目标不属于当前 Conversation。');
    }
    const leases = await this.list('ExecutionLease', { turn_id: payload.turnId }, 2);
    if (
      turn.status === 'active'
      && payload.leaseEpoch > 0
      && (leases.length !== 1 || leases[0].generation !== BigInt(payload.leaseEpoch))
    ) {
      throw new Error('Turn interrupt 目标的 ExecutionLease generation 已被替换，请刷新后重试。');
    }
    const childMemberships = await this.list('ChildExecutionTurnLink', { turn_id: payload.turnId }, 2);
    if (childMemberships.length > 1) throw new Error('Turn 存在多个 ChildExecution 调度归属。');
    const childExecutionId = childMemberships[0]
      ? requireText(childMemberships[0].child_execution_id, 'ChildExecutionTurnLink.child_execution_id')
      : undefined;
    const interruptInput = {
      commandId: payload.command.commandId,
      conversationId: payload.conversationId,
      turnId: payload.turnId,
      ...(payload.leaseEpoch > 0 ? { expectedLeaseGeneration: String(payload.leaseEpoch) } : {}),
      reason: payload.cascadeChildAgents
        ? '用户请求中断当前 Turn 及其子执行。'
        : '用户请求中断当前 Turn。'
    };
    const result = childExecutionId
      ? await this.product.childAgents.interruptFromConversation({
          ...interruptInput,
          childExecutionId
        })
      : await this.product.conversations.interrupt(interruptInput);
    if (payload.cascadeChildAgents) {
      const children = await this.listAll('ChildExecutionParentLink', {
        parent_turn_id: payload.turnId
      });
      for (const link of children) {
        await this.product.childAgents.interruptSubtree({
          sourceKey: `${payload.command.commandId}:child:${String(link.child_execution_id)}`,
          childExecutionId: String(link.child_execution_id),
          reason: 'parent_turn_interrupted'
        });
        // interruptSubtree is the cross-Host authority. The owning child scheduler observes its
        // durable PendingTurnInput and is the only process allowed to touch local AbortControllers
        // under that child Turn's exact ExecutionLease generation.
      }
    }
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.TurnInterruptResult,
      channel: 'control',
      correlationId,
      payload: {
        conversationId: payload.conversationId,
        turnId: payload.turnId,
        status: result.ignoredBecauseTerminal
          ? 'already_terminal'
          : result.coalesced ? 'coalesced' : 'accepted',
        ...(result.pendingTurnInputId ? { pendingTurnInputId: result.pendingTurnInputId } : {}),
        cascadeChildAgents: payload.cascadeChildAgents === true
      }
    });
  }

  private async handleMessageEdit(
    webview: vscode.Webview,
    correlationId: string,
    payload: MessageEditPayload
  ): Promise<void> {
    await this.runConversationCommand(payload.conversationId, () =>
      this.handleMessageEditUnderOwnership(webview, correlationId, payload));
  }

  private async handleMessageEditUnderOwnership(
    webview: vscode.Webview,
    correlationId: string,
    payload: MessageEditPayload
  ): Promise<void> {
    try {
      let result;
      if (payload.runAfterEdit) {
        await this.product.ensureCapabilitiesReady();
        const childExecutionId = await this.childExecutionIdForConversation(payload.conversationId);
        if (childExecutionId) {
          const content = serializeMessagePayload(payload.text, payload.content);
          result = await this.product.childAgents.editAndRunFromConversation({
            commandId: payload.command.commandId,
            childExecutionId,
            conversationId: payload.conversationId,
            messageId: payload.messageId,
            expectedRevisionId: payload.expectedRevisionId,
            content: content.value,
            contentType: content.contentType,
            deleteFollowing: payload.deleteFollowing === true,
            ...(payload.agentId?.trim() ? { executorAgentId: payload.agentId.trim() } : {}),
            ...(payload.model ? { modelOverride: payload.model } : {})
          });
        } else {
          result = await this.product.conversations.editAndRun({
            commandId: payload.command.commandId,
            conversationId: payload.conversationId,
            messageId: payload.messageId,
            expectedRevisionId: payload.expectedRevisionId,
            text: payload.text,
            content: payload.content,
            deleteFollowing: payload.deleteFollowing === true,
            ...(payload.agentId ? { agentId: payload.agentId } : {}),
            ...(payload.model ? { model: payload.model } : {})
          });
        }
      } else {
        const content = serializeMessagePayload(payload.text, payload.content);
        result = await this.product.application.turns.edit({
          source: { kind: 'command', key: payload.command.commandId },
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          expectedRevisionId: payload.expectedRevisionId,
          content: content.value,
          contentType: content.contentType,
          deleteFollowing: payload.deleteFollowing === true
        });
      }
      this.postConversationActionResult(webview, correlationId, {
        action: 'edit',
        conversationId: payload.conversationId,
        commandId: payload.command.commandId,
        target: { kind: 'message', messageId: payload.messageId },
        status: result.deduplicated ? 'already_applied' : 'accepted',
        ...(result.turnId ? { turnId: result.turnId } : {}),
        ...(result.messageRevisionId ? { messageRevisionId: result.messageRevisionId } : {})
      });
    } catch (error) {
      if (!isConversationHistoryBusyError(error)) throw error;
      this.postConversationActionResult(webview, correlationId, {
        action: 'edit',
        conversationId: payload.conversationId,
        commandId: payload.command.commandId,
        target: { kind: 'message', messageId: payload.messageId },
        status: 'busy'
      });
    }
  }

  private async handleMessageDelete(
    webview: vscode.Webview,
    correlationId: string,
    payload: MessageDeleteFromPayload
  ): Promise<void> {
    await this.runConversationCommand(payload.conversationId, () =>
      this.handleMessageDeleteUnderOwnership(webview, correlationId, payload));
  }

  private async handleMessageDeleteUnderOwnership(
    webview: vscode.Webview,
    correlationId: string,
    payload: MessageDeleteFromPayload
  ): Promise<void> {
    try {
      const result = await this.product.application.turns.delete({
        source: { kind: 'command', key: payload.command.commandId },
        conversationId: payload.conversationId,
        messageId: payload.messageId
      });
      this.postConversationActionResult(webview, correlationId, {
        action: 'delete',
        conversationId: payload.conversationId,
        commandId: payload.command.commandId,
        target: { kind: 'message', messageId: payload.messageId },
        status: result.deduplicated ? 'already_applied' : 'accepted'
      });
    } catch (error) {
      if (!isConversationHistoryBusyError(error)) throw error;
      this.postConversationActionResult(webview, correlationId, {
        action: 'delete',
        conversationId: payload.conversationId,
        commandId: payload.command.commandId,
        target: { kind: 'message', messageId: payload.messageId },
        status: 'busy'
      });
    }
  }

  private async handleMessageRetry(
    webview: vscode.Webview,
    correlationId: string,
    payload: MessageRetryFromPayload
  ): Promise<void> {
    await this.runConversationCommand(payload.conversationId, () =>
      this.handleMessageRetryUnderOwnership(webview, correlationId, payload));
  }

  private async handleMessageRetryUnderOwnership(
    webview: vscode.Webview,
    correlationId: string,
    payload: MessageRetryFromPayload
  ): Promise<void> {
    try {
      await this.product.ensureCapabilitiesReady();
      const sourceTurnId = await this.turnIdForRetryTarget(payload.conversationId, payload.target);
      const childExecutionId = await this.childExecutionIdForConversation(payload.conversationId);
      const result = childExecutionId
        ? await this.product.childAgents.retryFromConversation({
            commandId: payload.command.commandId,
            childExecutionId,
            conversationId: payload.conversationId,
            sourceTurnId,
            target: payload.target,
            ...('expectedRevisionId' in payload
              ? { expectedMessageRevisionId: payload.expectedRevisionId }
              : {}),
            ...(payload.agentId?.trim() ? { executorAgentId: payload.agentId.trim() } : {}),
            ...(payload.model ? { modelOverride: payload.model } : {})
          })
        : await this.product.conversations.retry({
            commandId: payload.command.commandId,
            conversationId: payload.conversationId,
            sourceTurnId,
            target: payload.target,
            ...('expectedRevisionId' in payload
              ? { expectedMessageRevisionId: payload.expectedRevisionId }
              : {}),
            ...(payload.agentId ? { agentId: payload.agentId } : {}),
            ...(payload.model ? { model: payload.model } : {})
          });
      this.postConversationActionResult(webview, correlationId, {
        action: 'retry',
        conversationId: payload.conversationId,
        commandId: payload.command.commandId,
        target: payload.target,
        status: result.deduplicated ? 'already_applied' : 'accepted',
        ...(result.turnId ? { turnId: result.turnId } : {})
      });
    } catch (error) {
      if (!isConversationHistoryBusyError(error)) throw error;
      this.postConversationActionResult(webview, correlationId, {
        action: 'retry',
        conversationId: payload.conversationId,
        commandId: payload.command.commandId,
        target: payload.target,
        status: 'busy'
      });
    }
  }

  private postConversationActionResult(
    webview: vscode.Webview,
    correlationId: string,
    payload: ConversationActionResultPayload
  ): void {
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.ConversationActionResult,
      channel: 'state',
      correlationId,
      payload
    });
  }

  private postConversationForkResult(
    webview: vscode.Webview,
    correlationId: string,
    payload: ConversationForkResultPayload
  ): void {
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.ConversationForkResult,
      channel: 'state',
      correlationId,
      payload
    });
  }

  private async handleCompressionStart(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: CompressionStartPayload
  ): Promise<void> {
    const conversationId = requireText(payload.conversationId, 'conversationId');
    await this.runConversationCommand(conversationId, () =>
      this.handleCompressionStartUnderOwnership(webview, correlationId, payload, conversationId));
  }

  private async handleCompressionStartUnderOwnership(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: CompressionStartPayload,
    conversationId: string
  ): Promise<void> {
    const commandId = requireText(payload.command?.commandId, 'compression commandId');
    await this.requireRow('Conversation', conversationId);
    const replay = await this.product.conversations.inspectManualCompression?.({
      commandId,
      conversationId,
      target: payload.target
    });
    if (replay) {
      const replayRejected = replay.terminal
        && (
          replay.terminal.status !== 'completed'
          || replay.terminal.reason !== 'manual_context_compression_completed'
        );
      this.postCompressionCommandResult(webview, correlationId, {
        conversationId,
        commandId,
        target: payload.target,
        turnId: replay.turnId,
        status: replay.inProgress ? 'in_progress' : replayRejected ? 'rejected' : 'already_applied',
        ...(replayRejected ? { reasonCode: replay.terminal!.reason } : {})
      });
      return;
    }
    await this.settingsSaveBarrier.flush();
    await this.configurationMutationQueue;
    const activeTurns = await this.list('Turn', { conversation_id: conversationId, status: 'active' }, 2);
    if (activeTurns.length > 0) {
      this.postCompressionCommandResult(webview, correlationId, {
        conversationId,
        commandId,
        target: payload.target,
        status: 'busy',
        reasonCode: 'conversation-active'
      });
      return;
    }
    const heads = await this.list('ConversationContextHeadLink', { conversation_id: conversationId }, 2);
    if (heads.length !== 1) throw new Error('Conversation 缺少唯一当前 Context head。');
    const rootId = requireText(heads[0].root_id, 'ConversationContextHeadLink.root_id');
    const structure = await this.product.application.context.materializeStructure(rootId);
    if (structure.records.length === 0) throw new Error('当前上下文为空，无法压缩。');

    let compressSegmentCount: number;
    if (payload.target.kind === 'current_head') {
      const frozenRootId = requireText(payload.target.expectedRootId, 'compression target.expectedRootId');
      const frozenRoot = await this.requireRow('ContextSequenceRoot', frozenRootId);
      if (frozenRoot.conversation_id !== conversationId) {
        throw new Error('压缩目标 Context root 不属于当前 Conversation。');
      }
      if (frozenRootId === rootId) {
        compressSegmentCount = structure.records.length;
      } else {
        const frozen = await this.product.application.context.materializeStructure(frozenRootId);
        const prefixMatches = frozen.records.every((record, index) =>
          String(record.segment.id) === String(structure.records[index]?.segment.id)
        );
        if (!prefixMatches || frozen.records.length === 0) {
          throw new Error('压缩目标 Context root 已不再是当前上下文的完整前缀。');
        }
        compressSegmentCount = frozen.records.length;
      }
    } else {
      const messageId = requireText(payload.target.messageId, 'compression target.messageId');
      const memberships = await this.list('MessagePartOfConversation', {
        conversation_id: conversationId,
        message_id: messageId
      }, 2);
      if (memberships.length !== 1) throw new Error('压缩目标 Message 不属于当前 Conversation。');
      const current = await this.list('MessageCurrentRevisionLink', { message_id: messageId }, 2);
      if (current.length !== 1) throw new Error('压缩目标 Message 缺少唯一当前 Revision。');
      const revisionId = requireText(current[0].revision_id, 'MessageCurrentRevisionLink.revision_id');
      if (revisionId !== requireText(payload.target.expectedRevisionId, 'compression target.expectedRevisionId')) {
        throw new Error('压缩目标 MessageRevision 已变化，请重新选择压缩边界。');
      }
      const revision = await this.requireRow('MessageRevision', revisionId);
      const sources = await this.list('ContextSegmentSource', {
        source_kind: 'message_revision',
        source_id: revisionId
      }, 2);
      if (sources.length !== 1) {
        throw new Error('压缩目标已不在当前 Context lineage，或其 Context source 不唯一。');
      }
      const targetSegmentId = requireText(sources[0].segment_id, 'ContextSegmentSource.segment_id');
      const targetIndex = structure.records.findIndex((record) => record.segment.id === targetSegmentId);
      if (targetIndex < 0) throw new Error('压缩目标不在当前 finite Context root 中。');
      compressSegmentCount = targetIndex + 1;
      // A model Message may own a completed function-call batch. Keep every immediately following
      // atomic tool_pair on the same side of the compression boundary.
      if (revision.role === 'model') {
        while (
          compressSegmentCount < structure.records.length
          && structure.records[compressSegmentCount].segment.segment_kind === 'tool_pair'
        ) compressSegmentCount += 1;
      }
    }

    let result;
    try {
      await this.product.ensureCapabilitiesReady();
      const childExecutionId = await this.childExecutionIdForConversation(conversationId);
      result = childExecutionId
        ? await this.product.childAgents.manualCompressionFromConversation({
            commandId,
            childExecutionId,
            conversationId,
            compressSegmentCount,
            target: payload.target
          })
        : await this.product.conversations.manualCompression({
            commandId,
            conversationId,
            compressSegmentCount,
            target: payload.target
          });
    } catch (error) {
      if (!isConversationHistoryBusyError(error)) throw error;
      this.postCompressionCommandResult(webview, correlationId, {
        conversationId,
        commandId,
        target: payload.target,
        status: 'busy',
        reasonCode: 'conversation-busy'
      });
      return;
    }
    const compression = result.compression;
    this.postCompressionCommandResult(webview, correlationId, {
      conversationId,
      commandId,
      target: payload.target,
      turnId: result.turnId,
      status: result.inProgress
        ? 'in_progress'
        : result.deduplicated ? 'already_applied'
        : compression?.status === 'compressed' ? 'accepted' : 'rejected',
      ...(compression?.status === 'compressed' ? {
        modelRequestId: compression.modelRequestId,
        compressionBlockId: compression.result.compressionBlockId
      } : {}),
      ...(compression?.status === 'skipped' ? { reasonCode: compression.reason } : {})
    });
  }

  private postCompressionCommandResult(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: CompressionCommandResultPayload
  ): void {
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.CompressionCommandResult,
      channel: 'state',
      correlationId,
      payload
    });
  }

  private async handleInteractionResolve(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: InteractionResolvePayload
  ): Promise<void> {
    const { requestKind, won } = await this.runConversationCommand(payload.conversationId, async () => {
      const request = await this.requireRow('InteractionRequest', payload.interactionRequestId);
      const owner = (await this.list('InteractionOwnerLink', { request_id: payload.interactionRequestId }, 2))[0];
      const toolLink = (await this.list('InteractionToolCallLink', { request_id: payload.interactionRequestId }, 2))[0];
      if (!owner || owner.turn_id !== payload.ownerTurnId) throw new Error('Interaction owner 已变化。');
      if (!toolLink) throw new Error('Interaction 缺少 ToolCall 关系。');
      if (request.request_kind === 'ask_user') {
        const result = await this.product.application.interactions.resolveAskUser({
          source: { kind: 'command', key: `interaction:${payload.interactionRequestId}:${payload.decision}:${correlationId ?? randomUUID()}` },
          requestId: payload.interactionRequestId,
          response: payload.response,
          cancelled: payload.decision === 'cancel' || payload.decision === 'reject'
        });
        return { requestKind: String(request.request_kind), won: result.won };
      }
      if (request.request_kind === 'file_change_approval') {
        const changeSets = await this.list('FileChangeSet', { tool_call_id: toolLink.tool_call_id }, 2);
        const changeSet = changeSets[0];
        if (!changeSet) throw new Error('文件 Interaction 缺少 FileChangeSet。');
        const result = await this.product.application.files.decide({
          source: { kind: 'command', key: `interaction:${payload.interactionRequestId}:${payload.decision}:${correlationId ?? randomUUID()}` },
          changeSetId: String(changeSet.id),
          decision: payload.decision === 'accept' || payload.decision === 'submit'
            ? 'approved'
            : payload.decision === 'cancel'
              ? 'cancelled'
              : 'rejected',
          response: payload.response
        });
        if (result.preparedEffect) {
          await this.product.application.fileMutations.dispatchRecordAndReconcile(result.preparedEffect.effectIntentId);
        }
        return { requestKind: String(request.request_kind), won: result.won };
      }
      if (request.request_kind === 'plan_review') {
        const result = await this.product.application.interactions.resolvePlanReview({
          source: { kind: 'command', key: `interaction:${payload.interactionRequestId}:${payload.decision}:${correlationId ?? randomUUID()}` },
          requestId: payload.interactionRequestId,
          decision: payload.decision,
          response: payload.response
        });
        return { requestKind: String(request.request_kind), won: result.won };
      }
      if (request.request_kind === 'exec_approval') {
        const result = await this.product.application.interactions.resolveExecutionApproval({
          source: { kind: 'command', key: `interaction:${payload.interactionRequestId}:${payload.decision}:${correlationId ?? randomUUID()}` },
          requestId: payload.interactionRequestId,
          decision: payload.decision === 'accept' || payload.decision === 'submit'
            ? 'accept'
            : payload.decision === 'cancel'
              ? 'cancel'
              : 'reject',
          response: payload.response
        });
        return { requestKind: String(request.request_kind), won: result.won };
      }
      throw new Error(`不支持的可靠 Interaction 类型：${String(request.request_kind)}。`);
    });
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.InteractionResult,
      correlationId,
      payload: {
        requestType: requestKind,
        conversationId: payload.conversationId,
        targetId: payload.interactionRequestId,
        status: won ? 'committed' : 'already_resolved'
      }
    });
    // Durable first-response-wins resolution is already committed. A slow child lookup or Agent
    // resume must not hold the Webview button receipt hostage; startup recovery/local DB wake remains
    // the execution safety net if this best-effort nudge fails.
    setImmediate(() => {
      void this.resumeInteractionOwner(payload.ownerTurnId, payload.conversationId).catch((error) =>
        console.warn('[LimCode] Durable Interaction committed, but owner resume failed.', error)
      );
    });
  }

  private async resumeInteractionOwner(ownerTurnId: string, conversationId: string): Promise<void> {
    if (!await this.product.childAgents.resume(ownerTurnId)) {
      this.product.conversations.resume(conversationId, ownerTurnId);
    }
  }

  private async handleToolCancel(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: ToolDecisionPayload
  ): Promise<void> {
    const links = await this.list('InteractionToolCallLink', { tool_call_id: payload.toolCallId }, 10);
    const pending = await Promise.all(links.map((link) => this.requireRow('InteractionRequest', String(link.request_id))));
    const request = pending.find((candidate) => candidate.status === 'pending');
    if (request) {
      const owner = (await this.list('InteractionOwnerLink', { request_id: request.id }, 2))[0];
      if (!owner) throw new Error('Interaction 缺少 owner。');
      await this.handleInteractionResolve(webview, correlationId, {
        conversationId: payload.conversationId ?? String((await this.requireRow('Turn', String(owner.turn_id))).conversation_id),
        interactionRequestId: String(request.id),
        interactionRevision: 1,
        ownerTurnId: String(owner.turn_id),
        decision: 'cancel',
        response: { reason: payload.reason ?? '用户取消工具。' }
      });
      return;
    }
    const toolCall = await this.requireRow('ToolCall', payload.toolCallId);
    const turn = await this.requireRow('Turn', String(toolCall.turn_id));
    const turnConversationId = String(turn.conversation_id);
    if (toolCall.tool_name === 'run_agent') {
      const childLinks = await this.list('ChildExecutionParentLink', {
        source_tool_call_id: payload.toolCallId
      }, 2);
      if (childLinks.length !== 1) {
        throw new Error('run_agent 工具调用尚未建立唯一 ChildExecution，未中断父 Turn。');
      }
      const result = await this.runConversationCommand(turnConversationId, () =>
        this.product.childAgents.interruptSubtree({
          sourceKey: `tool-cancel:${payload.toolCallId}:${correlationId ?? randomUUID()}`,
          childExecutionId: String(childLinks[0].child_execution_id),
          reason: payload.reason ?? '用户取消此子 Agent 执行。'
        }));
      this.post(webview, {
        id: randomUUID(),
        type: BridgeMessageType.InteractionResult,
        correlationId,
        payload: {
          requestType: BridgeMessageType.ToolExecutionCancel,
          conversationId: turnConversationId,
          targetId: payload.toolCallId,
          status: result.deduplicated ? 'already_applied' : 'committed'
        }
      });
      return;
    }
    const interrupted = await this.runConversationCommand(turnConversationId, () =>
      this.product.conversations.interrupt({
        commandId: `tool-cancel:${payload.toolCallId}:${correlationId ?? randomUUID()}`,
        conversationId: turnConversationId,
        turnId: String(turn.id),
        reason: payload.reason ?? '用户取消工具执行。'
      }));
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.InteractionResult,
      correlationId,
      payload: {
        requestType: BridgeMessageType.ToolExecutionCancel,
        conversationId: turnConversationId,
        targetId: payload.toolCallId,
        status: interrupted.ignoredBecauseTerminal
          ? 'already_satisfied'
          : interrupted.coalesced ? 'already_applied' : 'committed'
      }
    });
  }

  private async handleProcessStop(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: ProcessStopPayload
  ): Promise<void> {
    const process = await this.requireRow('Process', payload.processId);
    const origins = await this.list('ProcessOriginLink', { process_id: process.id }, 2);
    if (origins.length !== 1) throw new Error('后台进程缺少唯一来源工具关系。');
    const origin = origins[0];
    const toolCall = await this.requireRow('ToolCall', String(origin.tool_call_id));
    const turn = await this.requireRow('Turn', String(toolCall.turn_id));
    const conversationId = String(turn.conversation_id);
    if (payload.conversationId !== undefined && payload.conversationId !== conversationId) {
      throw new Error('后台进程不属于当前 Conversation。');
    }
    const observation = await this.runConversationCommand(conversationId, async () => {
      const result = await this.product.application.processes.stopOwnedProcess(payload.processId);
      if (result.receipt) {
        await this.product.application.processes.reconcileProcessExit(payload.processId);
      }
      return result;
    });
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.InteractionResult,
      correlationId,
      payload: {
        requestType: BridgeMessageType.ProcessStop,
        conversationId,
        targetId: payload.processId,
        status: observation.outcome === 'outcome_unknown'
          ? 'outcome_unknown'
          : observation.outcome === 'cancelled'
            ? 'blocked'
            : observation.status === 'already_exited' ? 'already_satisfied' : 'committed',
        ...(observation.reason ? { reason: observation.reason } : {})
      }
    });
  }

  private async turnIdForMessage(conversationId: string, messageId: string): Promise<string> {
    const memberships = await this.list('MessagePartOfConversation', { conversation_id: conversationId, message_id: messageId }, 2);
    if (memberships.length !== 1) throw new Error('Message 不属于当前 Conversation。');
    const links = await this.list('MessageTurnLink', { message_id: messageId }, 20);
    const turnIds = [...new Set(links.map((link) => String(link.turn_id)))];
    if (turnIds.length !== 1) throw new Error('Message 缺少唯一 Turn 关系。');
    return turnIds[0];
  }

  private async turnIdForRetryTarget(
    conversationId: string,
    target: MessageRetryFromPayload['target']
  ): Promise<string> {
    if (target.kind === 'message') return this.turnIdForMessage(conversationId, target.messageId);
    const request = await this.requireRow('ModelRequest', target.modelRequestId);
    const turn = await this.requireRow('Turn', String(request.turn_id));
    if (turn.conversation_id !== conversationId) throw new Error('ModelRequest 不属于当前 Conversation。');
    return String(turn.id);
  }

  private async requireRow(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeRow(domain, id);
    if (!row) throw new Error(`${domain} ${id} 不存在。`);
    return row;
  }

  private async maybeRow(domain: string, id: string): Promise<DomainRow | undefined> {
    const snapshot = await this.product.application.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    return row && !Array.isArray(row) ? row : undefined;
  }

  private async childExecutionIdForConversation(conversationId: string): Promise<string | undefined> {
    const rows = await this.list('ChildExecution', { child_conversation_id: conversationId }, 2);
    if (rows.length > 1) {
      throw new Error(`Conversation ${conversationId} belongs to multiple ChildExecutions.`);
    }
    return rows[0] ? requireText(rows[0].id, 'ChildExecution.id') : undefined;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.product.application.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list 未返回数组。`);
    return rows;
  }

  private listAll(domain: string, where: DomainRow): Promise<DomainRow[]> {
    return listAllDomainRows(this.product.application.database, domain, where);
  }

  private broadcastOrPost(webview: vscode.Webview, message: unknown): void {
    if (this.options.broadcast) this.options.broadcast(message);
    else this.post(webview, message);
  }

  private postRequestError(
    webview: vscode.Webview,
    requestType: BridgeMessageType,
    message: string,
    correlationId?: string,
    details: {
      section?: GlobalSettingsGetPayload['section'];
      code?: 'settings_revision_conflict' | 'stale_conversation';
      actualRevision?: string;
      conversationId?: string;
    } = {}
  ): void {
    const { section, ...payloadDetails } = details;
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.Error,
      channel: 'diagnostics',
      ...(section
        ? { scope: { kind: 'settings' as const, level: 'global' as const, id: section } }
        : details.conversationId
          ? { scope: { kind: 'settings' as const, level: 'conversation' as const, id: details.conversationId } }
          : {}),
      correlationId,
      payload: { requestType, message, ...payloadDetails }
    });
  }

  private post(webview: vscode.Webview, message: unknown): void {
    void webview.postMessage(toStructuredClonePlainData(message, 'reliable command result')).then(
      (delivered) => {
        if (delivered) return;
        const clientId = this.clientIdByWebview.get(webview);
        if (clientId) this.product.application.webviewFeed.reconnect(clientId);
      },
      (error) => {
        console.warn('[LimCode] Reliable command result delivery failed; reconnecting the bounded Feed.', error);
        const clientId = this.clientIdByWebview.get(webview);
        if (clientId) this.product.application.webviewFeed.reconnect(clientId);
      }
    );
  }
}

function requirePayload<T>(payload: T | undefined, label: string): T {
  if (!payload) throw new TypeError(`${label} payload 缺失。`);
  return payload;
}

function serializeMessagePayload(text: string | undefined, content: { role: string; parts: unknown[] } | undefined): {
  value: string;
  contentType: string;
} {
  if (content?.parts?.length) {
    return { value: JSON.stringify(content), contentType: 'application/vnd.limcode.message+json' };
  }
  const value = text?.trim();
  if (!value) throw new TypeError('Message 内容不能为空。');
  return { value, contentType: 'text/plain; charset=utf-8' };
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} 必须是 bigint。`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串。`);
  return value.trim();
}

function sanitizeFileName(value: string): string {
  const name = value.trim().replace(/[\\/:*?\"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').slice(0, 120);
  return name || 'plan.md';
}

function decodeInlineAttachmentBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new TypeError('附件内联数据不是有效的 base64。');
  return bytes;
}

function attachmentOpenRequest(payload: AttachmentOpenPayload): Omit<AttachmentOpenPayload, 'data'> {
  return {
    ...(payload.attachmentId ? { attachmentId: payload.attachmentId } : {}),
    ...(payload.sourcePath ? { sourcePath: payload.sourcePath } : {}),
    ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
    ...(payload.name ? { name: payload.name } : {})
  };
}

function safeAttachmentFileName(id: string, name: string | undefined, mimeType: string): string {
  const extension = attachmentExtension(mimeType);
  const requested = name?.trim() || `attachment${extension}`;
  let safe = requested
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120) || `attachment${extension}`;
  if (extension && !path.extname(safe)) safe += extension;
  const prefix = id.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 48) || 'attachment';
  return `${prefix}-${safe}`;
}

function attachmentExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'application/pdf': return '.pdf';
    case 'text/plain': return '.txt';
    case 'application/json': return '.json';
    case 'audio/mpeg': return '.mp3';
    case 'video/mp4': return '.mp4';
    default: return '';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileNotFoundError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown };
  return value.code === 'ENOENT'
    || value.code === 'FileNotFound'
    || typeof value.message === 'string' && /not found|不存在|ENOENT/i.test(value.message);
}

type GuidanceControlMessageType =
  | BridgeMessageType.GuidanceEdit
  | BridgeMessageType.GuidanceCancel
  | BridgeMessageType.GuidanceReorder
  | BridgeMessageType.GuidanceHold;

function isGuidanceControlType(type: BridgeMessageType): type is GuidanceControlMessageType {
  return type === BridgeMessageType.GuidanceEdit
    || type === BridgeMessageType.GuidanceCancel
    || type === BridgeMessageType.GuidanceReorder
    || type === BridgeMessageType.GuidanceHold;
}

function guidanceControlAction(
  type: GuidanceControlMessageType
): GuidanceControlResultPayload['action'] {
  switch (type) {
    case BridgeMessageType.GuidanceEdit: return 'edit';
    case BridgeMessageType.GuidanceCancel: return 'cancel';
    case BridgeMessageType.GuidanceReorder: return 'reorder';
    case BridgeMessageType.GuidanceHold: return 'hold';
  }
}

function isConfigurationMutationType(type: BridgeMessageType): boolean {
  return CONFIGURATION_MUTATION_TYPES.has(type);
}

const CONFIGURATION_MUTATION_TYPES = new Set<BridgeMessageType>([
  BridgeMessageType.AgentCreate,
  BridgeMessageType.AgentUpdate,
  BridgeMessageType.AgentDelete,
  BridgeMessageType.WorkflowCreate,
  BridgeMessageType.WorkflowUpdate,
  BridgeMessageType.WorkflowDelete,
  BridgeMessageType.ConversationWorkflowSelect,
  BridgeMessageType.ModelProfileScopeSet,
  BridgeMessageType.ModelProfileScopeClear,
  BridgeMessageType.ToolPolicyScopeSet,
  BridgeMessageType.ToolPolicyScopeClear,
  BridgeMessageType.SkillPolicyScopeSet,
  BridgeMessageType.SkillPolicyScopeClear,
  BridgeMessageType.SystemPromptScopeSet,
  BridgeMessageType.SystemPromptScopeClear,
  BridgeMessageType.RuntimeContextScopeSet,
  BridgeMessageType.RuntimeContextScopeClear,
  BridgeMessageType.PlanReviewPolicyScopeSet,
  BridgeMessageType.PlanReviewPolicyScopeClear,
  BridgeMessageType.CheckpointPolicyScopeSet,
  BridgeMessageType.CheckpointPolicyScopeClear,
  BridgeMessageType.WorkEnvironmentPolicyScopeSet,
  BridgeMessageType.WorkEnvironmentPolicyScopeClear,
  BridgeMessageType.WorkEnvironmentUpsert,
  BridgeMessageType.WorkEnvironmentRemove,
  BridgeMessageType.WorkEnvironmentSelect,
  BridgeMessageType.WorkEnvironmentImportFromVscode,
  BridgeMessageType.RulesFileSave
]);
