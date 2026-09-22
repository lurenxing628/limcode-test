import { createRuntimeDeliveryWakeHandler } from './runtimeDeliveryWakeHandler';
import * as vscode from 'vscode';
import { EXTENSION_USER_AGENT } from '../../../shared/extensionIdentity';
import type { GlobalSettingsRecord, NetworkSettingsRecord } from '../../../shared/protocol';
import { resolveDataRootUri } from '../../capabilities/vscodeStorage/globalStatus';
import {
  createVscodeStoragePaths,
  type StoragePaths
} from '../../capabilities/vscodeStorage/paths';
import type {
  ReliableAgentLifecycleObserver,
  ReliableAgentTransientObserver
} from '../../reliableKernel/agentLoop';
import { ReliableChildAgentCoordinator } from '../../reliableKernel/childAgentCoordinator';
import { CollaborationToolDispatcher } from '../../reliableKernel/collaborationToolDispatcher';
import { ReliableDiagnosticJournal } from '../../reliableKernel/diagnosticJournal';
import { DebugCaptureService } from '../../reliableKernel/debugCapture/service';
import { debugCaptureSource } from '../../reliableKernel/debugCapture/source';
import { captureDebug } from '../../reliableKernel/debugCapture/observer';
import { FrozenAuthorityMcpPolicyGate } from '../../reliableKernel/frozenMcpPolicyGate';
import { ReliableLlmProviderRegistry } from '../../reliableKernel/llmCapabilityProviderRegistry';
import {
  ReliableKernelApplication,
  type ReliableKernelRecoveryReport
} from '../../reliableKernel/runtimeApplication';
import { RootAuthority } from '../../reliableKernel/rootAuthority';
import { ReliableToolDispatcher } from '../../reliableKernel/toolDispatcher';
import {
  createVscodeRootAuthority,
  resolveVscodeWorkspaceRuntimePlacement,
  resolveVscodeWorkspaceRuntimeScope,
  type VscodeWorkspaceRuntimePlacement
} from '../../reliableKernel/vscodeRootAuthority';
import { VscodeConfigurationAuthority } from '../../reliableKernel/vscodeConfigurationAuthority';
import {
  VscodeReliableToolHost,
  type VscodeReliableToolHostOptions
} from './VscodeReliableToolHost';
import { applyProxyEnvironment, normalizeProxySetting, proxyForShellAndMcp } from './proxyEnvironment';
import { VscodeReliableFileDiffEditor } from './VscodeReliableFileDiffEditor';
import { getRuntimeBuildInfo } from '../runtimeBuildInfo';
import { ReliableConversationRunner } from './ReliableConversationRunner';
import { ReliableConversationLifecycle } from './conversationLifecycle';
import { ExternalDataVersionWatcher } from './ExternalDataVersionWatcher';

export interface VscodeReliableKernelProductRuntimeOptions {
  /** Tests/candidate validation may supply an isolated authority. Production resolves it through getPaths(). */
  authority?: RootAuthority;
  /** Facade startup passes the immutable workspace placement used to construct authority. */
  runtimePlacement?: VscodeWorkspaceRuntimePlacement;
  transientObserver?: ReliableAgentTransientObserver;
  lifecycleObserver?: ReliableAgentLifecycleObserver;
  dispatchSpecial?: VscodeReliableToolHostOptions['dispatchSpecial'];
  onConfigurationChanged?: () => Promise<void> | void;
}

export type VscodeReliableKernelRecoveryState =
  | { status: 'not_started' | 'running' }
  | { status: 'complete'; report: ReliableKernelRecoveryReport }
  | { status: 'failed'; error: { name: string; message: string } };

/**
 * VS Code product composition for the reliable kernel.
 *
 * This class opens only an already activated fenced Runtime root. It never initializes, imports,
 * migrates or falls back to legacy Runtime data. Configuration remains in its independent settings
 * roots and is re-resolved through getPaths() for every authority operation.
 */
export class VscodeReliableKernelProductRuntime {
  public readonly application: ReliableKernelApplication;
  public readonly configuration: VscodeConfigurationAuthority;
  public readonly toolHost: VscodeReliableToolHost;
  public readonly childAgents: ReliableChildAgentCoordinator;
  public readonly fileDiffs: VscodeReliableFileDiffEditor;
  public readonly conversations: ReliableConversationRunner;
  /** Fork/create writes shared with model tools; the facade adds navigation and sidebar refresh. */
  public readonly conversationLifecycle: ReliableConversationLifecycle;
  public readonly providerRegistry: ReliableLlmProviderRegistry;
  public readonly diagnostics: ReliableDiagnosticJournal;
  public readonly debugCapture: DebugCaptureService;

