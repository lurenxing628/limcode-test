import { AGENT_COLLABORATION_TOOL_NAMES, isReadonlyAgentCollaborationTool } from '../world/modules/tools/definitions/agentCollaboration';
import {
  CROSS_CONVERSATION_TOOL_NAMES,
  isCrossConversationTool,
  isReadonlyCrossConversationTool
} from '../world/modules/tools/definitions/crossConversation';
import { isReadonlyAgentBoardOperation } from '../world/modules/tools/definitions/agentBoard';
import {
  MAX_CONCURRENT_ATTACHMENT_READS_PER_TURN,
  MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN,
  MAX_CONCURRENT_ORDINARY_TOOLS_PER_TURN,
  MAX_CONCURRENT_PROCESS_OR_MCP_TOOLS_PER_TURN
} from '../../shared/agentScheduling';
import {
  SKILLS_TOOL_NAME,
  SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  TRANSFER_TOOL_NAME,
  type SkillDefinitionRecord,
  type ToolDefinitionMetadataRecord,
  type ToolPolicyToolConfigRecord,
  type WorkEnvironmentRecord
} from '../../shared/protocol';
import { CHILD_PLAN_AUTO_APPROVAL_MESSAGE, PLAN_AUTO_APPROVAL_MESSAGE } from '../../shared/planReview';
import { BACKGROUND_ASK_USER_AUTO_ANSWER } from '../../shared/askUser';
import { EXTENSION_PACKAGE_NAME } from '../../shared/extensionIdentity';
import {
  crossConversationSwitchOn,
  crossConversationToolPermitted,
  toolAllowedByPolicy,
  toolConfigFor,
  toolConfigKey,
  type ToolPolicyTool
} from '../../shared/toolPolicyResolution';
import {
  mapSettledWithBoundedAdmissionConcurrency,
  mapSettledWithBoundedConcurrency,
  type BoundedAdmissionControl
} from '../capabilities/boundedConcurrency';
import {
  classifyCommandCall,
  isReadonlyCommandCall,
  type TrustedCommandClassification
} from '../world/modules/tools/definitions/command';
import {
  RUN_AGENT_TOOL_NAME,
  RUN_AGENT_OPERATIONS,
  isReadonlyRunAgentOperation,
  runAgentToolAvailableAtDepth
} from '../world/modules/tools/definitions/runAgent';
import { effectiveLocalPathReadMode } from '../world/modules/tools/definitions/readFile';
import { isSkillEnabledByPolicy } from '../world/modules/skill/policy';
import { composeSkillsToolDescription } from '../world/modules/skill/skillDescription';
import {
  SWITCH_WORK_ENVIRONMENTS_TITLE,
  TRANSFER_WORK_ENVIRONMENTS_TITLE,
  workEnvironmentListText,
  withTransferEnvironmentParameterHints,
  withWorkEnvironmentIdParameterHints
} from '../world/modules/workEnvironment/toolDescription';
import {
  augmentRunAgentToolSchema,
  formatAgentTypeList,
  type AgentTypeListEntry
} from '../world/modules/tools/runAgentTypeDescription';
import type { ToolDefinition, ToolResultOut, ToolRuntimeEvent } from '../world/modules/tools/registry';
import type {
  ReliableAgentToolDefinition,
  ReliableAgentToolDispatchInput,
  ReliableAgentToolDispatcher,
  ReliableAgentToolBatchAdmission,
  ReliableAgentToolBatchConfirmationInput,
  ReliableAgentToolPause,
  ReliableAgentToolSettled
} from './agentLoop';
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { childAgentDepthForTurn } from './childAgentDepth';
import type {
  EffectControlPlane,
  FrozenToolCallPolicyDecision,
  ToolOutcomeStatus,
  ToolTerminalResult
} from './effectControlPlane';
import type {
  FileChangeControlPlane,
  FileChangeProposalMemberInput,
  FileMutationDispatcher
} from './fileEffects';
import { authorizeFrozenPlanReview, type FrozenPlanReviewRiskLevel } from './frozenMcpPolicyGate';
import { frozenInteractionAutoApproval, frozenSkillPolicy, readFrozenTurnAuthority } from './frozenAuthority';
import { inheritedToolPolicyChain, type InheritedToolPolicyLayer } from './childExecutionBoundary';
import type { McpEffectDispatcher } from './mcpEffects';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import type { ProcessControlPlane, ProcessWaitObservation } from './processEffects';
import {
  DEFAULT_PROCESS_EXECUTION_TIMEOUT_MS,
  DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
  MAX_PROCESS_EXECUTION_TIMEOUT_MS,
  MAX_PROCESS_MAX_OUTPUT_BYTES,
  MIN_PROCESS_EXECUTION_TIMEOUT_MS,
  MIN_PROCESS_MAX_OUTPUT_BYTES
} from './processProtocol';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';
import type { ToolInteractionControlPlane } from './toolInteractions';
import { WorkEnvironmentTransferEffectDispatcher } from './workEnvironmentTransferEffects';
import {
  ExecutionHandoffError,
  handoffReason,
  isExecutionHandoffError
} from './executionLeaseFence';

export interface ReliableToolDispatchAuthority {
  snapshotId: string;
  document: PlainJsonValue;
  toolConfig?: ToolPolicyToolConfigRecord;
  /**
   * Child Turns only: each ancestor Turn's preset and settings for this tool, nearest first. A call
   * runs automatically, applies changes or submits its result on its own only when every one of
   * them agrees, and a command must pass every ancestor's command rules.
   */
  inheritedToolConfigs?: readonly InheritedToolConfig[];
}

export interface InheritedToolConfig {
  preset: string;
  toolConfig?: ToolPolicyToolConfigRecord;
}

export interface ReliableSpecialToolAdmission {
  /** Release after the child spawn/continuation has crossed its durable admission boundary. */
  release(): void;
}

export interface ReliableToolDispatcherHost {
  dispose?(): Promise<void> | void;
  /** Current immutable declarations, including memory-only MCP discovery results. */
  definitions(): Promise<ToolDefinition[]> | ToolDefinition[];
  /** 磁盘扫描出的技能目录快照；用于把可用技能列表拼进 skills 工具描述。 */
  skillDefinitions?(): SkillDefinitionRecord[];
  /** 按冻结 authority 解析出的工作环境边界；用于把环境列表拼进 switch/transfer 工具描述。 */
  workEnvironmentsForAuthority?(
    authority: ReliableToolDispatchAuthority
  ): Promise<{ active?: WorkEnvironmentRecord; allowed: WorkEnvironmentRecord[] }>;
  /** 可指派的 agent.type 列表（含内置与自定义，已排除运行时镜像）；用于拼进 runAgent 工具描述。 */
  agentTypeEntries?(): Promise<AgentTypeListEntry[]> | AgentTypeListEntry[];
  /** Pure/repeatable capability call. The dispatcher persists its returned result before finalization. */
  executeNoEffect?(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    emit: (event: ToolRuntimeEvent) => void,
    signal: AbortSignal
  ): Promise<ToolResultOut>;
  /** Executes a transfer only after the dedicated file_transfer EffectIntent is committed/claimed. */
  executeWorkEnvironmentTransfer?(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    emit: (event: ToolRuntimeEvent) => void,
    signal: AbortSignal
  ): Promise<ToolResultOut>;
  /** Builds a proposal only. It must not mutate the target filesystem. */
  planFileMutation?(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    signal: AbortSignal
  ): Promise<FileChangeProposalMemberInput[]>;
  /** Resolves and validates the process working directory without running the command. */
  resolveProcessCwd?(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<string> | string;
  /** Child/answer/plan/work-environment operations stay in their dedicated control planes. */
  dispatchSpecial?(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    signal: AbortSignal,
    admission?: ReliableSpecialToolAdmission
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled | undefined>;
  /** Cancels only the parent-side durable wait; child execution is left running unless separately cascaded. */
  cancelTurnWaits?(input: { turnId: string; reason: string }): Promise<void>;
  quiesce?(reason: ExecutionHandoffError): Promise<void>;
}

export interface ReliableToolDispatcherDependencies {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  effects: EffectControlPlane;
  files: FileChangeControlPlane;
  fileMutations: FileMutationDispatcher;
  processes: ProcessControlPlane;
  mcp: McpEffectDispatcher;
  interactions: ToolInteractionControlPlane;
  host: ReliableToolDispatcherHost;
}

const FILE_TOOLS = new Set(['write', 'edit', 'delete']);
const PROCESS_TOOLS = new Set(['bash', 'shell']);
const SPECIAL_TOOLS = new Set([
  RUN_AGENT_TOOL_NAME,
  'submit_agent_answer',
  'read_agent_answer',
  ...AGENT_COLLABORATION_TOOL_NAMES,
  ...CROSS_CONVERSATION_TOOL_NAMES,
  'agent_board'
]);
const WORK_ENVIRONMENT_TOOLS = new Set([SWITCH_WORK_ENVIRONMENT_TOOL_NAME, TRANSFER_TOOL_NAME]);
const NO_EFFECT_CAPABILITY_TIMEOUT_MS = 30_000;
const CANCEL_ACTIVE_GRACE_MS = 1_000;
// ReliableConversationRunner admits one active drive per Turn, making dispatchBatch the Turn's
// parallel-tool admission boundary. Child-agent admission is separate: its slot covers only the
// durable spawn/continuation intent phase, never the foreground answer wait.

interface DeferredNoEffectSettlement {
  disposition: 'deferred_no_effect';
  source: { kind: 'internal'; key: string };
  toolCallId: string;
  status: ToolOutcomeStatus;
  detail: PlainJsonValue;
}

type InternalDispatchResult =
  | ToolTerminalResult
  | ReliableAgentToolPause
  | ReliableAgentToolSettled
  | DeferredNoEffectSettlement;

interface PreparedProviderToolEntry {
  identity: string;
  frozenDefinition: ReliableAgentToolDefinition;
  policy: FrozenToolCallPolicyDecision;
}

interface PreparedProviderToolBatch {
  turnId: string;
  modelRequestId: string;
  definitions: readonly ToolDefinition[];
  authority: ReliableToolDispatchAuthority;
  entriesById: ReadonlyMap<string, PreparedProviderToolEntry>;
}

interface CheckedProviderToolEntry extends PreparedProviderToolEntry {
  toolCall: DomainRow;
  definitionMismatch?: string;
}

interface CheckedProviderToolBatch {
  turnId: string;
  modelRequestId: string;
  definitions: readonly ToolDefinition[];
  authority: ReliableToolDispatchAuthority;
  entriesById: ReadonlyMap<string, CheckedProviderToolEntry>;
  remainingCallIds: Set<string>;
}

interface ResolvedToolBatchPreflight {
  definitions: readonly ToolDefinition[];
  baseAuthority: ReliableToolDispatchAuthority;
  freshCallIds: Set<string>;
  toolCallsById: Map<string, DomainRow>;
  frozenDecisionsById: Map<string, FrozenToolCallPolicyDecision>;
  internalCallIds: Set<string>;
  providerDefinitionMismatches: Map<string, string>;
}

type NativeSchedulingLaneKind = 'ordinary' | 'attachment' | 'processOrMcp' | 'child';

/** The exact batch classifier, shared so native per-item scheduling preserves lane semantics. */
function nativeSchedulingLaneKind(
  input: ReliableAgentToolDispatchInput,
  definitionsByName: ReadonlyMap<string, ToolDefinition>
): NativeSchedulingLaneKind {
  if (
    input.toolName === RUN_AGENT_TOOL_NAME
    && ['spawn', 'send'].includes(optionalText(plainOptionalRecord(input.arguments)?.operation) ?? '')
  ) return 'child';
  if (
    PROCESS_TOOLS.has(input.toolName)
    || definitionsByName.get(input.toolName)?.declaration.source?.kind === 'mcp'
  ) return 'processOrMcp';
  if (isAttachmentReadInput(input)) return 'attachment';
  return 'ordinary';
}

/** FIFO bounded slot lane shared by every natively scheduled call of one Turn. */
class NativeSchedulingLane {
  private active = 0;
  private readonly waiters: Array<{
    resolve(): void;
    onAbort(): void;
  }> = [];

  public constructor(private readonly limit: number) {}

  public acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new Error('Native scheduling lane wait was cancelled.'));
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          reject(signal.reason ?? new Error('Native scheduling lane wait was cancelled.'));
        }
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  public release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.active -= 1;
  }
}

/** Child-start admission slot; released early at the durable spawn boundary or on completion. */
class NativeChildAdmissionControl implements BoundedAdmissionControl {
  private released = false;

  public constructor(private readonly lane: NativeSchedulingLane) {}

  public release(): void {
    if (this.released) return;
    this.released = true;
    this.lane.release();
  }
}

interface PlannedNativeCall {
  input: ReliableAgentToolDispatchInput;
  preflight: ResolvedToolBatchPreflight;
  laneKind: NativeSchedulingLaneKind;
  serial: boolean;
}

/**
 * Turn-scoped scheduler for durably admitted native streamed calls. All calls of one Turn share
 * the batch lane limits, a serial-policy chain equivalent to the batch group ordering (parallel
 * generations drain before a serial call; later work waits for it), and the child admission
 * barrier. It never creates per-call lane pools, so native per-item admission cannot multiply
 * the Turn's real concurrency.
 */
class NativeTurnToolScheduler {
  private decisionTail: Promise<unknown> = Promise.resolve();
  private serialTail: Promise<unknown> = Promise.resolve();
  private generation = new Set<Promise<unknown>>();
  private readonly lanes: Record<Exclude<NativeSchedulingLaneKind, 'child'>, NativeSchedulingLane> = {
    ordinary: new NativeSchedulingLane(MAX_CONCURRENT_ORDINARY_TOOLS_PER_TURN),
    attachment: new NativeSchedulingLane(MAX_CONCURRENT_ATTACHMENT_READS_PER_TURN),
    processOrMcp: new NativeSchedulingLane(MAX_CONCURRENT_PROCESS_OR_MCP_TOOLS_PER_TURN)
  };
  private readonly childLane = new NativeSchedulingLane(MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN);
  private activeTasks = 0;
  public readonly controller = new AbortController();

  public constructor(
    private readonly plan: (input: ReliableAgentToolDispatchInput) => Promise<PlannedNativeCall>,
    private readonly execute: (
      planned: PlannedNativeCall,
      signal: AbortSignal,
      specialAdmission?: BoundedAdmissionControl
    ) => Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled>,
    private readonly settleCancelled: (
      input: ReliableAgentToolDispatchInput,
      reason: string
    ) => Promise<ToolTerminalResult | ReliableAgentToolSettled>,
    private readonly onIdle: () => void
  ) {}

  public schedule(
    input: ReliableAgentToolDispatchInput
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    this.activeTasks += 1;
    // Admission-order planning: preflight/classification/queue insertion are chained per Turn so
    // concurrent scheduleAdmittedCall invocations cannot interleave their ordering decision.
    const decision = this.decisionTail.then(() => this.plan(input));
    this.decisionTail = decision.then(() => undefined, () => undefined);
    const task = decision.then((planned) => this.start(planned));
    return task.finally(() => {
      this.activeTasks -= 1;
      if (this.activeTasks === 0) this.onIdle();
    });
  }

  private start(
    planned: PlannedNativeCall
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    if (planned.serial) {
      // A serial call drains the current parallel generation, then runs behind the serial chain.
      const drain = Promise.allSettled([...this.generation]);
      this.generation = new Set();
      const task = this.serialTail.then(async () => {
        await drain;
        return this.runInLane(planned);
      });
      this.serialTail = task.then(() => undefined, () => undefined);
      return task;
    }
    const gate = this.serialTail;
    const task = (async () => {
      await gate;
      return this.runInLane(planned);
    })();
    this.generation.add(task);
    void task.finally(() => {
      this.generation.delete(task);
    }).catch(() => undefined);
    return task;
  }

  private async runInLane(
    planned: PlannedNativeCall
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    const signal = this.controller.signal;
    const handoff = handoffReason(signal);
    if (handoff) throw handoff;
    if (planned.laneKind === 'child') {
      let admission: NativeChildAdmissionControl;
      try {
        await this.childLane.acquire(signal);
      } catch (error) {
        const lateHandoff = handoffReason(signal);
        if (lateHandoff || isExecutionHandoffError(error)) throw lateHandoff ?? error;
        return this.settleCancelled(planned.input, 'Turn cancelled while waiting for a native child admission slot.');
      }
      admission = new NativeChildAdmissionControl(this.childLane);
      try {
        return await this.execute(planned, signal, admission);
      } finally {
        admission.release();
      }
    }
    const lane = this.lanes[planned.laneKind];
    try {
      await lane.acquire(signal);
    } catch (error) {
      const lateHandoff = handoffReason(signal);
      if (lateHandoff || isExecutionHandoffError(error)) throw lateHandoff ?? error;
      return this.settleCancelled(planned.input, 'Turn cancelled while waiting for a native scheduling slot.');
    }
    try {
      return await this.execute(planned, signal);
    } finally {
      lane.release();
    }
  }
}

/** Product Tool dispatcher. Every non-readonly external effect is committed before dispatch. */
export class ReliableToolDispatcher implements ReliableAgentToolDispatcher {
  private readonly workEnvironmentTransfers: WorkEnvironmentTransferEffectDispatcher;
  private readonly activeHostExecutions = new Map<string, {
    turnId: string;
    controller: AbortController;
    completion: Promise<void>;
    finish(): void;
  }>();
  private readonly activeBatchDispatches = new Map<Promise<unknown>, {
    turnId: string;
    controller: AbortController;
  }>();
  private readonly admissionSignals = new Map<string, AbortSignal>();
  private readonly activeDispatches = new Set<Promise<unknown>>();
  private readonly authorityCache = new Map<string, Promise<{ snapshotId: string; document: PlainJsonValue }>>();
  private readonly pendingPreparedProviderBatches = new Map<string, PreparedProviderToolBatch>();
  private readonly checkedProviderBatchAdmissions = new WeakMap<object, CheckedProviderToolBatch>();
  private readonly toolSettlementListeners = new Map<string, Set<(event: { toolCallId: string }) => void>>();
  private readonly effectsSettlementUnsubscribe: () => void;
  private readonly nativeTurnSchedulers = new Map<string, NativeTurnToolScheduler>();
  private handoff: ExecutionHandoffError | undefined;

  public constructor(private readonly dependencies: ReliableToolDispatcherDependencies) {
    this.workEnvironmentTransfers = new WorkEnvironmentTransferEffectDispatcher(
      dependencies.database,
      dependencies.effects
    );
    this.effectsSettlementUnsubscribe = dependencies.effects.subscribeToolModelResults((events) => {
      for (const event of events) this.emitToolSettlement(event.turnId, event.toolCallId);
    });
  }

  public async dispose(): Promise<void> {
    await this.quiesce(this.handoff ?? new ExecutionHandoffError());
    this.effectsSettlementUnsubscribe();
    this.toolSettlementListeners.clear();
    this.activeHostExecutions.clear();
    this.authorityCache.clear();
    this.pendingPreparedProviderBatches.clear();
    await this.dependencies.host.dispose?.();
  }