  private recoveryReport: ReliableKernelRecoveryReport | undefined;
  private recoveryError: unknown;
  private recoveryTask: Promise<ReliableKernelRecoveryReport> | undefined;
  private readonly recoveryController = new AbortController();
  private readonly conversationRecoveryTasks = new Map<string, Promise<void>>();
  private readonly externalRuntimeWatcher: ExternalDataVersionWatcher;
  private closing = false;
  private readonly initializeConfiguration: () => Promise<void>;
  private readonly workspaceFoldersSubscription: vscode.Disposable;
  private workspaceFoldersChangeTask: Promise<void> = Promise.resolve();

  private constructor(input: {
    application: ReliableKernelApplication;
    configuration: VscodeConfigurationAuthority;
    toolHost: VscodeReliableToolHost;
    childAgents: ReliableChildAgentCoordinator;
    fileDiffs: VscodeReliableFileDiffEditor;
    conversations: ReliableConversationRunner;
    conversationLifecycle: ReliableConversationLifecycle;
    providerRegistry: ReliableLlmProviderRegistry;
    diagnostics: ReliableDiagnosticJournal;
    debugCapture: DebugCaptureService;
    initializeConfiguration: () => Promise<void>;
    onConfigurationChanged?: () => Promise<void> | void;
  }) {
    this.application = input.application;
    this.configuration = input.configuration;
    this.toolHost = input.toolHost;
    this.childAgents = input.childAgents;
    this.fileDiffs = input.fileDiffs;
    this.conversations = input.conversations;
    this.conversationLifecycle = input.conversationLifecycle;
    this.providerRegistry = input.providerRegistry;
    this.diagnostics = input.diagnostics;
    this.debugCapture = input.debugCapture;
    this.initializeConfiguration = input.initializeConfiguration;
    this.workspaceFoldersSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.closing) return;
      // Schedule synchronously: a Turn admitted after this event must queue behind the complete
      // folder snapshot. Existing Turns keep their frozen default identity.
      void this.initializeConfiguration().catch(() => undefined);
      this.workspaceFoldersChangeTask = this.configuration.synchronizeWorkspaceFolders(currentWorkspaceFolders())
        .then(async () => { if (!this.closing) await input.onConfigurationChanged?.(); });
      void this.workspaceFoldersChangeTask.catch(error => {
        console.error('[LimCode] 工作目录同步失败。', error);
        if (!this.closing) void vscode.window.showErrorMessage(`LimCode 工作目录同步失败：${error instanceof Error ? error.message : String(error)}`);
      });
    });
    this.externalRuntimeWatcher = new ExternalDataVersionWatcher(
      () => this.application.database.externalDataVersion(),
      () => this.application.refreshExternalRuntimeWork(),
      { onError: (error) => console.error('[LimCode] 跨宿主 Runtime 同步失败。', error) }
    );
  }

  public static async open(
    context: vscode.ExtensionContext,
    options: VscodeReliableKernelProductRuntimeOptions = {}
  ): Promise<VscodeReliableKernelProductRuntime> {
    const getPaths = (): StoragePaths => createVscodeStoragePaths(resolveDataRootUri(context));
    const workspaceFolders = currentWorkspaceFolders();
    const configuration = new VscodeConfigurationAuthority(
      getPaths,
      context,
      workspaceFolders
    );
    let configurationInitialization: Promise<void> | undefined;
    const initializeConfiguration = (): Promise<void> => {
      if (!configurationInitialization) {
        const pending = configuration.synchronizeWorkspaceFolders(currentWorkspaceFolders());
        configurationInitialization = pending;
        // A later folder event or command may retry a failed initialization. Keep successful and
        // in-flight work deduplicated, but never pin this Host to the first transient sync failure.
        void pending.catch(() => {
          if (configurationInitialization === pending) configurationInitialization = undefined;
        });
      }
      return configurationInitialization;
    };
    let authority = options.authority;
    if (!authority) {
      const runtimePlacement = options.runtimePlacement ?? await resolveVscodeWorkspaceRuntimePlacement(
        getPaths(),
        resolveVscodeWorkspaceRuntimeScope({
          workspaceFileUri: vscode.workspace.workspaceFile?.toString(),
          workspaceFolderUris: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString())
        })
      );
      authority = createVscodeRootAuthority(runtimePlacement);
    }
    const diagnostics = new ReliableDiagnosticJournal(authority, await authority.current());
    const debugCapture = new DebugCaptureService(authority, await authority.current(), debugCaptureSource(''));
    let application: ReliableKernelApplication | undefined;
    let childAgents: ReliableChildAgentCoordinator | undefined;
    let collaborationTools: CollaborationToolDispatcher | undefined;
    let fileDiffs: VscodeReliableFileDiffEditor | undefined;
    let conversations: ReliableConversationRunner | undefined;
    let conversationLifecycle: ReliableConversationLifecycle | undefined;
    const toolHost = new VscodeReliableToolHost(context, configuration, {
      dispatchSpecial: async (definition, input, frozenAuthority, signal, admission) => {
        const collaborationResult = await collaborationTools?.dispatch(input, signal, frozenAuthority);
        if (collaborationResult) return collaborationResult;
        const childResult = await childAgents?.dispatch(input, signal, frozenAuthority, admission);
        if (childResult) return childResult;
        return options.dispatchSpecial?.(definition, input, frozenAuthority, signal, admission);
      },
      cancelTurnWaits: async (input) => {
        await childAgents?.cancelParentWaits(input);
      },
      quiesce: async (reason) => {
        await childAgents?.quiesce(reason);
      },
      resolveAttachmentReference: async (attachmentId) => {
        if (!application) throw new Error('可靠 Runtime 尚未完成组合，无法读取附件。');
        return application.attachments.managedReference(attachmentId);
      },
      resolveAttachmentContent: async (attachmentId) => {
        if (!application) throw new Error('可靠 Runtime 尚未完成组合，无法读取附件正文。');
        return application.attachments.resolveInlineData(attachmentId);
      }
    });
    const providers = new ReliableLlmProviderRegistry({
      debugCapture,
      loadProviderConfig: (providerConfigId) => configuration.providerConfig(providerConfigId),
      proxy: async () => {
        const common = await configuration.loadGlobalSettings('common');
        const proxy = (common.settings as GlobalSettingsRecord).proxy;
        // 宽容解析：允许用户省略 http:// scheme；非法值视为未设置（直连），不让请求侧抛 URL 错误。
        return normalizeProxySetting(proxy);
      },
      headers: async () => {
        const network = await configuration.loadGlobalSettings('network');
        const userAgent = (network.settings as NetworkSettingsRecord).userAgent;
        return { 'User-Agent': userAgent || EXTENSION_USER_AGENT };
      },
      onTransportTrace: (trace) => {
        diagnostics.observe({
          eventKind: 'provider.transport.phase',
          scopeKind: 'model_request',
          scopeId: trace.requestId,
          correlationId: `${trace.connectionGeneration}:${trace.phase}`,
          observedAt: new Date(trace.observedAt).toISOString(),
          metadata: {
            conversationId: trace.conversationId,
            modelRequestId: trace.requestId,
            stage: trace.phase,
            sessionKeyHash: trace.sessionKeyHash,
            connectionGeneration: trace.connectionGeneration,
            ...(trace.elapsedMs !== undefined ? { elapsedMs: trace.elapsedMs } : {}),
            ...(trace.connectionReused !== undefined ? { connectionReused: trace.connectionReused } : {}),
            ...(trace.connectionReason ? { connectionReason: trace.connectionReason } : {}),
            ...(trace.mode ? { mode: trace.mode } : {}),
            ...(trace.reason ? { reasonCode: trace.reason } : {}),
            ...(trace.timeoutPhase ? { timeoutPhase: trace.timeoutPhase } : {}),
            ...(trace.fullInputItemCount !== undefined ? { fullInputItemCount: trace.fullInputItemCount } : {}),
            ...(trace.sentInputItemCount !== undefined ? { sentInputItemCount: trace.sentInputItemCount } : {}),
            ...(trace.responseCreateFrameSha256
              ? { responseCreateFrameSha256: trace.responseCreateFrameSha256 }
              : {}),
            ...(trace.responseCreateFrameBytes !== undefined
              ? { responseCreateFrameBytes: trace.responseCreateFrameBytes }
              : {}),
            ...(trace.responseCreateSeq !== undefined
              ? { responseCreateSeq: trace.responseCreateSeq }
              : {})
          }
        });
      },
      resolveAttachment: async (input) => {
        if (!application) throw new Error('可靠 Runtime 尚未完成组合，无法解析附件。');
        return application.attachments.resolveProviderInlineData(input);
      }
    });
    const observedFirstTransient = new Set<string>();
    const transientObserver: ReliableAgentTransientObserver = {
      observe(event) {
        captureDebug(debugCapture, { conversationId: event.conversationId, modelRequestId: event.modelRequestId, attemptSeq: event.attemptSeq, socketGeneration: event.socketGeneration },
          () => ({ stage: 'runtime.transient', metadata: { streamSeq: String(event.event.streamSeq), kind: event.event.kind } }));
        application?.webviewFeed.broadcastTransient(event);
        const transientGeneration = `${event.modelRequestId}:${event.attemptSeq}:${event.socketGeneration}`;
        if (!observedFirstTransient.has(transientGeneration)) {
          observedFirstTransient.add(transientGeneration);
          while (observedFirstTransient.size > 2_048) {
            const oldest = observedFirstTransient.values().next().value as string | undefined;
            if (!oldest) break;
            observedFirstTransient.delete(oldest);
          }
          diagnostics.observe({
            eventKind: 'provider.transient.first_event',
            scopeKind: 'model_request',
            scopeId: event.modelRequestId,
            correlationId: String(event.event.streamSeq),
            observedAt: event.observedAt,
            metadata: {
              conversationId: event.conversationId,
              turnId: event.turnId,
              modelRequestId: event.modelRequestId,
              attemptSeq: event.attemptSeq,
              socketGeneration: event.socketGeneration,
              streamSeq: String(event.event.streamSeq),
              kind: event.event.kind
            }
          });
        }
        options.transientObserver?.observe(event);
      }
    };
    const lifecycleObserver: ReliableAgentLifecycleObserver = {
      observe(event) {
        diagnostics.observe({
          eventKind: 'agent.lifecycle',
          scopeKind: 'turn',
          scopeId: event.turnId,
          correlationId: event.modelRequestId ?? event.toolCallId,
          observedAt: event.observedAt,
          metadata: {
            turnId: event.turnId,
            stage: event.stage,
            ...(event.round !== undefined ? { round: event.round } : {}),
            ...(event.modelRequestId ? { modelRequestId: event.modelRequestId } : {}),
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
            ...(event.openTaskCount !== undefined ? { openTaskCount: event.openTaskCount } : {}),
            ...(event.taskCardSha256 ? { taskCardSha256: event.taskCardSha256 } : {}),
            ...(event.activeChildCount !== undefined ? { activeChildCount: event.activeChildCount } : {}),
            ...(event.runningProcessCount !== undefined ? { runningProcessCount: event.runningProcessCount } : {}),
            ...(event.errorName ? { errorName: event.errorName } : {})
          }
        });
        options.lifecycleObserver?.observe(event);
      }
    };
    try {
      application = await ReliableKernelApplication.open(authority, {
        authorityCompiler: configuration,
        compressionSettingsAuthority: configuration,
        resolveWorkEnvironment: async (workEnvironmentId) => {
          const environment = await configuration.workEnvironment(workEnvironmentId);
          if (!environment.available || environment.kind !== 'localFolder' || !environment.rootPath) return undefined;
          return { id: environment.id, rootPath: environment.rootPath };
        },
        mcpConnections: toolHost.mcp,
        createMcpPolicyGate: ({ database, contentStore }) =>
          new FrozenAuthorityMcpPolicyGate(database, contentStore),
        attachmentSettings: configuration,
        providers,
        createToolDispatcher: ({
          database,
          contentStore,
          runtime,
          files,
          fileMutations,
          processes,
          mcp,
          interactions
        }) => new ReliableToolDispatcher({
          database,
          contentStore,
          effects: runtime.effects,
          files,
          fileMutations,
          processes,
          mcp,
          interactions,
          host: toolHost
        }),
        transientObserver,
        lifecycleObserver,
        diagnosticObserver: diagnostics,
        runtimeBuildInfo: getRuntimeBuildInfo
      });
      fileDiffs = new VscodeReliableFileDiffEditor(application.files, diagnostics);
      debugCapture.source.hostBootId = application.database.hostBootId;
      application.webviewFeed.setDebugCapture(debugCapture);
      conversations = new ReliableConversationRunner(
        application,
        `vscode-product:${application.database.hostBootId}`,
        undefined,
        undefined,
        diagnostics
      );
      application.processDeliveries.setWakeHandler(createRuntimeDeliveryWakeHandler({
        application: () => application,
        conversations: () => conversations,
        children: () => childAgents,
        notify: request => {
          if (request.sourceKind === 'child_failure') {
            void vscode.window.showErrorMessage('LimCode 子 Agent 执行失败；失败详情已保留在可靠 Runtime 中。');
          } else if (request.sourceKind === 'collaboration_message') {
            void vscode.window.showInformationMessage('LimCode 协作消息已保留；目标任务当前无法继续执行。');
          } else {
            void vscode.window.showInformationMessage(request.sourceKind === 'answer_submission'
              ? 'LimCode 子 Agent 已返回部分或最终结果；来源对话已结束，答案已保留在可靠 Runtime 中。'
              : `LimCode 后台进程 ${request.processId ?? request.sourceId} 已完成；来源对话已取消或关闭，结果已保留在可靠 Runtime 中。`);
          }
        }
      }));
      // The tool host's special-dispatch chain was built before the Runtime existed; these
      // services are bound into it late through the closure variables it reads per call.
      conversationLifecycle = new ReliableConversationLifecycle({ application, configuration });
      collaborationTools = new CollaborationToolDispatcher({
        database: application.database,
        contentStore: application.contentStore,
        effects: application.runtime.effects,
        collaboration: application.runtime.collaboration,
        board: application.runtime.collaborationBoard,
        conversations: conversationLifecycle
      });
      childAgents = new ReliableChildAgentCoordinator({
        database: application.database,
        effects: application.runtime.effects,
        children: application.runtime.children,
        answers: application.runtime.answers,
        deliveries: application.runtime.deliveries,
        modelProvider: application.modelProvider,
        turns: application.turns,
        agentLoop: application.agentLoop,
        agents: { resolve: (input) => configuration.resolveAgent(input) },
        modelProfiles: {
          initializeConversation: ({ conversationId, model }) =>
            configuration.mutations.initializeConversationModelProfile({
              conversationId,
              ...(model.providerConfigId ? { providerConfigId: model.providerConfigId } : {}),
              ...(model.provider ? { provider: model.provider } : {}),
              model: model.model
            })
        },
        deliveryWakeups: application.processDeliveries,
        ownedProcessCleanup: application.childOwnedProcessCleanup,
        cancelTurnExecution: async ({ turnId, reason }) => {
          await Promise.all([
            application!.modelProvider.cancelTurnDispatches(turnId, reason),
            Promise.resolve(application!.toolDispatcher.cancelActive?.({ turnId, reason }))
          ]);
        },
        quiesceTurnExecution: async ({ turnId, reason }) => {
          await Promise.allSettled([
            application!.modelProvider.quiesceTurnDispatches(turnId, reason),
            Promise.resolve(application!.toolDispatcher.quiesceTurn?.({ turnId, reason }))
          ]);
        },
        manualCompression: {
          admit: (input) => conversations!.admitManualCompression(input),
          inspect: (input) => conversations!.inspectManualCompression(input),
          driveIfPresent: (input) => conversations!.driveManualCompressionIfPresent(input)
        }
      });
      application.interactions.setPlanDelegator({
        preview: (input) => childAgents!.previewApprovedPlan(input),
        ensure: (input) => childAgents!.ensureApprovedPlan(input)
      });
      // shell 覆盖是显式 opt-in；开启后把代理注入扩展宿主进程环境，子孙进程
      // （wrapper → PowerShell → curl/git）自动继承。这里必须在 open 返回前完成，
      // 否则启动读到的旧值可能在用户随后的保存之后落地，反向覆盖新设置。
      try {
        const stored = await configuration.loadGlobalSettings('common');
        applyProxyEnvironment(proxyForShellAndMcp(stored.settings as GlobalSettingsRecord));
      } catch {
        // 设置文件损坏不应阻止扩展打开；LLM 请求侧仍会读取并报告真实错误。
      }
      return new VscodeReliableKernelProductRuntime({
        application,
        configuration,
        toolHost,
        childAgents,
        fileDiffs,
        conversations,
        conversationLifecycle,
        providerRegistry: providers,
        diagnostics,
        debugCapture,
        initializeConfiguration,
        onConfigurationChanged: options.onConfigurationChanged
      });
    } catch (error) {
      await debugCapture.close().catch(() => undefined);
      if (application) {
        fileDiffs?.dispose();
        conversations?.dispose();
        await application.beginHandoff().catch(() => undefined);
        await conversations?.waitForIdle().catch(() => undefined);
        // Child tasks need the live SQLite/CAS composition while they abort and settle.
        await childAgents?.dispose().catch(() => undefined);
        await application.close().catch(() => undefined);
      } else {
        await toolHost.dispose().catch(() => undefined);
        providers.dispose();
      }
      await diagnostics.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Runs durable crash recovery after the VS Code surface has been registered. Recovery is
   * level-triggered and protected by the same SQLite CAS/lease fences as live work, so it must not
   * hold extension activation (and the entire sidebar) hostage while it scans a large data set.
   */
  public startRecovery(): Promise<ReliableKernelRecoveryReport> {
    if (this.recoveryTask) return this.recoveryTask;
    if (this.closing) return Promise.reject(new Error('Reliable Runtime is closing.'));
    const controller = this.recoveryController;
    this.recoveryTask = (async () => {
      await this.externalRuntimeWatcher.start();
      const [report] = await Promise.all([
        this.application.recover(controller.signal),
        this.toolHost.initialize(),
        this.initializeConfiguration()
      ]);
      controller.signal.throwIfAborted();
      if (!this.closing) {
        await this.childAgents.recoverStartup(controller.signal);
        controller.signal.throwIfAborted();
        await this.conversations.recoverStartup(controller.signal);
      }
      await this.application.refreshExternalRuntimeWork();
      this.recoveryReport = report;
      return report;
    })().catch((error) => {
      if (!this.closing) this.recoveryError = error;
      throw error;
    });
    return this.recoveryTask;
  }

  /** Commands that freeze a new execution authority wait for the post-activation catalogs. */
  public ensureCapabilitiesReady(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Reliable Runtime is closing.'));
    return Promise.all([
      this.toolHost.initialize(),
      this.initializeConfiguration()
    ]).then(() => undefined);
  }

  /** A view may take over a crashed peer after this host's startup recovery has already finished. */
  public recoverConversation(conversationId: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Reliable Runtime is closing.'));
    const existing = this.conversationRecoveryTasks.get(conversationId);
    if (existing) return existing;
    const signal = this.recoveryController.signal;
    const task = this.application.database.conversationOwners.run(conversationId, async () => {
      signal.throwIfAborted();
      await this.ensureCapabilitiesReady();
      await this.application.recoverConversation(conversationId, signal);
      signal.throwIfAborted();
      await this.childAgents.recoverStartup(signal, conversationId);
      signal.throwIfAborted();
      await this.conversations.recoverStartup(signal, conversationId);
    }).finally(() => {
      if (this.conversationRecoveryTasks.get(conversationId) === task) {
        this.conversationRecoveryTasks.delete(conversationId);
      }
    });
    this.conversationRecoveryTasks.set(conversationId, task);
    return task;
  }

  public recoveryState(): VscodeReliableKernelRecoveryState {
    if (this.recoveryReport) return { status: 'complete', report: this.recoveryReport };
    if (this.recoveryError) {
      return {
        status: 'failed',
        error: {
          name: this.recoveryError instanceof Error ? this.recoveryError.name : 'Error',
          message: this.recoveryError instanceof Error ? this.recoveryError.message : String(this.recoveryError)
        }
      };
    }
    return { status: this.recoveryTask ? 'running' : 'not_started' };
  }

  public async close(): Promise<void> {
    this.closing = true;
    this.workspaceFoldersSubscription.dispose();
    const cancellation = new Error('Reliable Runtime recovery cancelled for Host handoff.');
    cancellation.name = 'AbortError';
    this.configuration.mutations.retireModelProfileAuthority();
    this.recoveryController.abort(cancellation);
    this.externalRuntimeWatcher.cancel();
    try {
      await this.debugCapture.close().catch(() => undefined);
      this.fileDiffs.dispose();
      this.conversations.dispose();
      await this.workspaceFoldersChangeTask.catch(() => undefined);
      await this.application.beginHandoff();
      // MCP discovery has its own AbortSignal generation. Dispose it before awaiting recovery so
      // an unresponsive external server cannot make Extension Host reload wait forever.
      await this.toolHost.dispose();
      await this.recoveryTask?.catch(() => undefined);
      await Promise.allSettled(this.conversationRecoveryTasks.values());
      await this.externalRuntimeWatcher.stop();
      await this.conversations.waitForIdle();
      // Never close the database underneath in-flight child Turn finalization.
      await this.childAgents.dispose();
      await this.application.close();
    } finally {
      await this.diagnostics.close();
    }
  }
}

function currentWorkspaceFolders(): Array<{ uri: string; name: string; rootPath: string; index: number }> {
  return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
    uri: folder.uri.toString(), name: folder.name, rootPath: folder.uri.fsPath, index
  }));
}