  /**
   * Per-Turn settlement wake for the native delivery pump: fires whenever a ToolCall of the Turn
   * gains a terminal ToolModelResult by any dispatcher-observable path (finalize flights, approval
   * resumes and file-decision commits observed at dispatch boundaries). Firing is a wake, not a
   * result channel; the listener re-reads durable facts. Recovery-driven settlements have no live
   * pump and are discovered through EffectControlPlane.listNativePendingWork instead.
   */
  public subscribeToolSettlements(
    input: { turnId: string },
    listener: (event: { toolCallId: string }) => void
  ): () => void {
    const turnId = requireId(input.turnId, 'turnId');
    let listeners = this.toolSettlementListeners.get(turnId);
    if (!listeners) {
      listeners = new Set();
      this.toolSettlementListeners.set(turnId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.toolSettlementListeners.get(turnId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.toolSettlementListeners.delete(turnId);
    };
  }

  private emitToolSettlement(turnId: string, toolCallId: string): void {
    const listeners = this.toolSettlementListeners.get(turnId);
    if (!listeners || listeners.size === 0) return;
    for (const listener of [...listeners]) {
      try {
        listener({ toolCallId });
      } catch {
        // A delivery-pump wake must never break the settling dispatch.
      }
    }
  }

  /**
   * Starts one durably admitted native streamed ToolCall through the Turn's shared scheduler:
   * the same classifiers, lane limits, serial ordering, approval flow and child admission barrier
   * as a Provider batch, with scheduling state shared across every native call of the Turn.
   */
  public scheduleAdmittedCall(
    input: ReliableAgentToolDispatchInput
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    if (this.handoff) return Promise.reject(this.handoff);
    const turnId = requireId(input.turnId, 'turnId');
    let scheduler = this.nativeTurnSchedulers.get(turnId);
    if (!scheduler) {
      const created = new NativeTurnToolScheduler(
        (call) => this.planAdmittedCall(call),
        (planned, signal, admission) => this.executeAdmittedCall(planned, signal, admission),
        (call, reason) => this.settleCancelledCapability(call, reason),
        () => {
          if (this.nativeTurnSchedulers.get(turnId) === created) {
            this.nativeTurnSchedulers.delete(turnId);
          }
        }
      );
      scheduler = created;
      this.nativeTurnSchedulers.set(turnId, scheduler);
    }
    const task = scheduler.schedule(input);
    this.activeBatchDispatches.set(task, { turnId, controller: scheduler.controller });
    this.activeDispatches.add(task);
    void task.finally(() => {
      this.activeBatchDispatches.delete(task);
      this.activeDispatches.delete(task);
    }).catch(() => undefined);
    return task;
  }

  private async planAdmittedCall(input: ReliableAgentToolDispatchInput): Promise<PlannedNativeCall> {
    const turnId = requireId(input.turnId, 'turnId');
    const preflight = await this.resolveToolBatchPreflight([input], turnId);
    const decision = preflight.frozenDecisionsById.get(input.toolCallId);
    if (!decision) throw new Error(`Native ToolCall ${input.toolCallId} lacks a frozen policy snapshot.`);
    const definitionsByName = new Map(
      preflight.definitions.map((definition) => [definition.declaration.name, definition])
    );
    return {
      input,
      preflight,
      laneKind: nativeSchedulingLaneKind(input, definitionsByName),
      serial: decision.schedulingMode !== 'parallel'
    };
  }

  private async executeAdmittedCall(
    planned: PlannedNativeCall,
    signal: AbortSignal,
    specialAdmission?: BoundedAdmissionControl
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    const { input, preflight } = planned;
    const policy = authorityPolicy(preflight.baseAuthority.document);
    const result = await (async (): Promise<InternalDispatchResult> => {
      this.admissionSignals.set(input.toolCallId, signal);
      try {
        const definitionMismatch = preflight.providerDefinitionMismatches.get(input.toolCallId);
        if (definitionMismatch) return await this.reject(input, definitionMismatch);
        return await this.dispatchInternal(input, {
          skipInitialFinalization: true,
          assumeFresh: preflight.freshCallIds.has(input.toolCallId),
          toolCall: preflight.toolCallsById.get(input.toolCallId),
          frozenDecision: preflight.frozenDecisionsById.get(input.toolCallId),
          skipProviderDefinitionCheck: true,
          deferNoEffectSettlement: false,
          definitions: preflight.definitions,
          authority: callAuthority(preflight.baseAuthority, policy, callTool(preflight.definitions, input.toolName)),
          ...(specialAdmission ? { specialAdmission } : {})
        });
      } catch (error) {
        if (isExecutionHandoffError(error)) throw error;
        return this.settleDispatchFailure(
          input,
          `tool-native-schedule:${input.toolCallId}:dispatcher-failed`,
          error,
          false
        );
      } finally {
        if (this.admissionSignals.get(input.toolCallId) === signal) {
          this.admissionSignals.delete(input.toolCallId);
        }
      }
    })();
    if (isDeferredNoEffectSettlement(result)) {
      throw new Error('Native scheduled ToolCall leaked a deferred readonly settlement.');
    }
    await this.dependencies.effects.finalizeReadyInOrder(input.turnId);
    if (!isToolSettledResult(result)) return result;
    return await this.dependencies.effects.readTerminalResult(result.toolCallId, false) ?? result;
  }

  public async quiesce(reason: ExecutionHandoffError): Promise<void> {
    this.handoff = reason;
    this.pendingPreparedProviderBatches.clear();
    for (const scheduler of this.nativeTurnSchedulers.values()) {
      if (!scheduler.controller.signal.aborted) scheduler.controller.abort(reason);
    }
    this.nativeTurnSchedulers.clear();
    await this.dependencies.host.quiesce?.(reason);
    for (const batch of this.activeBatchDispatches.values()) {
      if (!batch.controller.signal.aborted) batch.controller.abort(reason);
    }
    const completions: Promise<unknown>[] = [];
    for (const execution of this.activeHostExecutions.values()) {
      if (!execution.controller.signal.aborted) execution.controller.abort(reason);
      completions.push(execution.completion);
    }
    await Promise.allSettled([...completions, ...this.activeDispatches]);
  }

  public async definitions(turnId?: string): Promise<ReliableAgentToolDefinition[]> {
    const available = await this.dependencies.host.definitions();
    const definitions = turnId
      ? await this.definitionsForTurn(available, turnId)
      : available;
    const nativeAsyncTools = turnId === undefined
      ? undefined
      : nativeAsyncEnabledTools(await this.readAuthority(turnId));
    return definitions.map((definition) => {
      const name = requireText(definition.declaration.name, 'Tool declaration.name');
      const metadata = nativeAsyncToolMetadata(
        toolConfigKey(definition.declaration),
        definition.declaration.metadata
          ? normalizePlainJson(definition.declaration.metadata, `Tool ${name} metadata`)
          : undefined,
        nativeAsyncTools
      );
      return {
        name,
        description: typeof definition.declaration.description === 'string'
          ? definition.declaration.description
          : '',
        parameters: normalizePlainJson(definition.declaration.parameters ?? {}, `Tool ${name} parameters`),
        ...(definition.declaration.source
          ? { source: normalizePlainJson(definition.declaration.source, `Tool ${name} source`) }
          : {}),
        ...(metadata ? { metadata } : {}),
        ...(definition.declaration.defaultConfig
          ? { defaultConfig: normalizePlainJson(definition.declaration.defaultConfig, `Tool ${name} default config`) }
          : {})
      };
    });
  }

  public async freezeCall(
    input: ReliableAgentToolDispatchInput & { definition: ReliableAgentToolDefinition }
  ): Promise<FrozenToolCallPolicyDecision> {
    const decisions = await this.freezeCalls([input]);
    return decisions[0];
  }

  public async freezeCalls(
    inputs: ReadonlyArray<ReliableAgentToolDispatchInput & { definition: ReliableAgentToolDefinition }>
  ): Promise<FrozenToolCallPolicyDecision[]> {
    if (inputs.length === 0) return [];
    const turnId = requireId(inputs[0].turnId, 'turnId');
    if (inputs.some((input) => input.turnId !== turnId)) {
      throw new Error('freezeCalls requires every Provider call to belong to the same Turn.');
    }
    const [authority, liveDefinitions] = await Promise.all([
      this.readAuthority(turnId),
      this.dependencies.host.definitions()
    ]);
    const policy = authorityPolicy(authority.document);
    const liveByName = new Map(liveDefinitions.map((definition) => [definition.declaration.name, definition]));
    const decisions = inputs.map((input) => {
      if (input.definition.name !== input.toolName) {
        throw new Error('Frozen Tool definition name does not match Provider call.');
      }
      const liveCandidate = liveByName.get(input.toolName);
      const live = liveCandidate && sameToolSource(liveCandidate.declaration.source, input.definition.source)
        ? liveCandidate
        : undefined;
      return this.freezeDecision(input, live, callAuthority(authority, policy,
        { name: input.definition.name, source: plainOptionalRecord(input.definition.source) }));
    });
    this.rememberPreparedProviderBatch(inputs, decisions, liveDefinitions, authority);
    return decisions;
  }

  public confirmPreparedBatch(
    input: ReliableAgentToolBatchConfirmationInput
  ): ReliableAgentToolBatchAdmission | undefined {
    if (this.handoff) return undefined;
    const prepared = this.pendingPreparedProviderBatches.get(input.modelRequestId);
    this.pendingPreparedProviderBatches.delete(input.modelRequestId);
    if (
      !prepared
      || prepared.turnId !== input.turnId
      || prepared.modelRequestId !== input.modelRequestId
      || input.creation.deduplicated
      || !input.creation.commitSeq
      || input.creation.batchId !== input.batchId
      || input.creation.calls.length !== input.calls.length
      || prepared.entriesById.size !== input.calls.length
    ) return undefined;
    if (!/^[1-9]\d*$/.test(input.creation.commitSeq)) return undefined;

    const recipeByName = new Map<string, ReliableAgentToolDefinition[]>();
    for (const definition of input.recipeDefinitions) {
      const bucket = recipeByName.get(definition.name) ?? [];
      bucket.push(definition);
      recipeByName.set(definition.name, bucket);
    }
    const liveByName = new Map(prepared.definitions.map((definition) => [definition.declaration.name, definition]));
    const createdById = new Map(input.creation.calls.map((call) => [call.toolCallId, call]));
    const checkedEntries = new Map<string, CheckedProviderToolEntry>();
    for (const call of input.calls) {
      const pending = prepared.entriesById.get(call.toolCallId);
      const created = createdById.get(call.toolCallId);
      if (
        !pending
        || pending.identity !== preparedToolInputIdentity(call)
        || canonicalPlainJson(pending.policy, 'Prepared Tool policy')
          !== canonicalPlainJson(call.policy, 'Confirmed Tool policy')
        || !created
        || created.providerOrdinal !== call.providerOrdinal
        || !created.toolExecutionId
        || !/^[1-9]\d*$/.test(created.callSeq)
      ) return undefined;
      const recipeMatches = recipeByName.get(call.toolName) ?? [];
      let definitionMismatch: string | undefined;
      if (recipeMatches.length !== 1) {
        definitionMismatch = `ModelRequest recipe 中工具 ${call.toolName} 不是唯一声明。`;
      } else if (!sameReliableToolDefinition(recipeMatches[0], pending.frozenDefinition)) {
        return undefined;
      } else {
        const live = liveByName.get(call.toolName);
        if (live && !sameToolSource(live.declaration.source, recipeMatches[0].source)) {
          definitionMismatch = `工具 ${call.toolName} 的当前 capability source 与 Provider 请求冻结 source 不一致；拒绝跨源执行。`;
        }
      }
      checkedEntries.set(call.toolCallId, {
        ...pending,
        toolCall: {
          id: call.toolCallId,
          turn_id: input.turnId,
          tool_name: call.toolName,
          status: 'pending',
          call_seq: BigInt(created.callSeq)
        },
        ...(definitionMismatch ? { definitionMismatch } : {})
      });
    }
    if (checkedEntries.size !== input.calls.length) return undefined;
    const token = {};
    this.checkedProviderBatchAdmissions.set(token, {
      turnId: input.turnId,
      modelRequestId: input.modelRequestId,
      definitions: prepared.definitions,
      authority: prepared.authority,
      entriesById: checkedEntries,
      remainingCallIds: new Set(checkedEntries.keys())
    });
    return Object.freeze({ kind: 'checked-provider-tool-batch', token });
  }

  private rememberPreparedProviderBatch(
    inputs: ReadonlyArray<ReliableAgentToolDispatchInput & { definition: ReliableAgentToolDefinition }>,
    decisions: readonly FrozenToolCallPolicyDecision[],
    definitions: readonly ToolDefinition[],
    authority: ReliableToolDispatchAuthority
  ): void {
    const modelRequestIds = new Set(inputs.map((input) => input.modelRequestId));
    const toolCallIds = new Set(inputs.map((input) => input.toolCallId));
    if (
      inputs.length === 0
      || decisions.length !== inputs.length
      || modelRequestIds.size !== 1
      || toolCallIds.size !== inputs.length
    ) return;
    const modelRequestId = inputs[0].modelRequestId;
    const entriesById = new Map<string, PreparedProviderToolEntry>();
    for (let index = 0; index < inputs.length; index += 1) {
      entriesById.set(inputs[index].toolCallId, {
        identity: preparedToolInputIdentity(inputs[index]),
        frozenDefinition: inputs[index].definition,
        policy: decisions[index]
      });
    }
    this.pendingPreparedProviderBatches.set(modelRequestId, {
      turnId: inputs[0].turnId,
      modelRequestId,
      definitions: Object.freeze([...definitions]),
      authority: {
        snapshotId: authority.snapshotId,
        document: authority.document
      },
      entriesById
    });
    while (this.pendingPreparedProviderBatches.size > 64) {
      const oldest = this.pendingPreparedProviderBatches.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingPreparedProviderBatches.delete(oldest);
    }
  }

  private freezeDecision(
    input: ReliableAgentToolDispatchInput & { definition: ReliableAgentToolDefinition },
    live: ToolDefinition | undefined,
    authority: ReliableToolDispatchAuthority
  ): FrozenToolCallPolicyDecision {
    const policy = authorityPolicy(authority.document);
    const metadata = live?.declaration.metadata
      ?? plainOptionalRecord(input.definition.metadata) as ToolDefinitionMetadataRecord | undefined;
    const config = authority.toolConfig;
    const yolo = policy.preset === 'yolo';
    const supportsChangeApply = FILE_TOOLS.has(input.toolName) || metadata?.supportsChangeApply === true;
    const commandClassification = PROCESS_TOOLS.has(input.toolName)
      ? classifyCommandCall(input.arguments)
      : undefined;
    const scheduling = commandClassification
      ? frozenCommandScheduling(commandClassification, input.arguments)
      : live?.scheduling?.(input.arguments, { toolName: input.toolName })
        ?? frozenSchedulingFallback(input.definition, input.arguments);
    const command = PROCESS_TOOLS.has(input.toolName)
      ? optionalText(requireRecord(input.arguments, `${input.toolName} arguments`).command)
      : '';
    // A child Turn's call is automatic only where its own settings and every ancestor Turn's agree.
    const sides = [
      { preset: policy.preset, toolConfig: config },
      ...(authority.inheritedToolConfigs ?? [])
    ].map((side) => sideAutomation(input, metadata, supportsChangeApply, command, side.preset === 'yolo', side.toolConfig));
    const automaticChangeApply = sides.every((side) => side.automaticChangeApply);
    const delay = automaticChangeApply ? Math.max(...sides.map((side) => side.changeApplyDelaySeconds)) : 0;
    const executionAutomatic = sides.every((side) => side.executionAutomatic);
    const summary = live?.summary?.(input.arguments, {
      toolName: input.toolName,
      argsJson: canonicalPlainJson(input.arguments, `Tool ${input.toolName} summary arguments`)
    });
    return {
      ...(summary?.trim() ? { summary: summary.trim() } : {}),
      displayAutoExpand: config?.display?.autoExpand ?? metadata?.defaultAutoExpand ?? false,
      displayAutoOpenDiff: yolo
        ? false
        : config?.display?.autoOpenDiffPreview
          ?? metadata?.defaultAutoOpenDiffPreview
          ?? false,
      executionGate: executionAutomatic ? 'automatic' : 'approval_required',
      changeApplyMode: supportsChangeApply
        ? automaticChangeApply ? 'automatic' : 'manual'
        : 'unsupported',
      changeApplyDelaySeconds: delay,
      autoSubmitResult: sides.every((side) => side.autoSubmitResult),
      schedulingMode: scheduling.mode,
      ...(scheduling.reason ? { schedulingReason: scheduling.reason } : {})
    };
  }

  public async cancelWaiting(input: { turnId: string; sourceKey: string; reason: string }): Promise<void> {
    const turnId = requireId(input.turnId, 'turnId');
    const sourceKey = requireText(input.sourceKey, 'sourceKey');
    const reason = requireText(input.reason, 'reason');
    await this.cancelActive({ turnId, reason });
    const ownerLinks = (await listAllDomainRows(this.dependencies.database, 'InteractionOwnerLink', {
      turn_id: turnId
    }))
      .sort((left, right) => String(left.request_id).localeCompare(String(right.request_id)));
    for (const owner of ownerLinks) {
      const requestId = requireId(owner.request_id, 'InteractionOwnerLink.request_id');
      const requests = await this.list('InteractionRequest', { id: requestId }, 2);
      if (requests.length !== 1) throw new Error(`InteractionRequest ${requestId} must exist exactly once.`);
      if (requests[0].status !== 'pending') continue;
      const toolLinks = await this.list('InteractionToolCallLink', { request_id: requestId }, 2);
      if (toolLinks.length !== 1) throw new Error(`InteractionRequest ${requestId} must have one ToolCall link.`);
      const toolCallId = requireId(toolLinks[0].tool_call_id, 'InteractionToolCallLink.tool_call_id');
      if (requests[0].request_kind === 'ask_user') {
        await this.dependencies.interactions.resolveAskUser({
          source: { kind: 'command', key: `${sourceKey}:ask-user:${requestId}` },
          requestId,
          response: { reason },
          cancelled: true
        });
        continue;
      }
      if (requests[0].request_kind === 'file_change_approval') {
        const changeSets = await this.list('FileChangeSet', { tool_call_id: toolCallId }, 2);
        if (changeSets.length !== 1) throw new Error(`File approval ${requestId} must have one FileChangeSet.`);
        await this.dependencies.files.decide({
          source: { kind: 'command', key: `${sourceKey}:file-change:${requestId}` },
          changeSetId: requireId(changeSets[0].id, 'FileChangeSet.id'),
          decision: 'cancelled',
          response: { reason }
        });
        continue;
      }
      if (requests[0].request_kind === 'plan_review') {
        await this.dependencies.interactions.resolvePlanReview({
          source: { kind: 'command', key: `${sourceKey}:plan-review:${requestId}` },
          requestId,
          decision: 'cancel',
          response: { reason }
        });
        continue;
      }
      if (requests[0].request_kind === 'exec_approval') {
        await this.dependencies.interactions.resolveExecutionApproval({
          source: { kind: 'command', key: `${sourceKey}:execution-approval:${requestId}` },
          requestId,
          decision: 'cancel',
          response: { reason }
        });
        continue;
      }
      throw new Error(`Unsupported pending InteractionRequest kind: ${String(requests[0].request_kind)}.`);
    }
  }

  public async cancelActive(input: { turnId: string; reason: string }): Promise<void> {
    const turnId = requireId(input.turnId, 'turnId');
    const reason = requireText(input.reason, 'reason');
    const cancellation = new Error(reason);
    cancellation.name = 'TurnCancellationError';
    const completions: Promise<unknown>[] = [];
    for (const [completion, batch] of this.activeBatchDispatches) {
      if (batch.turnId === turnId && !batch.controller.signal.aborted) {
        batch.controller.abort(cancellation);
      }
      if (batch.turnId === turnId) completions.push(completion);
    }
    for (const execution of this.activeHostExecutions.values()) {
      if (execution.turnId === turnId && !execution.controller.signal.aborted) {
        execution.controller.abort(cancellation);
      }
      if (execution.turnId === turnId) completions.push(execution.completion);
    }
    await this.dependencies.host.cancelTurnWaits?.({ turnId, reason });
    if (completions.length > 0) {
      await waitForSettlementsOrGrace(completions, CANCEL_ACTIVE_GRACE_MS);
    }
  }

  public async quiesceTurn(input: { turnId: string; reason: ExecutionHandoffError }): Promise<void> {
    const turnId = requireId(input.turnId, 'turnId');
    const completions: Promise<unknown>[] = [];
    for (const [completion, batch] of this.activeBatchDispatches) {
      if (batch.turnId === turnId && !batch.controller.signal.aborted) {
        batch.controller.abort(input.reason);
      }
      if (batch.turnId === turnId) completions.push(completion);
    }
    for (const execution of this.activeHostExecutions.values()) {
      if (execution.turnId === turnId && !execution.controller.signal.aborted) {
        execution.controller.abort(input.reason);
      }
      if (execution.turnId === turnId) completions.push(execution.completion);
    }
    await Promise.allSettled(completions);
  }

  public dispatch(
    input: ReliableAgentToolDispatchInput
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    if (this.handoff) return Promise.reject(this.handoff);
    const task = this.dispatchInternal(input).then((result) => {
      if (isDeferredNoEffectSettlement(result)) {
        throw new Error('Single ToolCall dispatch leaked a deferred readonly settlement.');
      }
      return result;
    });
    this.activeDispatches.add(task);
    void task.finally(() => this.activeDispatches.delete(task)).catch(() => undefined);
    return task;
  }

  public dispatchBatch(
    inputs: readonly ReliableAgentToolDispatchInput[],
    options: { admission?: ReliableAgentToolBatchAdmission } = {}
  ): Promise<Array<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled>> {
    if (this.handoff) return Promise.reject(this.handoff);
    if (inputs.length === 0) return Promise.resolve([]);
    const turnId = requireId(inputs[0].turnId, 'turnId');
    const controller = new AbortController();
    const task = this.dispatchBatchInternal(inputs, controller.signal, options.admission);
    this.activeBatchDispatches.set(task, { turnId, controller });
    this.activeDispatches.add(task);
    void task.finally(() => {
      this.activeBatchDispatches.delete(task);
      this.activeDispatches.delete(task);
    }).catch(() => undefined);
    return task;
  }

  private async resolveToolBatchPreflight(
    inputs: readonly ReliableAgentToolDispatchInput[],
    turnId: string,
    admission?: ReliableAgentToolBatchAdmission
  ): Promise<ResolvedToolBatchPreflight> {
    const checked = this.consumeCheckedProviderBatch(inputs, turnId, admission);
    if (checked) return checked;

    const [definitions, baseAuthority, preflight] = await Promise.all([
      this.dependencies.host.definitions(),
      this.readAuthority(turnId),
      this.dependencies.database.snapshot(inputs.flatMap((input) => [
        DOMAIN_REPOSITORIES.domain('ToolCall').get(input.toolCallId),
        DOMAIN_REPOSITORIES.domain('Operation').list({ where: { tool_call_id: input.toolCallId }, limit: 1 }),
        DOMAIN_REPOSITORIES.domain('ToolOutcome').list({ where: { tool_call_id: input.toolCallId }, limit: 1 }),
        DOMAIN_REPOSITORIES.domain('FileChangeSet').list({ where: { tool_call_id: input.toolCallId }, limit: 1 }),
        DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({ where: { tool_call_id: input.toolCallId }, limit: 2 }),
        DOMAIN_REPOSITORIES.domain('ToolCallPolicySnapshot').list({ where: { tool_call_id: input.toolCallId }, limit: 2 })
      ]))
    ]);
    const freshCallIds = new Set<string>();
    const toolCallsById = new Map<string, DomainRow>();
    const frozenDecisionsById = new Map<string, FrozenToolCallPolicyDecision>();
    const internalCallIds = new Set<string>();
    const definitionsByName = new Map(definitions.map((definition) => [definition.declaration.name, definition]));
    const policy = authorityPolicy(baseAuthority.document);
    for (let index = 0; index < inputs.length; index += 1) {
      const offset = index * 6;
      const call = preflight.snapshot[offset];
      const operations = preflight.snapshot[offset + 1];
      const outcomes = preflight.snapshot[offset + 2];
      const changeSets = preflight.snapshot[offset + 3];
      const sourceLinks = preflight.snapshot[offset + 4];
      const policySnapshots = preflight.snapshot[offset + 5];
      if (!call || Array.isArray(call) || call.turn_id !== turnId) {
        throw new Error(`ToolCall ${inputs[index].toolCallId} does not belong to dispatchBatch Turn ${turnId}.`);
      }
      if (
        !Array.isArray(operations)
        || !Array.isArray(outcomes)
        || !Array.isArray(changeSets)
        || !Array.isArray(sourceLinks)
        || !Array.isArray(policySnapshots)
      ) {
        throw new TypeError('Tool dispatch batch preflight snapshot shape is invalid.');
      }
      toolCallsById.set(inputs[index].toolCallId, call);
      if (sourceLinks.length > 1 || policySnapshots.length > 1) {
        throw new Error(`ToolCall ${inputs[index].toolCallId} has duplicate frozen facts.`);
      }
      if (sourceLinks.length === 1) {
        if (sourceLinks[0].model_request_id !== inputs[index].modelRequestId || policySnapshots.length !== 1) {
          throw new Error(`Provider ToolCall ${inputs[index].toolCallId} has inconsistent frozen source facts.`);
        }
        frozenDecisionsById.set(inputs[index].toolCallId, frozenPolicyFromRow(policySnapshots[0]));
      } else {
        if (policySnapshots.length !== 0) {
          throw new Error(`Internal ToolCall ${inputs[index].toolCallId} has an orphan policy snapshot.`);
        }
        internalCallIds.add(inputs[index].toolCallId);
        const definition = definitionsByName.get(inputs[index].toolName);
        if (definition) {
          const authority = callAuthority(baseAuthority, policy, definition.declaration);
          frozenDecisionsById.set(inputs[index].toolCallId, this.freezeDecision({
            ...inputs[index],
            definition: reliableDefinitionFromTool(definition)
          }, definition, authority));
        }
      }
      if (call.status === 'pending' && operations.length === 0 && outcomes.length === 0 && changeSets.length === 0) {
        freshCallIds.add(inputs[index].toolCallId);
      }
    }
    const providerDefinitionMismatches = await this.providerDefinitionMismatchesForBatch(
      inputs.filter((input) => !internalCallIds.has(input.toolCallId)),
      definitionsByName
    );
    return {
      definitions,
      baseAuthority,
      freshCallIds,
      toolCallsById,
      frozenDecisionsById,
      internalCallIds,
      providerDefinitionMismatches
    };
  }

  private consumeCheckedProviderBatch(
    inputs: readonly ReliableAgentToolDispatchInput[],
    turnId: string,
    admission?: ReliableAgentToolBatchAdmission
  ): ResolvedToolBatchPreflight | undefined {
    if (
      !admission
      || admission.kind !== 'checked-provider-tool-batch'
      || !admission.token
      || typeof admission.token !== 'object'
    ) return undefined;
    const checked = this.checkedProviderBatchAdmissions.get(admission.token);
    if (!checked || checked.turnId !== turnId) return undefined;
    const selected: CheckedProviderToolEntry[] = [];
    for (const input of inputs) {
      const entry = checked.entriesById.get(input.toolCallId);
      if (
        !entry
        || !checked.remainingCallIds.has(input.toolCallId)
        || input.modelRequestId !== checked.modelRequestId
        || entry.identity !== preparedToolInputIdentity(input)
      ) return undefined;
      selected.push(entry);
    }
    const freshCallIds = new Set<string>();
    const toolCallsById = new Map<string, DomainRow>();
    const frozenDecisionsById = new Map<string, FrozenToolCallPolicyDecision>();
    const providerDefinitionMismatches = new Map<string, string>();
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const entry = selected[index];
      checked.remainingCallIds.delete(input.toolCallId);
      freshCallIds.add(input.toolCallId);
      toolCallsById.set(input.toolCallId, entry.toolCall);
      frozenDecisionsById.set(input.toolCallId, entry.policy);
      if (entry.definitionMismatch) {
        providerDefinitionMismatches.set(input.toolCallId, entry.definitionMismatch);
      }
    }
    if (checked.remainingCallIds.size === 0) {
      this.checkedProviderBatchAdmissions.delete(admission.token);
    }
    return {
      definitions: checked.definitions,
      baseAuthority: checked.authority,
      freshCallIds,
      toolCallsById,
      frozenDecisionsById,
      internalCallIds: new Set(),
      providerDefinitionMismatches
    };
  }

  private async dispatchBatchInternal(
    inputs: readonly ReliableAgentToolDispatchInput[],
    parentSignal?: AbortSignal,
    admission?: ReliableAgentToolBatchAdmission
  ): Promise<Array<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled>> {
    if (inputs.length === 0) return [];
    const turnId = requireId(inputs[0].turnId, 'turnId');
    if (inputs.some((input) => input.turnId !== turnId)) {
      throw new Error('dispatchBatch requires every ToolCall to belong to the same Turn.');
    }
    const {
      definitions,
      baseAuthority,
      freshCallIds,
      toolCallsById,
      frozenDecisionsById,
      providerDefinitionMismatches
    } = await this.resolveToolBatchPreflight(inputs, turnId, admission);
    const definitionsByName = new Map(definitions.map((definition) => [definition.declaration.name, definition]));
    const policy = authorityPolicy(baseAuthority.document);
    type IndexedInput = { input: ReliableAgentToolDispatchInput; index: number };
    const indexed = inputs.map((input, index): IndexedInput => ({ input, index }));
    const requiresChildAdmission = (input: ReliableAgentToolDispatchInput): boolean =>
      input.toolName === 'run_agent'
      && ['spawn', 'send'].includes(optionalText(plainOptionalRecord(input.arguments)?.operation) ?? '');
    const childInputs = indexed.filter(({ input }) => requiresChildAdmission(input));
    const processOrMcpInputs = indexed.filter(({ input }) =>
      !requiresChildAdmission(input) && (
        PROCESS_TOOLS.has(input.toolName)
        || definitionsByName.get(input.toolName)?.declaration.source?.kind === 'mcp'
      ));
    const ordinaryInputs = indexed.filter(({ input }) =>
      !requiresChildAdmission(input)
      && !PROCESS_TOOLS.has(input.toolName)
      && definitionsByName.get(input.toolName)?.declaration.source?.kind !== 'mcp');
    const attachmentInputs = ordinaryInputs.filter(({ input }) => isAttachmentReadInput(input));
    // Attachment reads settle inside their own two-slot lane as soon as each file is materialized.
    // Keep large base64 payloads out of the ordinary batch accumulator and bound simultaneous
    // file/base64/CAS copies independently from cheap text reads.
    const batchableOrdinaryInputs = ordinaryInputs.filter(({ input }) => !isAttachmentReadInput(input));
    const dispatchOutcomes = new Array<PromiseSettledResult<InternalDispatchResult>>(inputs.length);
    const dispatchOne = async (
      input: ReliableAgentToolDispatchInput,
      signal: AbortSignal,
      admission?: BoundedAdmissionControl
    ): Promise<InternalDispatchResult> => {
      this.admissionSignals.set(input.toolCallId, signal);
      try {
        const definitionMismatch = providerDefinitionMismatches.get(input.toolCallId);
        if (definitionMismatch) return await this.reject(input, definitionMismatch);
        return await this.dispatchInternal(input, {
          skipInitialFinalization: true,
          assumeFresh: freshCallIds.has(input.toolCallId),
          toolCall: toolCallsById.get(input.toolCallId),
          frozenDecision: frozenDecisionsById.get(input.toolCallId),
          skipProviderDefinitionCheck: true,
          deferNoEffectSettlement: !isAttachmentReadInput(input),
          definitions,
          authority: callAuthority(baseAuthority, policy, callTool(definitions, input.toolName)),
          ...(admission ? { specialAdmission: admission } : {})
        });
      } catch (error) {
        if (isExecutionHandoffError(error)) throw error;
        return this.settleDispatchFailure(
          input,
          `tool-dispatch-batch:${input.toolCallId}:dispatcher-failed`,
          error,
          false
        );
      } finally {
        if (this.admissionSignals.get(input.toolCallId) === signal) {
          this.admissionSignals.delete(input.toolCallId);
        }
      }
    };
    const collect = async (
      lane: readonly IndexedInput[],
      outcomes: Promise<PromiseSettledResult<InternalDispatchResult>[]>,
      settleReadonlyImmediately = false
    ): Promise<void> => {
      const settled = [...await outcomes];
      if (settleReadonlyImmediately) {
        const deferred = settled.flatMap((outcome) =>
          outcome.status === 'fulfilled' && isDeferredNoEffectSettlement(outcome.value)
            ? [outcome.value]
            : []);
        if (deferred.length > 0) {
          const settlements = await this.dependencies.effects.settleWithoutEffectBatch({
            turnId,
            settlements: deferred.map((entry) => ({
              source: entry.source,
              toolCallId: entry.toolCallId,
              status: entry.status,
              detail: entry.detail
            }))
          });
          const settledById = new Map(settlements.map((entry) => [entry.toolCallId, {
            disposition: 'settled' as const,
            toolCallId: entry.toolCallId,
            status: entry.status
          }]));
          for (let index = 0; index < settled.length; index += 1) {
            const outcome = settled[index];
            if (outcome.status !== 'fulfilled' || !isDeferredNoEffectSettlement(outcome.value)) continue;
            const replacement = settledById.get(outcome.value.toolCallId);
            if (!replacement) {
              throw new Error(`Readonly ToolCall ${outcome.value.toolCallId} lacks its lane settlement.`);
            }
            settled[index] = { status: 'fulfilled', value: replacement };
          }
          // The Provider-visible ToolOutcome still obeys call order, but the readonly artifact and
          // Operation become durable as soon as the ordinary lane finishes instead of waiting for a
          // slow child/process/MCP sibling lane.
          await this.dependencies.effects.finalizeReadyInOrder(turnId);
        }
      }
      for (let index = 0; index < lane.length; index += 1) {
        dispatchOutcomes[lane[index].index] = settled[index];
      }
    };
    await Promise.all([
      collect(batchableOrdinaryInputs, mapSettledWithBoundedConcurrency(
        batchableOrdinaryInputs,
        MAX_CONCURRENT_ORDINARY_TOOLS_PER_TURN,
        ({ input }, _index, signal) => dispatchOne(input, signal),
        parentSignal
      ), true),
      collect(attachmentInputs, mapSettledWithBoundedConcurrency(
        attachmentInputs,
        MAX_CONCURRENT_ATTACHMENT_READS_PER_TURN,
        ({ input }, _index, signal) => dispatchOne(input, signal),
        parentSignal
      )),
      collect(processOrMcpInputs, mapSettledWithBoundedConcurrency(
        processOrMcpInputs,
        MAX_CONCURRENT_PROCESS_OR_MCP_TOOLS_PER_TURN,
        ({ input }, _index, signal) => dispatchOne(input, signal),
        parentSignal
      )),
      collect(childInputs, mapSettledWithBoundedAdmissionConcurrency(
        childInputs,
        MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN,
        ({ input }, _index, signal, admission) => dispatchOne(input, signal, admission),
        parentSignal
      ))
    ]);
    const rejected = dispatchOutcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );
    if (rejected) throw rejected.reason;
    const rawResults = dispatchOutcomes.map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason;
      return outcome.value;
    });
    const deferred = rawResults.filter(isDeferredNoEffectSettlement);
    let settledById = new Map<string, ReliableAgentToolSettled>();
    if (deferred.length > 0) {
      const settlements = await this.dependencies.effects.settleWithoutEffectBatch({
        turnId,
        settlements: deferred.map((entry) => ({
          source: entry.source,
          toolCallId: entry.toolCallId,
          status: entry.status,
          detail: entry.detail
        }))
      });
      settledById = new Map(settlements.map((entry) => [entry.toolCallId, {
        disposition: 'settled' as const,
        toolCallId: entry.toolCallId,
        status: entry.status
      }]));
    }
    const results: Array<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> = rawResults.map((result) => {
      if (!isDeferredNoEffectSettlement(result)) return result;
      const settled = settledById.get(result.toolCallId);
      if (!settled) throw new Error(`Readonly ToolCall ${result.toolCallId} lacks its batch settlement.`);
      return settled;
    });
    const finalized = await this.dependencies.effects.finalizeReadyInOrder(turnId);
    const terminalById = new Map(finalized.map((entry) => [entry.toolCallId, entry]));
    return Promise.all(results.map(async (result) => {
      if (!isToolSettledResult(result)) return result;
      return terminalById.get(result.toolCallId)
        ?? await this.dependencies.effects.readTerminalResult(result.toolCallId, false)
        ?? result;
    }));
  }

  private async dispatchInternal(
    input: ReliableAgentToolDispatchInput,
    options: {
      skipInitialFinalization?: boolean;
      assumeFresh?: boolean;
      toolCall?: DomainRow;
      frozenDecision?: FrozenToolCallPolicyDecision;
      skipProviderDefinitionCheck?: boolean;
      deferNoEffectSettlement?: boolean;
      definitions?: readonly ToolDefinition[];
      authority?: ReliableToolDispatchAuthority;
      specialAdmission?: ReliableSpecialToolAdmission;
    } = {}
  ): Promise<InternalDispatchResult> {
    if (!options.skipInitialFinalization) {
      await this.dependencies.effects.finalizeReadyInOrder(input.turnId);
    }
    const replay = options.assumeFresh
      ? null
      : await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    if (replay) return replay;
    // A later member of a parallel Provider batch may have durably settled while an earlier
    // call still blocks ordered ToolOutcome creation. Recovery must return that settlement fact,
    // never invoke the capability/effect a second time merely because ToolOutcome is not visible.
    const readySettlement = options.assumeFresh
      ? undefined
      : await this.readReadySettlement(input.toolCallId, !options.skipInitialFinalization);
    if (readySettlement) return readySettlement;
    const existingPause = options.assumeFresh ? undefined : await this.readExistingPause(input.toolCallId);
    if (existingPause) {
      return await this.autoApproveInteraction(input, existingPause) ?? existingPause;
    }
    const definitions = options.definitions ?? await this.dependencies.host.definitions();
    const definition = definitions.find((candidate) => candidate.declaration.name === input.toolName);
    if (!definition) return this.reject(input, `未知工具：${input.toolName}`);
    const definitionMismatch = options.skipProviderDefinitionCheck
      ? undefined
      : await this.providerDefinitionMismatch(input, definition);
    if (definitionMismatch) return this.reject(input, definitionMismatch);
    const authority = options.authority ?? await this.readAuthority(input.turnId, definition.declaration);
    const policy = authorityPolicy(authority.document);
    if (isCrossConversationTool(input.toolName)) {
      if (!crossConversationSwitchOn(policy.toolConfigs) || !await this.topLevelTurn(input.turnId)) {
        return this.reject(input, `当前 Turn 未开启跨对话协作，或当前对话是子 Agent 对话，不允许工具 ${input.toolName}。`);
      }
      if (!crossConversationToolPermitted(policy.allowedTools, input.toolName)) {
        return this.reject(input, `当前 Turn 的工具策略不含 run_agent，跨对话协作只允许列出和读取对话，不允许工具 ${input.toolName}。`);
      }
    }
    if (!definitionAllowedByAuthority(policy, definition)) {
      return this.reject(input, `冻结 ToolPolicy 不允许工具 ${input.toolName}。`);
    }
    if (input.toolName !== 'submit_plan' && definition.declaration.source?.kind !== 'mcp') {
      const calls = options.toolCall
        ? [options.toolCall]
        : await this.list('ToolCall', { id: input.toolCallId }, 2);
      if (calls.length !== 1) throw new Error(`ToolCall ${input.toolCallId} does not exist exactly once.`);
      const planReview = await authorizeFrozenPlanReview({
        database: this.dependencies.database,
        contentStore: this.dependencies.contentStore,
        authorityDocument: authority.document,
        turnId: input.turnId,
        beforeCallSeq: requireBigInt(calls[0].call_seq, 'ToolCall.call_seq'),
        riskLevel: frozenPlanReviewRiskLevel(definition, input)
      });
      if (!planReview.allowed) {
        return this.reject(input, planReview.reason ?? '冻结 PlanReviewPolicy 拒绝本次工具调用。');
      }
    }
    if (WORK_ENVIRONMENT_TOOLS.has(input.toolName) && !authorityWorkEnvironmentPolicy(authority.document).enabled) {
      return this.reject(input, `冻结 WorkEnvironmentPolicy 已关闭，当前 Turn 不允许工具 ${input.toolName}。`);
    }
    const frozenDecision = options.frozenDecision
      ?? await this.readFrozenDecision(input, definition, authority);
    if (!frozenDecision.autoSubmitResult) {
      return this.reject(
        input,
        `工具 ${input.toolName} 的冻结 ToolPolicy 禁止自动提交结果；可靠结果确认门禁尚未启用，因此本次调用不会执行。`
      );
    }
    if (this.handoff) throw this.handoff;
    if (await this.turnTerminationRequested(input.turnId)) {
      const settled = await this.dependencies.effects.settleWithoutEffect({
        source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:turn-termination-before-dispatch` },
        toolCallId: input.toolCallId,
        status: 'cancelled',
        detail: { reason: 'Turn termination was committed before capability dispatch.' }
      });
      return this.settledResult(input.toolCallId, settled.status, settled.terminal);
    }

    if (frozenDecision.executionGate === 'approval_required' && !FILE_TOOLS.has(input.toolName)) {
      const approval = await this.executionApprovalState(input.toolCallId);
      if (approval === 'rejected' || approval === 'cancelled') {
        const cancelled = approval === 'cancelled';
        const settled = await this.dependencies.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:execution-approval-${approval}` },
          toolCallId: input.toolCallId,
          status: approval,
          detail: { reason: cancelled ? '工具执行审批已取消。' : '用户拒绝执行工具。' }
        });
        return this.settledResult(input.toolCallId, settled.status, settled.terminal);
      }
      if (approval !== 'approved') {
        const pause = approval === 'pending'
          ? await this.requirePendingExecutionApproval(input.toolCallId)
          : await this.dependencies.interactions.pauseForExecutionApproval({
              source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:execution-approval` },
              toolCallId: input.toolCallId,
              prompt: { toolName: input.toolName, arguments: input.arguments }
            });
        return {
          disposition: 'paused',
          toolCallId: input.toolCallId,
          reason: 'awaiting_approval',
          resumeKey: pause.requestId
        };
      }
    }

    if (definition.declaration.source?.kind === 'mcp') {
      return this.captureAbortableExecution(input, (signal) => this.dispatchMcp(definition, input, signal));
    }
    if (FILE_TOOLS.has(input.toolName)) {
      return this.captureAbortableExecution(input, (signal) =>
        this.dispatchFile(definition, input, authority, frozenDecision, signal));
    }
    if (PROCESS_TOOLS.has(input.toolName)) {
      return this.captureAbortableExecution(input, (signal) => this.dispatchProcess(input, authority, signal));
    }
    if (input.toolName === TRANSFER_TOOL_NAME) {
      return this.captureHostEvents(input, (emit, signal) =>
        this.dispatchWorkEnvironmentTransfer(definition, input, authority, emit, signal));
    }
    if (input.toolName === SWITCH_WORK_ENVIRONMENT_TOOL_NAME) {
      return this.dispatchWorkEnvironmentSwitch(input, authority);
    }
    if (input.toolName === 'ask_user') {
      const pause = await this.dependencies.interactions.pauseForAskUser({
        source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:ask-user` },
        toolCallId: input.toolCallId,
        prompt: input.arguments
      });
      const waiting: ReliableAgentToolPause = {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'awaiting_user',
        resumeKey: pause.requestId
      };
      return await this.autoApproveInteraction(input, waiting, authority) ?? waiting;
    }
    if (input.toolName === 'submit_plan') {
      const pause = await this.dependencies.interactions.pauseForPlanReview({
        source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:plan-review` },
        toolCallId: input.toolCallId,
        request: input.arguments
      });
      const waiting: ReliableAgentToolPause = {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'awaiting_plan_review',
        resumeKey: pause.requestId
      };
      return await this.autoApproveInteraction(input, waiting, authority) ?? waiting;
    }
    if (input.toolName === 'update_task_list') {
      const settled = await this.dependencies.interactions.settleTaskList({
        source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:task-list` },
        toolCallId: input.toolCallId,
        operation: input.arguments
      });
      return this.settledResult(input.toolCallId, settled.status, settled.terminal);
    }
    if (SPECIAL_TOOLS.has(input.toolName)) {
      return this.captureAbortableExecution(input, async (signal) => {
        const special = await this.dependencies.host.dispatchSpecial?.(
          definition,
          input,
          authority,
          signal,
          options.specialAdmission
        );
        if (special) return special;
        return this.reject(input, `工具 ${input.toolName} 尚未连接到可靠专用控制面。`);
      });
    }
    return this.dispatchNoEffect(definition, input, authority, options.deferNoEffectSettlement === true);
  }

  private async dispatchNoEffect(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    deferSettlement = false
  ): Promise<ToolTerminalResult | ReliableAgentToolSettled | DeferredNoEffectSettlement> {
    if (!this.dependencies.host.executeNoEffect) {
      return this.reject(input, `工具 ${input.toolName} 没有只读 capability adapter。`);
    }
    let result: ToolResultOut;
    try {
      result = await this.captureHostEvents(input, (emit, signal) =>
        executeBoundedNoEffect(signal, (boundedSignal) =>
          this.dependencies.host.executeNoEffect!(
            definition,
            input,
            authority,
            (event) => {
              if (!boundedSignal.aborted) emit(event);
            },
            boundedSignal
          )
        ));
    } catch (error) {
      if (isTurnCancellationError(error)) {
        return this.settleCancelledCapability(input, 'Readonly capability execution was cancelled.');
      }
      if (error instanceof NoEffectCapabilityTimeoutError) {
        const settled = await this.dependencies.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:capability-timeout` },
          toolCallId: input.toolCallId,
          status: 'failed',
          detail: { reason: error.message }
        });
        return this.settledResult(input.toolCallId, settled.status, settled.terminal);
      }
      throw error;
    }
    const status = result.ok ? 'succeeded' : 'failed';
    const detail = noEffectModelDetail(input.toolName, result);
    const source = { kind: 'internal' as const, key: `tool-dispatch:${input.toolCallId}:no-effect` };
    if (deferSettlement) {
      return { disposition: 'deferred_no_effect', source, toolCallId: input.toolCallId, status, detail };
    }
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source,
      toolCallId: input.toolCallId,
      status,
      detail
    });
    return this.settledResult(input.toolCallId, settled.status, settled.terminal);
  }

  private async dispatchFile(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    frozenDecision: FrozenToolCallPolicyDecision,
    signal: AbortSignal
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    if (!this.dependencies.host.planFileMutation) {
      return this.reject(input, `文件工具 ${input.toolName} 没有可靠 proposal planner。`);
    }
    const existing = await this.list('FileChangeSet', { tool_call_id: input.toolCallId }, 2);
    let proposal: { changeSetId: string };
    if (existing.length === 0) {
      let members: FileChangeProposalMemberInput[];
      try {
        members = await this.dependencies.host.planFileMutation(definition, input, authority, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
        const handoff = handoffReason(signal);
        if (handoff) throw handoff;
        return this.settleCancelledCapability(input, 'File proposal planning was cancelled.');
      }
      if (signal.aborted) {
        const handoff = handoffReason(signal);
        if (handoff) throw handoff;
        return this.settleCancelledCapability(input, 'File proposal planning was cancelled.');
      }
      proposal = await this.dependencies.files.propose({
        source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:file-proposal` },
        toolCallId: input.toolCallId,
        members
      });
    } else {
      proposal = { changeSetId: requireId(existing[0].id, 'FileChangeSet.id') };
    }
    const durableDecisions = await this.list('FileChangeDecision', { change_set_id: proposal.changeSetId }, 2);
    if (durableDecisions.length > 1) {
      throw new Error(`FileChangeSet ${proposal.changeSetId} has multiple durable decisions.`);
    }
    if (durableDecisions.length === 1) {
      const decision = requireText(durableDecisions[0].decision, 'FileChangeDecision.decision');
      if (decision === 'approved') {
        const operations = await listAllDomainRows(this.dependencies.database, 'Operation', {
          owner_kind: 'file_change_set',
          owner_id: proposal.changeSetId,
          tool_call_id: input.toolCallId
        });
        if (operations.length !== 1) {
          throw new Error(`Approved FileChangeSet ${proposal.changeSetId} must own exactly one Operation.`);
        }
        const attempts = await listAllDomainRows(this.dependencies.database, 'Attempt', {
          operation_id: operations[0].id
        });
        if (attempts.length !== 1) {
          throw new Error(`Approved FileChangeSet ${proposal.changeSetId} must own exactly one Attempt.`);
        }
        const intents = await this.list('EffectIntent', { attempt_id: attempts[0].id }, 2);
        if (intents.length !== 1) {
          throw new Error(`Approved FileChangeSet ${proposal.changeSetId} must own exactly one EffectIntent.`);
        }
        const applied = await this.dependencies.fileMutations.dispatchRecordAndReconcile(
          requireId(intents[0].id, 'EffectIntent.id'),
          signal
        );
        const terminal = applied.terminal
          ?? await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
        if (terminal) return terminal;
        return {
          disposition: 'paused',
          toolCallId: input.toolCallId,
          reason: 'background_process',
          resumeKey: requireId(intents[0].id, 'EffectIntent.id')
        };
      }
      await this.dependencies.effects.finalizeReadyInOrder(input.turnId);
      const terminal = await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
      if (terminal) {
        this.emitToolSettlement(input.turnId, terminal.toolCallId);
        return terminal;
      }
      return {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'background_process',
        resumeKey: proposal.changeSetId
      };
    }
    if (
      frozenDecision.executionGate === 'approval_required'
      || frozenDecision.changeApplyMode !== 'automatic'
    ) {
      return {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'awaiting_approval',
        resumeKey: proposal.changeSetId
      };
    }
    if (frozenDecision.changeApplyDelaySeconds > 0) {
      const delayed = await this.waitForAutomaticFileDecision(
        input,
        proposal.changeSetId,
        frozenDecision.changeApplyDelaySeconds,
        signal
      );
      if (delayed) return delayed;
    }
    const decision = await this.dependencies.files.decide({
      source: { kind: 'command', key: `tool-policy:auto-apply:${proposal.changeSetId}` },
      changeSetId: proposal.changeSetId,
      decision: 'approved',
      response: { actor: 'frozen-tool-policy', automatic: true }
    });
    if (decision.terminal) {
      this.emitToolSettlement(input.turnId, decision.terminal.toolCallId);
      return decision.terminal;
    }
    if (!decision.preparedEffect) {
      const terminal = await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
      if (terminal) {
        this.emitToolSettlement(input.turnId, terminal.toolCallId);
        return terminal;
      }
      const settled = await this.readReadySettlement(input.toolCallId);
      if (settled) return settled;
      return {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'awaiting_approval',
        resumeKey: proposal.changeSetId
      };
    }
    const applied = await this.dependencies.fileMutations.dispatchRecordAndReconcile(
      decision.preparedEffect.effectIntentId,
      signal
    );
    const handoff = handoffReason(signal);
    if (handoff) throw handoff;
    if (applied.terminal) return applied.terminal;
    const settled = await this.readReadySettlement(input.toolCallId);
    if (settled) return settled;
    return {
      disposition: 'paused',
      toolCallId: input.toolCallId,
      reason: 'background_process',
      resumeKey: decision.preparedEffect.effectIntentId
    };
  }

  private async waitForAutomaticFileDecision(
    input: ReliableAgentToolDispatchInput,
    changeSetId: string,
    delaySeconds: number,
    signal: AbortSignal
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | undefined> {
    const changeSets = await this.list('FileChangeSet', { id: changeSetId }, 2);
    if (changeSets.length !== 1) throw new Error(`FileChangeSet ${changeSetId} does not exist.`);
    const createdAt = Date.parse(requireText(changeSets[0].created_at, 'FileChangeSet.created_at'));
    if (!Number.isFinite(createdAt)) throw new TypeError('FileChangeSet.created_at must be an ISO timestamp.');
    const deadline = createdAt + delaySeconds * 1_000;
    for (;;) {
      if (signal.aborted) {
        const handoff = handoffReason(signal);
        if (handoff) throw handoff;
        return {
          disposition: 'paused',
          toolCallId: input.toolCallId,
          reason: 'awaiting_approval',
          resumeKey: changeSetId
        };
      }
      const terminal = await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
      if (terminal) {
        this.emitToolSettlement(input.turnId, terminal.toolCallId);
        return terminal;
      }
      const decisions = await this.list('FileChangeDecision', { change_set_id: changeSetId }, 2);
      if (decisions.length > 0 || Date.now() >= deadline) return undefined;
      if (await this.turnTerminationRequested(input.turnId)) {
        return {
          disposition: 'paused',
          toolCallId: input.toolCallId,
          reason: 'awaiting_approval',
          resumeKey: changeSetId
        };
      }
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  private async dispatchProcess(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    signal: AbortSignal
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    if (signal.aborted) {
      const handoff = handoffReason(signal);
      if (handoff) throw handoff;
      return this.settleCancelledCapability(input, 'Process capability execution was cancelled before dispatch.');
    }
    const args = requireRecord(input.arguments, `${input.toolName} arguments`);
    const mode = args.mode === 'output' || args.mode === 'kill' ? args.mode : 'execute';
    if (mode === 'output') return this.readProcessOutput(input, args, signal);
    if (mode === 'kill') return this.stopProcess(input, args, signal);
    if (typeof args.explanation !== 'string' || args.explanation.trim().length === 0) {
      return this.reject(input, `${input.toolName} mode=execute 需要 explanation。`);
    }
    const command = requireText(args.command, `${input.toolName}.command`);
    const commandConfig = commandPolicyConfig(authority.toolConfig);
    const deniedBy = firstMatchedCommandRule(command, commandConfig.denyCommands);
    if (deniedBy) return this.reject(input, `命令被冻结 ToolPolicy 黑名单拒绝：${deniedBy}`);
    if (commandConfig.allowCommands.length > 0 && !firstMatchedCommandRule(command, commandConfig.allowCommands)) {
      return this.reject(input, '命令未匹配冻结 ToolPolicy 白名单；可靠执行批准门禁未启用，因此不会执行。');
    }
    // A child Turn's command must also pass the rules of every ancestor Turn.
    for (const inherited of authority.inheritedToolConfigs ?? []) {
      const rules = commandPolicyConfig(inherited.toolConfig);
      const deniedByParent = firstMatchedCommandRule(command, rules.denyCommands);
      if (deniedByParent) return this.reject(input, `命令被上级对话冻结的 ToolPolicy 黑名单拒绝：${deniedByParent}`);
      if (rules.allowCommands.length > 0 && !firstMatchedCommandRule(command, rules.allowCommands)) {
        return this.reject(input, '命令未匹配上级对话冻结的 ToolPolicy 白名单；子 Agent 的命令不能超出上级对话允许的范围，因此不会执行。');
      }
    }
    const foregroundWaitMs = requireWaitMs(args.foregroundWaitMs);
    const executionTimeoutMs = requireOptionalBoundedInteger(
      args.executionTimeoutMs,
      DEFAULT_PROCESS_EXECUTION_TIMEOUT_MS,
      'executionTimeoutMs',
      MIN_PROCESS_EXECUTION_TIMEOUT_MS,
      MAX_PROCESS_EXECUTION_TIMEOUT_MS
    );
    const maxOutputBytes = requireOptionalBoundedInteger(
      args.maxOutputBytes,
      DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
      MIN_PROCESS_MAX_OUTPUT_BYTES,
      MAX_PROCESS_MAX_OUTPUT_BYTES
    );
    if (!this.dependencies.host.resolveProcessCwd) {
      return this.reject(input, `${input.toolName} 没有工作目录 resolver。`);
    }
    const cwd = await this.dependencies.host.resolveProcessCwd(input, authority);
    if (signal.aborted) {
      const handoff = handoffReason(signal);
      if (handoff) throw handoff;
      return this.settleCancelledCapability(input, 'Process capability execution was cancelled before dispatch.');
    }
    const prepared = await this.dependencies.processes.prepareStart({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:process-start` },
      toolCallId: input.toolCallId,
      command,
      cwd,
      executionTimeoutMs,
      maxOutputBytes
    });
    const started = await this.dependencies.processes.dispatchStart(
      prepared.effect.effectIntentId,
      effectiveProcessForegroundWaitMs(command, foregroundWaitMs, executionTimeoutMs),
      signal
    );
    const handoff = handoffReason(signal);
    if (handoff) throw handoff;
    const terminal = started.terminal ?? await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    if (terminal) return terminal;
    const settled = await this.readReadySettlement(input.toolCallId);
    if (settled) return settled;
    return {
      disposition: 'paused',
      toolCallId: input.toolCallId,
      reason: 'background_process',
      resumeKey: prepared.request.processId
    };
  }

  private async readProcessOutput(
    input: ReliableAgentToolDispatchInput,
    args: { [key: string]: PlainJsonValue },
    signal: AbortSignal
  ): Promise<ToolTerminalResult | ReliableAgentToolSettled> {
    const processId = requireId(args.processId, 'processId');
    const observed = await this.dependencies.processes.wait(processId, 0);
    if (observed.state !== 'running') await this.dependencies.processes.reconcileProcessExit(processId);
    await this.dependencies.processes.reconcileOutputForRead(processId, args.outputHandle);
    const output = await this.dependencies.processes.readOutputPage(processId, args.outputHandle);
    const detail = {
      processId,
      status: processStatus(observed),
      exitCode: processExitCode(observed),
      killed: observed.state === 'exited' ? observed.receipt.stopRequested : false,
      ...(observed.state === 'exited' ? { terminationReason: observed.receipt.terminationReason } : {}),
      stdout: output.stdout,
      stderr: output.stderr,
      liveStdout: output.liveStdout,
      liveStderr: output.liveStderr,
      livePreviewBytes: output.livePreviewBytes,
      pageBytes: output.pageBytes,
      pageChunks: output.pageChunks,
      retainedBytes: output.retainedBytes,
      retainedChunks: output.retainedChunks,
      hasMore: output.hasMore,
      complete: output.complete,
      nextOutputHandle: output.nextOutputHandle,
      truncated: output.truncated,
      droppedBytes: output.droppedBytes
    };
    if (signal.aborted) {
      const handoff = handoffReason(signal);
      if (handoff) throw handoff;
      return this.settleCancelledCapability(input, 'Process output observation was cancelled.');
    }
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:process-output` },
      toolCallId: input.toolCallId,
      status: 'succeeded',
      detail
    });
    return this.settledResult(input.toolCallId, settled.status, settled.terminal);
  }

  private async stopProcess(
    input: ReliableAgentToolDispatchInput,
    args: { [key: string]: PlainJsonValue },
    signal: AbortSignal
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    const processId = requireId(args.processId, 'processId');
    const prepared = await this.dependencies.processes.prepareStop({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:process-stop` },
      toolCallId: input.toolCallId,
      processId
    });
    const stopped = await this.dependencies.processes.dispatchStop(prepared.effectIntentId, signal);
    const handoff = handoffReason(signal);
    if (handoff) throw handoff;
    const terminal = stopped?.terminal ?? await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    if (terminal) return terminal;
    const settled = await this.readReadySettlement(input.toolCallId);
    if (settled) return settled;
    return {
      disposition: 'paused',
      toolCallId: input.toolCallId,
      reason: 'background_process',
      resumeKey: processId
    };
  }

  private async dispatchMcp(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    signal: AbortSignal
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    const source = definition.declaration.source;
    if (source?.kind !== 'mcp') return this.reject(input, 'MCP 工具缺少冻结 source metadata。');
    const prepared = await this.dependencies.mcp.prepare({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:mcp-prepare` },
      toolCallId: input.toolCallId,
      serverId: requireId(source.sourceId, 'MCP source.sourceId'),
      toolName: requireText(source.originalToolName, 'MCP source.originalToolName'),
      arguments: plainRecord(input.arguments, 'MCP arguments')
    });
    if (prepared.disposition === 'rejected') {
      return this.settledResult(input.toolCallId, prepared.settlement.status, prepared.settlement.terminal);
    }
    const dispatched = await this.dependencies.mcp.dispatch(prepared.effectIntentId, signal);
    const handoff = handoffReason(signal);
    if (handoff) throw handoff;
    const terminal = dispatched.terminal ?? await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    if (terminal) return terminal;
    const settled = await this.readReadySettlement(input.toolCallId);
    if (settled) return settled;
    return {
      disposition: 'paused',
      toolCallId: input.toolCallId,
      reason: 'background_process',
      resumeKey: prepared.effectIntentId
    };
  }

  private async dispatchWorkEnvironmentTransfer(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    emit: (event: ToolRuntimeEvent) => void,
    signal: AbortSignal
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    if (!this.dependencies.host.executeWorkEnvironmentTransfer) {
      return this.reject(input, 'transfer 没有可靠 file_transfer capability adapter。');
    }
    const prepared = await this.workEnvironmentTransfers.prepare({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:file-transfer-prepare` },
      toolCallId: input.toolCallId,
      authoritySnapshotId: authority.snapshotId,
      arguments: input.arguments
    });
    const dispatched = await this.workEnvironmentTransfers.dispatch(prepared.effectIntentId, {
      execute: (request) => {
        if (request.authoritySnapshotId !== authority.snapshotId) {
          throw new Error('file_transfer Effect authority snapshot does not match the dispatching Turn.');
        }
        return this.dependencies.host.executeWorkEnvironmentTransfer!(
          definition,
          { ...input, arguments: request.arguments },
          authority,
          emit,
          signal
        );
      }
    }, signal);
    const handoff = handoffReason(signal);
    if (handoff) throw handoff;
    const terminal = dispatched.terminal
      ?? await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    if (terminal) return terminal;
    const settled = await this.readReadySettlement(input.toolCallId);
    if (settled) return settled;
    return {
      disposition: 'paused',
      toolCallId: input.toolCallId,
      reason: 'background_process',
      resumeKey: prepared.effectIntentId
    };
  }

  /**
   * A Turn's WorkEnvironmentPolicy is immutable. Switching to the already-active environment is a
   * real no-op; changing it mid-Turn is rejected instead of pretending later relative paths moved.
   */
  private async dispatchWorkEnvironmentSwitch(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<ToolTerminalResult | ReliableAgentToolSettled> {
    const policy = authorityWorkEnvironmentPolicy(authority.document);
    const args = requireRecord(input.arguments, 'switch_work_environment arguments');
    const requested = requireId(args.workEnvironmentId, 'switch_work_environment.workEnvironmentId');
    if (!policy.allowedWorkEnvironmentIds.includes(requested)) {
      return this.reject(input, `目标工作环境 ${requested} 不在当前 Turn 冻结的允许集合中。`);
    }
    if (requested !== policy.defaultWorkEnvironmentId) {
      return this.reject(
        input,
        `当前 Turn 的工作环境已冻结为 ${policy.defaultWorkEnvironmentId ?? '未设置'}；不能在同一 Turn 内切换到 ${requested}。请在下一 Turn 前更新对话工作环境。`
      );
    }
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:work-environment-noop` },
      toolCallId: input.toolCallId,
      status: 'succeeded',
      detail: {
        ok: true,
        unchanged: true,
        workEnvironmentId: requested,
        reason: '请求的工作环境已经是当前 Turn 冻结的默认环境。'
      }
    });
    return this.settledResult(input.toolCallId, settled.status, settled.terminal);
  }

  private async definitionsForTurn(
    definitions: ToolDefinition[],
    turnId: string
  ): Promise<ToolDefinition[]> {
    const authority = await this.readAuthority(turnId);
    const toolPolicy = authorityPolicy(authority.document);
    const workEnvironmentPolicy = authorityWorkEnvironmentPolicy(authority.document);
    const runAgentDefinition = definitions.find((definition) =>
      definition.declaration.name === RUN_AGENT_TOOL_NAME
      && definitionAllowedByAuthority(toolPolicy, definition)
    );
    const allowChildSpawn = !runAgentDefinition || runAgentToolAvailableAtDepth(
      await childAgentDepthForTurn(this.dependencies.database, turnId),
      toolPolicy.toolConfigs[RUN_AGENT_TOOL_NAME]?.config
    );
    // The frozen switch grants the cross-conversation tools (see toolAllowedByPolicy); they stay
    // with top-level conversations, since a child task collaborates inside its own team.
    const topLevel = definitions.some((definition) => isCrossConversationTool(definition.declaration.name))
      && crossConversationSwitchOn(toolPolicy.toolConfigs)
      && await this.topLevelTurn(turnId);
    const allowed = definitions.filter((definition) =>
      definitionAllowedByAuthority(toolPolicy, definition)
      && (workEnvironmentPolicy.enabled || !WORK_ENVIRONMENT_TOOLS.has(definition.declaration.name))
      && (!isCrossConversationTool(definition.declaration.name) || topLevel)
    ).map(definition => {
      if (definition.declaration.name !== RUN_AGENT_TOOL_NAME || allowChildSpawn) return definition;
      const parameters = plainOptionalRecord(normalizePlainJson(definition.declaration.parameters ?? {})) ?? {};
      const properties = plainOptionalRecord(parameters.properties) ?? {};
      const operation = plainOptionalRecord(properties.operation) ?? {};
      return { ...definition, declaration: { ...definition.declaration,
        description: `${definition.declaration.description}\nNew child spawning is unavailable at the current depth. Use list/read/wait/send/interrupt_subtree for existing children.`,
        parameters: { ...parameters, properties: { ...properties,
          operation: { ...operation, enum: RUN_AGENT_OPERATIONS.filter(value => value !== 'spawn') }
        } }
      } } as ToolDefinition;
    });
    const withSkills = this.augmentSkillsDefinition(allowed, authority.document);
    const withEnvironments = await this.augmentWorkEnvironmentDefinitions(withSkills, authority, workEnvironmentPolicy.enabled);
    return this.augmentRunAgentDefinition(withEnvironments);
  }

  /**
   * Whether the Turn runs in a top-level conversation. Phase one offers the cross-conversation
   * tools only there: a child task keeps collaborating inside its own team.
   */
  private async topLevelTurn(turnId: string): Promise<boolean> {
    const turns = await this.list('Turn', { id: turnId }, 1);
    if (turns.length !== 1) throw new Error(`Turn ${turnId} does not exist.`);
    const conversationId = requireId(turns[0].conversation_id, 'Turn.conversation_id');
    return (await this.list('ChildExecution', { child_conversation_id: conversationId }, 1)).length === 0;
  }

  /**
   * 把可指派的 agent.type 列表拼进 runAgent 工具描述与 agent.type 参数提示。
   * 列表读取失败时保持原声明（降级为静态描述），不拖垮整个 Turn 的 schema 构建。
   */
  private async augmentRunAgentDefinition(definitions: ToolDefinition[]): Promise<ToolDefinition[]> {
    const host = this.dependencies.host;
    if (!host.agentTypeEntries) return definitions;
    const index = definitions.findIndex((definition) => definition.declaration.name === RUN_AGENT_TOOL_NAME);
    if (index === -1) return definitions;
    let typeList: string;
    try {
      typeList = formatAgentTypeList(await host.agentTypeEntries());
    } catch {
      return definitions;
    }
    if (!typeList) return definitions;
    const target = definitions[index];
    const baseDescription = typeof target.declaration.description === 'string' ? target.declaration.description : '';
    const augmented = augmentRunAgentToolSchema(
      { description: baseDescription, parameters: target.declaration.parameters },
      typeList
    );
    const next = [...definitions];
    next[index] = {
      ...target,
      declaration: {
        ...target.declaration,
        description: augmented.description,
        parameters: augmented.parameters as typeof target.declaration.parameters
      }
    };
    return next;
  }

  /**
   * 把冻结策略允许的工作环境列表拼进 switch_work_environment / transfer 工具描述与参数提示。
   * 环境解析失败时保持原声明（降级为静态描述），不拖垮整个 Turn 的 schema 构建。
   */
  private async augmentWorkEnvironmentDefinitions(
    definitions: ToolDefinition[],
    authority: ReliableToolDispatchAuthority,
    switchingEnabled: boolean
  ): Promise<ToolDefinition[]> {
    if (!switchingEnabled) return definitions;
    const host = this.dependencies.host;
    if (!host.workEnvironmentsForAuthority) return definitions;
    const hasEnvironmentTool = definitions.some((definition) => WORK_ENVIRONMENT_TOOLS.has(definition.declaration.name));
    if (!hasEnvironmentTool) return definitions;
    let environments: WorkEnvironmentRecord[];
    try {
      environments = (await host.workEnvironmentsForAuthority(authority)).allowed;
    } catch {
      return definitions;
    }
    return definitions.map((definition) => {
      if (definition.declaration.name === SWITCH_WORK_ENVIRONMENT_TOOL_NAME) {
        const environmentText = workEnvironmentListText(environments, SWITCH_WORK_ENVIRONMENTS_TITLE);
        const baseDescription = typeof definition.declaration.description === 'string' ? definition.declaration.description : '';
        return {
          ...definition,
          declaration: {
            ...definition.declaration,
            description: [baseDescription, environmentText].filter(Boolean).join('\n\n'),
            parameters: withWorkEnvironmentIdParameterHints(definition.declaration.parameters, environmentText) as typeof definition.declaration.parameters
          }
        };
      }
      if (definition.declaration.name === TRANSFER_TOOL_NAME) {
        const environmentText = workEnvironmentListText(environments, TRANSFER_WORK_ENVIRONMENTS_TITLE);
        const baseDescription = typeof definition.declaration.description === 'string' ? definition.declaration.description : '';
        return {
          ...definition,
          declaration: {
            ...definition.declaration,
            description: [baseDescription, environmentText].filter(Boolean).join('\n\n'),
            parameters: withTransferEnvironmentParameterHints(definition.declaration.parameters, environmentText) as typeof definition.declaration.parameters
          }
        };
      }
      return definition;
    });
  }

  /**
   * 把按冻结 skillPolicy 过滤后的技能目录拼进 skills 工具描述。
   * 声明本身是不可变模板，这里返回克隆体，绝不改写 host 持有的 definition。
   */
  private augmentSkillsDefinition(definitions: ToolDefinition[], document: PlainJsonValue): ToolDefinition[] {
    const host = this.dependencies.host;
    if (!host.skillDefinitions) return definitions;
    const index = definitions.findIndex((definition) => definition.declaration.name === SKILLS_TOOL_NAME);
    if (index === -1) return definitions;
    let enabled: SkillDefinitionRecord[];
    try {
      const policy = frozenSkillPolicy(document);
      enabled = host.skillDefinitions().filter((skill) => isSkillEnabledByPolicy(policy, skill));
    } catch {
      // 与其他动态注入点一致：目录/冻结策略异常时降级为静态描述，不拖垮整个 Turn。
      return definitions;
    }
    const target = definitions[index];
    const baseDescription = typeof target.declaration.description === 'string' ? target.declaration.description : '';
    const next = [...definitions];
    next[index] = {
      ...target,
      declaration: {
        ...target.declaration,
        description: composeSkillsToolDescription(baseDescription, enabled)
      }
    };
    return next;
  }

  /** The Turn's frozen authority, with one tool's per-tool settings when a tool is named. */
  private async readAuthority(turnId: string, tool?: ToolPolicyTool): Promise<ReliableToolDispatchAuthority> {
    let cached = this.authorityCache.get(turnId);
    if (!cached) {
      cached = (async () => {
        const rows = await this.list('AuthoritySnapshot', { turn_id: turnId }, 2);
        if (rows.length !== 1) throw new Error(`Turn ${turnId} must have exactly one AuthoritySnapshot.`);
        const snapshotId = requireId(rows[0].id, 'AuthoritySnapshot.id');
        const frozen = await readFrozenTurnAuthority(
          this.dependencies.database,
          this.dependencies.contentStore,
          snapshotId,
          turnId
        );
        return { snapshotId, document: frozen.document };
      })();
      this.authorityCache.set(turnId, cached);
      if (this.authorityCache.size > 64) {
        const oldest = this.authorityCache.keys().next().value as string | undefined;
        if (oldest && oldest !== turnId) this.authorityCache.delete(oldest);
      }
    }
    let base: { snapshotId: string; document: PlainJsonValue };
    try {
      base = await cached;
    } catch (error) {
      if (this.authorityCache.get(turnId) === cached) this.authorityCache.delete(turnId);
      throw error;
    }
    return callAuthority(base, authorityPolicy(base.document), tool);
  }

  private async reject(
    input: ReliableAgentToolDispatchInput,
    reason: string
  ): Promise<ToolTerminalResult | ReliableAgentToolSettled> {
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:rejected` },
      toolCallId: input.toolCallId,
      status: 'rejected',
      detail: { reason }
    });
    return this.settledResult(input.toolCallId, settled.status, settled.terminal);
  }

  private async readFrozenDecision(
    input: ReliableAgentToolDispatchInput,
    definition: ToolDefinition,
    authority: ReliableToolDispatchAuthority
  ): Promise<FrozenToolCallPolicyDecision> {
    const links = await this.list('ToolCallSourceLink', { tool_call_id: input.toolCallId }, 2);
    const snapshots = await this.list('ToolCallPolicySnapshot', { tool_call_id: input.toolCallId }, 2);
    if (links.length > 1 || snapshots.length > 1) throw new Error(`ToolCall ${input.toolCallId} has duplicate frozen facts.`);
    if (links.length === 1) {
      if (snapshots.length !== 1) throw new Error(`Provider ToolCall ${input.toolCallId} has no frozen policy snapshot.`);
      return frozenPolicyFromRow(snapshots[0]);
    }
    if (snapshots.length !== 0) throw new Error(`Internal ToolCall ${input.toolCallId} has an orphan policy snapshot.`);
    const frozenDefinition: ReliableAgentToolDefinition = {
      name: definition.declaration.name,
      description: definition.declaration.description,
      parameters: normalizePlainJson(definition.declaration.parameters ?? {}, 'Tool parameters'),
      ...(definition.declaration.source ? {
        source: normalizePlainJson(definition.declaration.source, 'Tool source')
      } : {}),
      ...(definition.declaration.metadata ? {
        metadata: normalizePlainJson(definition.declaration.metadata, 'Tool metadata')
      } : {}),
      ...(definition.declaration.defaultConfig ? {
        defaultConfig: normalizePlainJson(definition.declaration.defaultConfig, 'Tool default config')
      } : {})
    };
    return this.freezeDecision({ ...input, definition: frozenDefinition }, definition, authority);
  }

  private async providerDefinitionMismatch(
    input: ReliableAgentToolDispatchInput,
    definition: ToolDefinition
  ): Promise<string | undefined> {
    const links = await this.list('ToolCallSourceLink', { tool_call_id: input.toolCallId }, 2);
    if (links.length === 0) return undefined;
    if (links.length !== 1 || links[0].model_request_id !== input.modelRequestId) {
      return `Provider ToolCall ${input.toolCallId} 的来源关系与当前 ModelRequest 不一致。`;
    }
    const request = await this.list('ModelRequest', { id: input.modelRequestId }, 2);
    if (request.length !== 1) return `Provider ToolCall ${input.toolCallId} 的 ModelRequest 不存在。`;
    const contentRows = await this.list('ContentObject', {
      id: requireId(request[0].recipe_object_id, 'ModelRequest.recipe_object_id')
    }, 2);
    if (contentRows.length !== 1) return `Provider ToolCall ${input.toolCallId} 的冻结 recipe 不存在。`;
    const recipe = requireRecord(
      normalizePlainJson(
        JSON.parse((await this.dependencies.contentStore.read(
          contentRows[0] as unknown as ContentObjectMetadata
        )).toString('utf8')),
        'ModelRequest recipe'
      ),
      'ModelRequest recipe'
    );
    return providerDefinitionMismatchFromRecipe(input.toolName, definition, recipe);
  }

  /** Resolves each ModelRequest recipe once for the whole Provider group. */
  private async providerDefinitionMismatchesForBatch(
    inputs: readonly ReliableAgentToolDispatchInput[],
    definitionsByName: ReadonlyMap<string, ToolDefinition>
  ): Promise<Map<string, string>> {
    const mismatches = new Map<string, string>();
    if (inputs.length === 0) return mismatches;
    const modelRequestIds = [...new Set(inputs.map((input) => input.modelRequestId))];
    const requestSnapshot = await this.dependencies.database.snapshot(modelRequestIds.map((id) =>
      DOMAIN_REPOSITORIES.domain('ModelRequest').get(id)
    ));
    const requestsById = new Map<string, DomainRow>();
    const recipeObjectIds: string[] = [];
    for (let index = 0; index < modelRequestIds.length; index += 1) {
      const row = requestSnapshot.snapshot[index];
      if (!row || Array.isArray(row)) {
        for (const input of inputs) {
          if (input.modelRequestId === modelRequestIds[index]) {
            mismatches.set(input.toolCallId, `Provider ToolCall ${input.toolCallId} 的 ModelRequest 不存在。`);
          }
        }
        continue;
      }
      requestsById.set(modelRequestIds[index], row);
      recipeObjectIds.push(requireId(row.recipe_object_id, 'ModelRequest.recipe_object_id'));
    }
    const uniqueRecipeObjectIds = [...new Set(recipeObjectIds)];
    const contentSnapshot = await this.dependencies.database.snapshot(uniqueRecipeObjectIds.map((id) =>
      DOMAIN_REPOSITORIES.domain('ContentObject').get(id)
    ));
    const metadata: ContentObjectMetadata[] = [];
    const metadataIds: string[] = [];
    for (let index = 0; index < uniqueRecipeObjectIds.length; index += 1) {
      const row = contentSnapshot.snapshot[index];
      if (!row || Array.isArray(row)) continue;
      metadata.push(row as unknown as ContentObjectMetadata);
      metadataIds.push(uniqueRecipeObjectIds[index]);
    }
    const recipeByObjectId = new Map<string, PlainJsonValue>();
    const bytes = await this.dependencies.contentStore.readMany(metadata);
    for (let index = 0; index < metadata.length; index += 1) {
      recipeByObjectId.set(metadataIds[index], normalizePlainJson(
        JSON.parse(bytes[index].toString('utf8')),
        'ModelRequest recipe'
      ));
    }
    for (const input of inputs) {
      if (mismatches.has(input.toolCallId)) continue;
      const request = requestsById.get(input.modelRequestId);
      if (!request) continue;
      const recipeObjectId = requireId(request.recipe_object_id, 'ModelRequest.recipe_object_id');
      const recipeValue = recipeByObjectId.get(recipeObjectId);
      if (!recipeValue) {
        mismatches.set(input.toolCallId, `Provider ToolCall ${input.toolCallId} 的冻结 recipe 不存在。`);
        continue;
      }
      const definition = definitionsByName.get(input.toolName);
      if (!definition) continue;
      const recipe = requireRecord(recipeValue, 'ModelRequest recipe');
      const mismatch = providerDefinitionMismatchFromRecipe(input.toolName, definition, recipe);
      if (mismatch) mismatches.set(input.toolCallId, mismatch);
    }
    return mismatches;
  }

  private settledResult(
    toolCallId: string,
    status: ToolOutcomeStatus,
    terminal?: ToolTerminalResult
  ): ToolTerminalResult | ReliableAgentToolSettled {
    return terminal ?? { disposition: 'settled', toolCallId, status };
  }

  private async settleDispatchFailure(
    input: ReliableAgentToolDispatchInput,
    sourceKey: string,
    error: unknown,
    finalize = true
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    if (finalize) await this.dependencies.effects.finalizeReadyInOrder(input.turnId);
    const terminal = await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    if (terminal) {
      this.emitToolSettlement(input.turnId, terminal.toolCallId);
      return terminal;
    }
    const operations = await listAllDomainRows(this.dependencies.database, 'Operation', {
      tool_call_id: input.toolCallId
    });
    if (operations.length > 0) {
      // An effectful frontier already exists. Never overwrite it with a synthetic no-effect
      // failure; the local converger or capability-specific re-entry owns the next transition.
      return {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'background_process',
        resumeKey: input.toolCallId
      };
    }
    const failed = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: sourceKey },
      toolCallId: input.toolCallId,
      status: 'failed',
      detail: { error: errorMessage(error) }
    }, { finalize });
    return failed.terminal ?? {
      disposition: 'settled',
      toolCallId: input.toolCallId,
      status: failed.status
    };
  }

  private async settleCancelledCapability(
    input: ReliableAgentToolDispatchInput,
    reason: string
  ): Promise<ToolTerminalResult | ReliableAgentToolSettled> {
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:capability-cancelled` },
      toolCallId: input.toolCallId,
      status: 'cancelled',
      detail: { reason }
    });
    return this.settledResult(input.toolCallId, settled.status, settled.terminal);
  }

  private async readReadySettlement(
    toolCallId: string,
    finalize = true
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled | undefined> {
    const calls = await this.list('ToolCall', { id: toolCallId }, 2);
    if (calls.length !== 1) throw new Error(`ToolCall ${toolCallId} does not exist.`);
    const turnId = requireId(calls[0].turn_id, 'ToolCall.turn_id');
    if (finalize) await this.dependencies.effects.finalizeReadyInOrder(turnId);
    const terminal = await this.dependencies.effects.readTerminalResult(toolCallId, false);
    if (terminal) {
      this.emitToolSettlement(turnId, terminal.toolCallId);
      return terminal;
    }
    const operations = await listAllDomainRows(this.dependencies.database, 'Operation', { tool_call_id: toolCallId });
    if (operations.length > 0 && operations.every((operation) => isTerminalOperationStatus(operation.status))) {
      return {
        disposition: 'paused',
        toolCallId,
        reason: 'converging',
        resumeKey: toolCallId
      };
    }
    const changeSets = await this.list('FileChangeSet', { tool_call_id: toolCallId }, 2);
    if (changeSets.length === 1) {
      const decisions = await this.list('FileChangeDecision', { change_set_id: changeSets[0].id }, 2);
      if (
        decisions.length === 1
        && ['rejected', 'cancelled', 'expired'].includes(String(decisions[0].decision))
      ) {
        return {
          disposition: 'settled',
          toolCallId,
          status: decisions[0].decision === 'rejected' ? 'rejected' : 'cancelled'
        };
      }
    }
    return undefined;
  }

  private async captureHostEvents<T>(
    input: ReliableAgentToolDispatchInput,
    execute: (emit: (event: ToolRuntimeEvent) => void, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.activeHostExecutions.has(input.toolCallId)) {
      throw new Error(`ToolCall ${input.toolCallId} already has an active host execution.`);
    }
    const active = this.beginActiveExecution(input);
    const controller = active.controller;
    let eventOrdinal = 0;
    let tail = Promise.resolve();
    const emit = (event: ToolRuntimeEvent): void => {
      const ordinal = eventOrdinal++;
      const normalized = normalizeRuntimeToolEvent(event);
      tail = tail.then(async () => {
        await this.dependencies.effects.appendToolCallEvent({
          source: { kind: 'callback', key: `tool-runtime-event:${input.toolCallId}:${ordinal}` },
          toolCallId: input.toolCallId,
          eventKind: normalized.kind,
          content: normalized
        });
      });
    };
    let result: T;
    try {
      await this.abortRegisteredExecutionIfTurnTerminated(active, input.turnId);
      result = await execute(emit, controller.signal);
    } catch (error) {
      try {
        await tail;
      } catch (eventError) {
        const handoff = handoffReason(controller.signal)
          ?? (isExecutionHandoffError(error) ? error : undefined)
          ?? (isExecutionHandoffError(eventError) ? eventError : undefined);
        if (handoff) throw handoff;
        const combined = new Error(`Tool execution and durable event append both failed: ${errorMessage(error)}; ${errorMessage(eventError)}`);
        (combined as Error & { cause?: unknown }).cause = error;
        throw combined;
      }
      if (controller.signal.aborted) {
        const handoff = handoffReason(controller.signal);
        if (handoff) throw handoff;
        throw controller.signal.reason ?? error;
      }
      throw error;
    } finally {
      this.activeHostExecutions.delete(input.toolCallId);
      active.finish();
    }
    await tail;
    return result;
  }

  private async captureAbortableExecution<T>(
    input: ReliableAgentToolDispatchInput,
    execute: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.activeHostExecutions.has(input.toolCallId)) {
      throw new Error(`ToolCall ${input.toolCallId} already has an active host execution.`);
    }
    const active = this.beginActiveExecution(input);
    const controller = active.controller;
    try {
      await this.abortRegisteredExecutionIfTurnTerminated(active, input.turnId);
      return await execute(controller.signal);
    } finally {
      this.activeHostExecutions.delete(input.toolCallId);
      active.finish();
    }
  }

  private beginActiveExecution(input: ReliableAgentToolDispatchInput): {
    turnId: string;
    controller: AbortController;
    completion: Promise<void>;
    finish(): void;
  } {
    let finish!: () => void;
    const controller = new AbortController();
    const parentSignal = this.admissionSignals.get(input.toolCallId);
    const cancelFromAdmission = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(parentSignal?.reason ?? new Error('Tool batch admission was cancelled.'));
      }
    };
    if (parentSignal?.aborted) cancelFromAdmission();
    else parentSignal?.addEventListener('abort', cancelFromAdmission, { once: true });
    const active = {
      turnId: input.turnId,
      controller,
      completion: new Promise<void>((resolve) => { finish = resolve; }),
      finish: () => {
        parentSignal?.removeEventListener('abort', cancelFromAdmission);
        finish();
      }
    };
    if (this.handoff) active.controller.abort(this.handoff);
    this.activeHostExecutions.set(input.toolCallId, active);
    return active;
  }

  /**
   * Closes the durable-interrupt vs AbortController-registration race. The pre-dispatch read in
   * dispatchInternal handles requests committed first; this second read handles an interrupt whose
   * owning-host cancellation scan completed immediately before the local execution was registered.
   * If registration won instead, cancelActive already sees and aborts this same controller.
   */
  private async abortRegisteredExecutionIfTurnTerminated(
    active: { controller: AbortController },
    turnId: string
  ): Promise<void> {
    if (active.controller.signal.aborted || !await this.turnTerminationRequested(turnId)) return;
    const cancellation = new Error('Turn termination was committed before capability dispatch.');
    cancellation.name = 'TurnCancellationError';
    active.controller.abort(cancellation);
  }

  private async turnTerminationRequested(turnId: string): Promise<boolean> {
    const snapshot = await this.dependencies.database.snapshot(TERMINATION_INPUT_KINDS.map((inputKind) =>
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').list({
        where: { turn_id: turnId, state: 'pending', input_kind: inputKind },
        orderBy: { column: 'position', direction: 'asc' },
        limit: 1
      })
    ));
    return snapshot.snapshot.some((value) => Array.isArray(value) && value.length > 0);
  }

  /** Recovery/re-entry must observe an existing durable wait, never execute the Tool again. */
  private async readExistingPause(toolCallId: string): Promise<ReliableAgentToolPause | undefined> {
    const calls = await this.list('ToolCall', { id: toolCallId }, 2);
    if (calls.length !== 1) return undefined;
    if (calls[0].status !== 'waiting_answer') return undefined;
    const executions = await this.list('ToolExecution', { tool_call_id: toolCallId }, 2);
    if (executions.length !== 1 || executions[0].status !== 'waiting_answer') {
      throw new Error(`ToolCall ${toolCallId} has an incomplete durable wait.`);
    }
    const links = await this.list('InteractionToolCallLink', { tool_call_id: toolCallId }, 2);
    if (links.length > 1) throw new Error(`ToolCall ${toolCallId} has multiple Interaction links.`);
    if (links.length === 1) {
      const requestId = requireId(links[0].request_id, 'InteractionToolCallLink.request_id');
      const requests = await this.list('InteractionRequest', { id: requestId }, 2);
      if (requests.length !== 1 || requests[0].status !== 'pending') {
        throw new Error(`ToolCall ${toolCallId} wait does not have one pending InteractionRequest.`);
      }
      const kind = String(requests[0].request_kind);
      if (kind === 'ask_user') {
        return { disposition: 'paused', toolCallId, reason: 'awaiting_user', resumeKey: requestId };
      }
      if (kind === 'plan_review') {
        return { disposition: 'paused', toolCallId, reason: 'awaiting_plan_review', resumeKey: requestId };
      }
      return { disposition: 'paused', toolCallId, reason: 'awaiting_approval', resumeKey: requestId };
    }
    const operations = await this.list('Operation', { tool_call_id: toolCallId, status: 'waiting_answer' }, 2);
    if (operations.length !== 1) throw new Error(`ToolCall ${toolCallId} wait has no unique Operation.`);
    return {
      disposition: 'paused',
      toolCallId,
      reason: 'awaiting_child',
      resumeKey: requireId(operations[0].id, 'Operation.id')
    };
  }

  private async autoApproveInteraction(
    input: ReliableAgentToolDispatchInput,
    pause: ReliableAgentToolPause,
    authority?: ReliableToolDispatchAuthority
  ): Promise<InternalDispatchResult | undefined> {
    const toolName = input.toolName;
    if (toolName !== 'ask_user' && toolName !== 'submit_plan') return undefined;
    if (pause.reason !== (toolName === 'ask_user' ? 'awaiting_user' : 'awaiting_plan_review')) return undefined;
    const memberships = toolName === 'submit_plan'
      ? await this.list('ChildExecutionTurnLink', { turn_id: input.turnId }, 2)
      : [];
    if (memberships.length > 1) {
      throw new Error(`Child Turn ${input.turnId} has non-unique ChildExecution membership.`);
    }
    const childPlan = memberships.length === 1;
    if (!childPlan) {
      const frozen = authority ?? await this.readAuthority(input.turnId);
      if (!frozenInteractionAutoApproval(frozen.document, toolName)) return undefined;
    }
    if (await this.turnTerminationRequested(input.turnId)) return undefined;
    const requestId = requireId(pause.resumeKey, 'interaction resumeKey');
    const resolved = toolName === 'ask_user'
      ? await this.dependencies.interactions.resolveAskUser({
          source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:ask-user-auto-approve` },
          requestId,
          response: { answer: { selectedOptionIndexes: [], customText: BACKGROUND_ASK_USER_AUTO_ANSWER } }
        })
      : await this.dependencies.interactions.resolvePlanReview({
          source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:${childPlan ? 'child-plan' : 'plan'}-auto-approve` },
          requestId,
          decision: 'accept',
          response: {
            executionTarget: 'current_conversation',
            message: childPlan ? CHILD_PLAN_AUTO_APPROVAL_MESSAGE : PLAN_AUTO_APPROVAL_MESSAGE
          }
        });
    const terminal = resolved.terminal
      ?? await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    return terminal ?? {
      disposition: 'paused',
      toolCallId: input.toolCallId,
      reason: 'converging',
      resumeKey: pause.resumeKey
    };
  }

  private async executionApprovalState(
    toolCallId: string
  ): Promise<'missing' | 'pending' | 'approved' | 'rejected' | 'cancelled'> {
    const links = await this.list('InteractionToolCallLink', { tool_call_id: toolCallId }, 10);
    const requests = (await Promise.all(links.map(async (link) => {
      const rows = await this.list('InteractionRequest', { id: requireId(link.request_id, 'InteractionToolCallLink.request_id') }, 2);
      if (rows.length !== 1) throw new Error(`InteractionRequest ${String(link.request_id)} does not exist exactly once.`);
      return rows[0];
    }))).filter((request) => request.request_kind === 'exec_approval');
    if (requests.length === 0) return 'missing';
    if (requests.length !== 1) throw new Error(`ToolCall ${toolCallId} has multiple execution approvals.`);
    if (requests[0].status === 'pending') return 'pending';
    if (requests[0].status === 'succeeded') return 'approved';
    if (requests[0].status === 'cancelled') return 'cancelled';
    return 'rejected';
  }

  private async requirePendingExecutionApproval(toolCallId: string): Promise<{ requestId: string }> {
    const links = await this.list('InteractionToolCallLink', { tool_call_id: toolCallId }, 10);
    for (const link of links) {
      const requestId = requireId(link.request_id, 'InteractionToolCallLink.request_id');
      const requests = await this.list('InteractionRequest', { id: requestId }, 2);
      if (requests.length === 1 && requests[0].request_kind === 'exec_approval' && requests[0].status === 'pending') {
        return { requestId };
      }
    }
    throw new Error(`ToolCall ${toolCallId} execution approval state changed while resuming.`);
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.dependencies.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    if (!Array.isArray(snapshot.snapshot[0])) throw new TypeError(`${domain} list did not return rows.`);
    return snapshot.snapshot[0];
  }
}

function authorityPolicy(document: PlainJsonValue): {
  allowedTools: Set<string>;
  preset: string;
  toolConfigs: Record<string, ToolPolicyToolConfigRecord>;
  sourceConfigs: Record<string, unknown>;
  /** Ancestor Turns' presets and per-tool settings, nearest first; empty outside child Turns. */
  inherited: InheritedToolPolicyLayer[];
} {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  const policy = requireRecord(authority.toolPolicy, 'AuthoritySnapshot.toolPolicy');
  if (!Array.isArray(policy.allowedTools)) throw new TypeError('AuthoritySnapshot.toolPolicy.allowedTools must be an array.');
  const allowedTools = new Set(policy.allowedTools.map((value, index) => requireText(
    value,
    `AuthoritySnapshot.toolPolicy.allowedTools[${index}]`
  )));
  const toolConfigsRaw = policy.toolConfigs === undefined
    ? {}
    : plainRecord(policy.toolConfigs, 'AuthoritySnapshot.toolPolicy.toolConfigs');
  const sourceConfigs = policy.sourceConfigs === undefined
    ? {}
    : plainRecord(policy.sourceConfigs, 'AuthoritySnapshot.toolPolicy.sourceConfigs');
  return {
    allowedTools,
    preset: typeof policy.preset === 'string' ? policy.preset : 'custom',
    toolConfigs: toolConfigsRaw as unknown as Record<string, ToolPolicyToolConfigRecord>,
    sourceConfigs,
    inherited: inheritedToolPolicyChain(policy)
  };
}

function authorityWorkEnvironmentPolicy(document: PlainJsonValue): {
  enabled: boolean;
  allowedWorkEnvironmentIds: string[];
  defaultWorkEnvironmentId: string | null;
} {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  const raw = requireRecord(authority.workEnvironmentPolicy, 'AuthoritySnapshot.workEnvironmentPolicy');
  if (!Array.isArray(raw.allowedWorkEnvironmentIds)) {
    throw new TypeError('AuthoritySnapshot.workEnvironmentPolicy.allowedWorkEnvironmentIds must be an array.');
  }
  return {
    enabled: raw.enabled === true,
    allowedWorkEnvironmentIds: raw.allowedWorkEnvironmentIds.map((value, index) =>
      requireId(value, `AuthoritySnapshot.workEnvironmentPolicy.allowedWorkEnvironmentIds[${index}]`)),
    defaultWorkEnvironmentId: raw.defaultWorkEnvironmentId === null || raw.defaultWorkEnvironmentId === undefined
      ? null
      : requireId(raw.defaultWorkEnvironmentId, 'AuthoritySnapshot.workEnvironmentPolicy.defaultWorkEnvironmentId')
  };
}

/**
 * The authority one call runs under: the frozen document plus the tool's own per-tool settings,
 * found by `toolConfigKey` (an MCP tool by source id and original name, never its display name).
 */
function callAuthority(
  base: { snapshotId: string; document: PlainJsonValue },
  policy: ReturnType<typeof authorityPolicy>,
  tool: ToolPolicyTool | undefined
): ReliableToolDispatchAuthority {
  const toolConfig = tool ? toolConfigFor(policy.toolConfigs, tool) : undefined;
  const inheritedToolConfigs = policy.inherited.map((layer): InheritedToolConfig => {
    const inherited = tool ? toolConfigFor(layer.toolConfigs, tool) : undefined;
    return { preset: layer.preset, ...(inherited ? { toolConfig: inherited } : {}) };
  });
  return {
    snapshotId: base.snapshotId,
    document: base.document,
    ...(toolConfig ? { toolConfig } : {}),
    ...(inheritedToolConfigs.length > 0 ? { inheritedToolConfigs } : {})
  };
}

/** The declaration a call names, which carries the identity its per-tool settings are keyed by. */
function callTool(definitions: readonly ToolDefinition[], toolName: string): ToolPolicyTool {
  return definitions.find((definition) => definition.declaration.name === toolName)?.declaration ?? { name: toolName };
}

/** The shared frozen-policy rule; MCP tools follow their source settings, including all-sources denies. */
function definitionAllowedByAuthority(
  policy: ReturnType<typeof authorityPolicy>,
  definition: ToolDefinition
): boolean {
  return toolAllowedByPolicy(policy, { name: definition.declaration.name, source: definition.declaration.source });
}

/**
 * Frozen-policy native async opt-in set, by `toolConfigKey`. Only tools explicitly configured with
 * nativeAsync:true may ever be declared async on a native channel; false/missing policy means
 * synchronous, and a declaration-carried flag is never enough on its own.
 */
function nativeAsyncEnabledTools(authority: ReliableToolDispatchAuthority): ReadonlySet<string> {
  const enabled = new Set<string>();
  for (const [rawName, config] of Object.entries(authorityPolicy(authority.document).toolConfigs)) {
    const toolName = rawName.trim();
    if (toolName && config?.nativeAsync === true) enabled.add(toolName);
  }
  return enabled;
}

/** Merges declaration metadata with the frozen policy's async opt-in for the recipe freeze. */
function nativeAsyncToolMetadata(
  toolName: string,
  declarationMetadata: PlainJsonValue | undefined,
  nativeAsyncTools: ReadonlySet<string> | undefined
): PlainJsonValue | undefined {
  const base = declarationMetadata !== null
    && typeof declarationMetadata === 'object'
    && !Array.isArray(declarationMetadata)
    ? declarationMetadata as { [key: string]: PlainJsonValue }
    : undefined;
  if (nativeAsyncTools?.has(toolName) === true) return { ...(base ?? {}), nativeAsync: true };
  if (!base) return undefined;
  const rest = { ...base };
  delete rest.nativeAsync;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

interface SideAutomation {
  executionAutomatic: boolean;
  automaticChangeApply: boolean;
  changeApplyDelaySeconds: number;
  autoSubmitResult: boolean;
}

/**
 * What one Turn's settings (a child's own, or one ancestor's) let this call do on its own. The same
 * rules apply to every side; `freezeDecision` requires all of them.
 */
function sideAutomation(
  input: ReliableAgentToolDispatchInput,
  metadata: ToolDefinitionMetadataRecord | undefined,
  supportsChangeApply: boolean,
  command: string,
  yolo: boolean,
  config: ToolPolicyToolConfigRecord | undefined
): SideAutomation {
  const automaticChangeApply = supportsChangeApply && (
    yolo
    || config?.autoApplyChange
    || (config?.autoApplyChange === undefined && metadata?.defaultAutoApplyChange === true)
  ) === true;
  const commandConfig = commandPolicyConfig(config);
  const allowlistedCommand = !!command && firstMatchedCommandRule(command, commandConfig.allowCommands) !== undefined;
  const autoApproveReadonly = PROCESS_TOOLS.has(input.toolName)
    && commandConfig.autoApproveReadonly
    && isReadonlyCommandCall(input.arguments);
  return {
    executionAutomatic: yolo
      || input.toolName === 'ask_user'
      || input.toolName === 'submit_plan'
      || (input.toolName === RUN_AGENT_TOOL_NAME && isReadonlyRunAgentOperation(input.arguments))
      || isReadonlyAgentCollaborationTool(input.toolName)
      || isReadonlyCrossConversationTool(input.toolName)
      || (input.toolName === 'agent_board' && isReadonlyAgentBoardOperation(input.arguments))
      || allowlistedCommand
      || autoApproveReadonly
      || (config?.autoApproveExecution ?? metadata?.defaultAutoApproveExecution ?? true),
    automaticChangeApply,
    changeApplyDelaySeconds: automaticChangeApply
      ? yolo ? 0 : normalizeAutoApplyDelay(
          config?.autoApplyChangeDelaySeconds ?? metadata?.defaultAutoApplyChangeDelaySeconds ?? 0
        )
      : 0,
    autoSubmitResult: yolo || (config?.autoSubmitResult ?? metadata?.defaultAutoSubmitResult ?? true)
  };
}

interface CommandPolicyConfig {
  denyCommands: string[];
  allowCommands: string[];
  autoApproveReadonly: boolean;
}

function commandPolicyConfig(toolConfig: ToolPolicyToolConfigRecord | undefined): CommandPolicyConfig {
  const config = toolConfig?.config;
  return {
    denyCommands: normalizeStringList(config?.denyCommands),
    allowCommands: normalizeStringList(config?.allowCommands),
    autoApproveReadonly: config?.autoApproveReadonly !== false
  };
}

function firstMatchedCommandRule(command: string, rules: readonly string[]): string | undefined {
  const normalized = command.toLowerCase();
  return rules.find((rule) => normalized.includes(rule.toLowerCase()));
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  for (const entry of value) {
    const text = typeof entry === 'string' ? entry.trim() : '';
    if (text && !normalized.includes(text)) normalized.push(text);
  }
  return normalized;
}

function frozenSchedulingFallback(
  definition: ReliableAgentToolDefinition,
  value: PlainJsonValue
): { mode: 'parallel' | 'serial'; reason: string } {
  if (PROCESS_TOOLS.has(definition.name)) {
    return frozenCommandScheduling(classifyCommandCall(value), value);
  }
  const args = plainOptionalRecord(value);
  if (args?.scheduling === 'parallel' || args?.scheduling === 'serial') {
    return { mode: args.scheduling, reason: `provider_selected_${args.scheduling}` };
  }
  const metadata = plainOptionalRecord(definition.metadata);
  if ((definition.name === RUN_AGENT_TOOL_NAME && isReadonlyRunAgentOperation(value))
    || isReadonlyAgentCollaborationTool(definition.name)
    || isReadonlyCrossConversationTool(definition.name)
    || (definition.name === 'agent_board' && isReadonlyAgentBoardOperation(value))
    || metadata?.readonly === true || metadata?.riskLevel === 'read') {
    return { mode: 'parallel', reason: 'frozen_readonly_metadata' };
  }
  return { mode: 'serial', reason: 'frozen_default_serial' };
}

function frozenPlanReviewRiskLevel(
  definition: ToolDefinition,
  input: ReliableAgentToolDispatchInput
): FrozenPlanReviewRiskLevel {
  if (input.toolName === RUN_AGENT_TOOL_NAME && isReadonlyRunAgentOperation(input.arguments)) return 'read';
  if (isReadonlyAgentCollaborationTool(input.toolName) || isReadonlyCrossConversationTool(input.toolName)
    || (input.toolName === 'agent_board' && isReadonlyAgentBoardOperation(input.arguments))) return 'read';
  if (FILE_TOOLS.has(input.toolName)) return 'write';
  if (PROCESS_TOOLS.has(input.toolName)) {
    return isReadonlyCommandCall(input.arguments) ? 'read' : 'command';
  }
  const risk = definition.declaration.metadata?.riskLevel;
  if (risk === 'read' || risk === 'write' || risk === 'command' || risk === 'agent') return risk;
  return 'read';
}

function frozenCommandScheduling(
  classification: TrustedCommandClassification,
  value: PlainJsonValue
): { mode: 'parallel' | 'serial'; reason: string } {
  const args = plainOptionalRecord(value);
  if (args?.scheduling === 'parallel' || args?.scheduling === 'serial') {
    return { mode: args.scheduling, reason: `model_selected_${args.scheduling}` };
  }
  const wait = typeof args?.wait === 'string' ? args.wait.trim().toLowerCase() : '';
  if (wait === 'false') return { mode: 'parallel', reason: 'legacy_wait_false' };
  if (wait === 'true') return { mode: 'serial', reason: 'legacy_wait_true' };
  if (classification.parallelSafe) return { mode: 'parallel', reason: classification.reason };
  return { mode: 'serial', reason: classification.reason };
}

function normalizeAutoApplyDelay(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(600, Math.max(0, Math.floor(value)))
    : 0;
}

function frozenPolicyFromRow(row: DomainRow): FrozenToolCallPolicyDecision {
  const executionGate = String(row.execution_gate);
  const changeApplyMode = String(row.change_apply_mode);
  const schedulingMode = String(row.scheduling_mode);
  if (!['automatic', 'approval_required'].includes(executionGate)) {
    throw new TypeError(`Invalid ToolCallPolicySnapshot.execution_gate: ${executionGate}.`);
  }
  if (!['automatic', 'manual', 'unsupported'].includes(changeApplyMode)) {
    throw new TypeError(`Invalid ToolCallPolicySnapshot.change_apply_mode: ${changeApplyMode}.`);
  }
  if (!['parallel', 'serial'].includes(schedulingMode)) {
    throw new TypeError(`Invalid ToolCallPolicySnapshot.scheduling_mode: ${schedulingMode}.`);
  }
  return {
    ...(typeof row.summary === 'string' ? { summary: row.summary } : {}),
    displayAutoExpand: row.display_auto_expand === 1n,
    displayAutoOpenDiff: row.display_auto_open_diff === 1n,
    executionGate: executionGate as FrozenToolCallPolicyDecision['executionGate'],
    changeApplyMode: changeApplyMode as FrozenToolCallPolicyDecision['changeApplyMode'],
    changeApplyDelaySeconds: bigintToSafeNumber(
      row.change_apply_delay_seconds,
      'ToolCallPolicySnapshot.change_apply_delay_seconds'
    ),
    autoSubmitResult: row.auto_submit_result === 1n,
    schedulingMode: schedulingMode as FrozenToolCallPolicyDecision['schedulingMode'],
    ...(typeof row.scheduling_reason === 'string' ? { schedulingReason: row.scheduling_reason } : {})
  };
}

function normalizeRuntimeToolEvent(event: ToolRuntimeEvent): ToolRuntimeEvent {
  if (!event || !['stdout', 'stderr', 'progress'].includes(event.kind)) {
    throw new TypeError(`Unsupported runtime Tool event kind: ${String(event?.kind)}.`);
  }
  if (event.delta !== undefined && typeof event.delta !== 'string') {
    throw new TypeError('Runtime Tool event delta must be text.');
  }
  return normalizePlainJson({
    kind: event.kind,
    ...(event.delta !== undefined ? { delta: event.delta } : {}),
    ...(event.progress !== undefined ? { progress: event.progress } : {}),
    ...(event.payload !== undefined ? { payload: event.payload } : {})
  }, 'Runtime Tool event') as unknown as ToolRuntimeEvent;
}

function isTerminalOperationStatus(value: unknown): value is ToolOutcomeStatus {
  return ['succeeded', 'failed', 'partial', 'rejected', 'cancelled', 'conflict', 'outcome_unknown']
    .includes(String(value));
}

function bigintToSafeNumber(value: unknown, label: string): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must be a non-negative bigint.`);
  return value;
}

function plainOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function preparedToolInputIdentity(input: ReliableAgentToolDispatchInput): string {
  return canonicalPlainJson({
    turnId: input.turnId,
    modelRequestId: input.modelRequestId,
    toolCallId: input.toolCallId,
    providerCallId: input.providerCallId ?? null,
    toolName: input.toolName,
    arguments: input.arguments
  }, 'Prepared Provider ToolCall');
}

function sameReliableToolDefinition(
  left: ReliableAgentToolDefinition,
  right: ReliableAgentToolDefinition
): boolean {
  return canonicalPlainJson(left, 'Recipe Tool definition')
    === canonicalPlainJson(right, 'Prepared Tool definition');
}

function providerDefinitionMismatchFromRecipe(
  toolName: string,
  definition: ToolDefinition,
  recipe: Record<string, unknown>
): string | undefined {
  if (!Array.isArray(recipe.tools)) return 'ModelRequest recipe.tools 不是数组。';
  const matches = recipe.tools
    .map((value, index) => requireRecord(value, `ModelRequest recipe.tools[${index}]`))
    .filter((value) => value.name === toolName);
  if (matches.length !== 1) return `ModelRequest recipe 中工具 ${toolName} 不是唯一声明。`;
  return sameToolSource(definition.declaration.source, matches[0].source)
    ? undefined
    : `工具 ${toolName} 的当前 capability source 与 Provider 请求冻结 source 不一致；拒绝跨源执行。`;
}

function sameToolSource(left: unknown, right: unknown): boolean {
  return canonicalPlainJson(left ?? null, 'Tool source') === canonicalPlainJson(right ?? null, 'Frozen Tool source');
}

function optionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTurnCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TurnCancellationError';
}

class NoEffectCapabilityTimeoutError extends Error {
  public constructor() {
    super(`Readonly capability exceeded ${NO_EFFECT_CAPABILITY_TIMEOUT_MS}ms.`);
    this.name = 'NoEffectCapabilityTimeoutError';
  }
}

async function executeBoundedNoEffect<T>(
  parentSignal: AbortSignal,
  execute: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(parentSignal.reason ?? new Error('Readonly capability cancelled.'));
  if (parentSignal.aborted) cancel();
  else parentSignal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new NoEffectCapabilityTimeoutError()), NO_EFFECT_CAPABILITY_TIMEOUT_MS);
  timer.unref?.();
  try {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Readonly capability cancelled.');
    const operation = execute(controller.signal);
    return await abortableCapability(operation, controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', cancel);
  }
}

function abortableCapability<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Readonly capability cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('Readonly capability cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

const TERMINATION_INPUT_KINDS = [
  'interrupt_request',
  'interrupt_current_turn',
  'termination_request'
] as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForSettlementsOrGrace(completions: Promise<unknown>[], milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    void Promise.allSettled(completions).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function reliableDefinitionFromTool(definition: ToolDefinition): ReliableAgentToolDefinition {
  return {
    name: definition.declaration.name,
    description: definition.declaration.description,
    parameters: normalizePlainJson(definition.declaration.parameters ?? {}, 'Tool parameters'),
    ...(definition.declaration.source ? {
      source: normalizePlainJson(definition.declaration.source, 'Tool source')
    } : {}),
    ...(definition.declaration.metadata ? {
      metadata: normalizePlainJson(definition.declaration.metadata, 'Tool metadata')
    } : {}),
    ...(definition.declaration.defaultConfig ? {
      defaultConfig: normalizePlainJson(definition.declaration.defaultConfig, 'Tool default config')
    } : {})
  };
}

function isDeferredNoEffectSettlement(result: InternalDispatchResult): result is DeferredNoEffectSettlement {
  return 'disposition' in result && result.disposition === 'deferred_no_effect';
}

function isAttachmentReadInput(input: ReliableAgentToolDispatchInput): boolean {
  if (input.toolName !== 'read') return false;
  const args = plainOptionalRecord(input.arguments);
  const explicitMode = optionalText(args?.mode);
  if (explicitMode !== undefined && explicitMode !== 'text' && explicitMode !== 'attachment') return false;
  return effectiveLocalPathReadMode(args?.path, explicitMode as 'text' | 'attachment' | undefined) === 'attachment';
}

function noEffectModelDetail(toolName: string, result: ToolResultOut): PlainJsonValue {
  if (toolName === 'read' && result.ok && !result.parts && !result.status) {
    return normalizePlainJson(result.output ?? null, 'Tool read result');
  }
  return normalizePlainJson({
    ok: result.ok,
    output: result.output ?? null,
    ...(result.parts ? { parts: result.parts } : {}),
    ...(result.status ? { status: result.status } : {})
  }, `Tool ${toolName} result`);
}

function isToolSettledResult(
  result: ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled
): result is ReliableAgentToolSettled {
  return 'disposition' in result && result.disposition === 'settled';
}

function processStatus(observed: ProcessWaitObservation): string {
  if (observed.state === 'running') return 'running';
  if (observed.state === 'outcome_unknown') return 'outcome_unknown';
  if (observed.receipt.terminationReason === 'manual') return 'killed';
  if (observed.receipt.terminationReason === 'timed_out') return 'timed_out';
  if (observed.receipt.terminationReason === 'output_limit_exceeded') return 'output_limit_exceeded';
  return 'exited';
}

function processExitCode(observed: ProcessWaitObservation): number | null {
  if (observed.state !== 'exited') return null;
  const value = observed.receipt.exitCode;
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function effectiveProcessForegroundWaitMs(
  command: string,
  requestedWaitMs: number,
  executionTimeoutMs: number
): number {
  const replacesCurrentExtension = command.includes('--uninstall-extension')
    && command.includes('--install-extension')
    && command.includes(EXTENSION_PACKAGE_NAME);
  return replacesCurrentExtension
    ? Math.max(requestedWaitMs, executionTimeoutMs)
    : requestedWaitMs;
}

function requireWaitMs(value: PlainJsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new TypeError('foregroundWaitMs must be an integer from 0 to 60000.');
  }
  return value;
}

function requireOptionalBoundedInteger(
  value: PlainJsonValue | undefined,
  defaultValue: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function plainRecord(value: PlainJsonValue | undefined, label: string): Record<string, unknown> {
  return requireRecord(value, label) as Record<string, unknown>;
}

function requireRecord(value: PlainJsonValue | undefined, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}
