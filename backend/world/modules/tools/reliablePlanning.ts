import type { Entity, WorldReader } from '../../../ecs/types';
import { Agent, AgentKind, type AgentData } from '../agent/components';
import { AgentBlueprintsKey, type BuiltinAgentDefinition, type BuiltinAgentRegistry } from '../agent/blueprints';
import { agentSelectorSlug, isTemporaryAgentEntity } from '../agent/identity';
import { AgentRun } from '../agentRun/components';
import { activeToolPolicyForRun, runTarget } from '../agentRun/queries';
import { Conversation } from '../chat/components';
import { LlmInvocation, RunLlmInvocationLink } from '../llm/components';
import { effectivePlanReviewPolicyForRun, hasApprovedPlanForRun, planReviewRequiresRiskLevel } from '../plan/queries';
import {
  activeWorkEnvironmentForRun,
  effectiveWorkEnvironmentPolicyForRun,
  pathAccessibleWorkEnvironmentsForRun,
  toPublicWorkEnvironmentRecord,
  toolContextWorkEnvironmentsForRun
} from '../workEnvironment/queries';
import type { ToolPolicyData } from '../workflow/components';
import { isReadonlyCommandCall } from './definitions/command';
import { allowOutsideProjectPathsFromConfig } from './definitions/filePathPolicy';
import { DEFAULT_RUN_AGENT_TYPE, RUN_AGENT_TOOL_NAME, isReadonlyRunAgentOperation } from './definitions/runAgent';
import {
  ASK_USER_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  TRANSFER_TOOL_NAME,
  type AgentSource,
  type DeliveryMode,
  type LlmInvocationSettingsSnapshotRecord,
  type MessageContent,
  type PlanReviewRequiredToolRiskLevel,
  type RunContextPolicyRecord,
  type ToolConfigRecord,
  type ToolRiskLevel
} from '../../../../shared/protocol';
import { nextAuxiliaryId } from '../../../reliability/stableIdFactory';
import { ToolCall, type ToolCallData } from './components';
import { isToolNameAllowedByPolicy, isYoloToolPolicy } from './policy';
import { ToolDefinitionsKey, ToolRuntimeDefinitionsKey } from './resources';

/**
 * 可靠控制面的只读规划边界。
 *
 * 这里允许读取已提交事实的 ECS 投影来冻结 effect 输入，但绝不创建/修改 Conversation、Turn、
 * Message、Interaction 或 Tool 生命周期。所有写入必须回到可靠事务处理器。
 */

interface AuthorizedRunTool {
  run: Entity;
  policy: ToolPolicyData;
}

export type ReliableToolExecutionPlan =
  | { disposition: 'rejected'; reason: string }
  | {
      disposition: 'ready' | 'awaiting_approval';
      readonly: boolean;
      autoApplyChange: boolean;
      autoApplyChangeDelaySeconds: number;
      autoSubmitResult: boolean;
      effectPayload: Record<string, unknown>;
    };

/** Pure read-side authorization/freeze step used before a reliable Tool Operation is committed. */
export function planReliableToolExecution(
  world: WorldReader,
  input: { runId: string; toolCallId: string; name: string; argsJson: string; createdAt: number }
): ReliableToolExecutionPlan {
  const run = world.entityByRecordId(AgentRun, input.runId);
  const runData = run === undefined ? undefined : world.get(run, AgentRun);
  const target = run === undefined ? undefined : runTarget(world, run);
  const policy = run === undefined ? undefined : activeToolPolicyForRun(world, run);
  const conversation = target ? world.get(target.conversation, Conversation) : undefined;
  if (run === undefined || !runData || !target || !policy || !conversation) {
    return { disposition: 'rejected', reason: `AgentRun ${input.runId} 没有完整的 ToolPolicy/目标投影。` };
  }

  const call: ToolCallData = {
    id: input.toolCallId,
    name: input.name,
    argsJson: input.argsJson,
    createdAt: input.createdAt
  };
  const definition = (world.tryGetResource(ToolDefinitionsKey) ?? []).find((tool) => tool.name === call.name);
  if (!isToolNameAllowedByPolicy(policy, call.name, definition)) {
    return { disposition: 'rejected', reason: `AgentRun ${input.runId} 不允许执行工具 ${call.name}。` };
  }
  if ((call.name === SWITCH_WORK_ENVIRONMENT_TOOL_NAME || call.name === TRANSFER_TOOL_NAME)
    && effectiveWorkEnvironmentPolicyForRun(world, run).policy?.enabled === false) {
    return { disposition: 'rejected', reason: `当前工作环境策略已停用工具 ${call.name}。` };
  }

  const authorization: AuthorizedRunTool = { run, policy };
  const planGate = authorizePlanReviewForTool(world, call, authorization);
  if (!planGate.ok) return { disposition: 'rejected', reason: planGate.reason };

  const config = effectiveToolConfig(world, policy, call.name);
  const gate = toolGateSettings(world, policy, call.name);
  const workEnvironment = activeWorkEnvironmentForRun(world, run)?.data;
  const workEnvironments = toolContextWorkEnvironmentsForRun(world, run).map((item) => toPublicWorkEnvironmentRecord(item.data));
  const accessibleWorkEnvironments = pathAccessibleWorkEnvironmentsForRun(world, run).map((item) => toPublicWorkEnvironmentRecord(item.data));
  const settingsSnapshot = settingsSnapshotForRun(world, run);
  const runtimeDefinition = (world.tryGetResource(ToolRuntimeDefinitionsKey) ?? []).find((tool) => tool.declaration.name === call.name);
  const readonly = runtimeDefinition?.declaration.metadata?.readonly === true
    || (call.name === RUN_AGENT_TOOL_NAME && isReadonlyRunAgentOperation(parseToolCallArgs(call.argsJson)))
    || (isCommandToolName(call.name) && isReadonlyCommandCall(parseToolCallArgs(call.argsJson)));

  return {
    disposition: requiresExecutionApproval(world, policy, call) ? 'awaiting_approval' : 'ready',
    readonly,
    autoApplyChange: gate.autoApplyChange,
    autoApplyChangeDelaySeconds: gate.autoApplyChangeDelaySeconds,
    autoSubmitResult: gate.autoSubmitResult,
    effectPayload: {
      toolCallId: call.id,
      name: call.name,
      argsJson: call.argsJson,
      runId: runData.id,
      conversationId: conversation.id,
      ...(config ? { config } : {}),
      ...(settingsSnapshot ? { settingsSnapshot } : {}),
      ...(workEnvironment ? { workEnvironment: toPublicWorkEnvironmentRecord(workEnvironment) } : {}),
      ...(workEnvironments.length > 0 ? { workEnvironments } : {}),
      ...(accessibleWorkEnvironments.length > 0 ? { accessibleWorkEnvironments } : {}),
      allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(config, false),
      autoApplyChange: gate.autoApplyChange,
      autoApplyChangeDelaySeconds: gate.autoApplyChangeDelaySeconds,
      autoSubmitResult: gate.autoSubmitResult
    }
  };
}

function settingsSnapshotForRun(world: WorldReader, run: Entity): LlmInvocationSettingsSnapshotRecord | undefined {
  let latest: { settings: LlmInvocationSettingsSnapshotRecord; invocationCreatedAt: number; linkCreatedAt: number; linkId: string } | undefined;
  for (const entity of world.query(RunLlmInvocationLink)) {
    const link = world.get(entity, RunLlmInvocationLink);
    if (!link || link.run !== run) continue;
    const invocation = world.get(link.invocation, LlmInvocation);
    if (!invocation?.settings) continue;
    const candidate = {
      settings: invocation.settings,
      invocationCreatedAt: invocation.createdAt,
      linkCreatedAt: link.createdAt,
      linkId: link.id
    };
    if (!latest
      || candidate.invocationCreatedAt > latest.invocationCreatedAt
      || (candidate.invocationCreatedAt === latest.invocationCreatedAt && candidate.linkCreatedAt > latest.linkCreatedAt)
      || (candidate.invocationCreatedAt === latest.invocationCreatedAt
        && candidate.linkCreatedAt === latest.linkCreatedAt
        && candidate.linkId > latest.linkId)) {
      latest = candidate;
    }
  }
  return latest?.settings;
}

type PlanReviewGateResult = { ok: true } | { ok: false; reason: string };

function authorizePlanReviewForTool(world: WorldReader, call: ToolCallData, authorization: AuthorizedRunTool): PlanReviewGateResult {
  if (call.name === SUBMIT_PLAN_TOOL_NAME) return { ok: true };
  const policy = effectivePlanReviewPolicyForRun(world, authorization.run).policy;
  if (policy.mode !== 'before_mutation') return { ok: true };

  const riskLevel = planReviewRiskLevelForTool(world, call);
  if (riskLevel === 'read') {
    if (policy.allowReadonlyBeforeApproval || hasApprovedPlanForRun(world, authorization.run)) return { ok: true };
    return { ok: false, reason: '当前工作流要求 Plan 批准后才能继续执行工具。请先调用 submit_plan 并等待用户批准。' };
  }

  const requiredRiskLevel = toPlanReviewRequiredRiskLevel(riskLevel);
  if (!requiredRiskLevel || !planReviewRequiresRiskLevel(policy, requiredRiskLevel)) return { ok: true };
  if (hasApprovedPlanForRun(world, authorization.run)) return { ok: true };
  return { ok: false, reason: '当前工作流要求先提交并批准 Plan。请先调用 submit_plan，等待用户批准后再执行会修改文件、运行非只读命令或启动子 Agent 的工具。' };
}

function planReviewRiskLevelForTool(world: WorldReader, call: ToolCallData): ToolRiskLevel {
  if (call.name === RUN_AGENT_TOOL_NAME && isReadonlyRunAgentOperation(parseToolCallArgs(call.argsJson))) return 'read';
  if (call.name === 'edit' || call.name === 'write' || call.name === 'delete') return 'write';
  if (isCommandToolName(call.name)) return isReadonlyCommandCall(parseToolCallArgs(call.argsJson)) ? 'read' : 'command';
  if (isAgentRunTool(world, call.name)) return 'agent';
  const definition = (world.tryGetResource(ToolDefinitionsKey) ?? []).find((tool) => tool.name === call.name);
  if (definition?.metadata?.readonly === true) return 'read';
  return definition?.metadata?.riskLevel ?? 'read';
}

function toPlanReviewRequiredRiskLevel(riskLevel: ToolRiskLevel): PlanReviewRequiredToolRiskLevel | undefined {
  return riskLevel === 'write' || riskLevel === 'command' || riskLevel === 'agent' ? riskLevel : undefined;
}

function isAgentRunTool(world: WorldReader, toolName: string): boolean {
  return (world.tryGetResource(ToolDefinitionsKey) ?? []).some((tool) => tool.name === toolName && tool.execution === 'agentRun');
}

function effectiveToolConfig(world: WorldReader, policy: ToolPolicyData, toolName: string): ToolConfigRecord | undefined {
  const definition = (world.tryGetResource(ToolDefinitionsKey) ?? []).find((tool) => tool.name === toolName);
  const config = {
    ...(definition?.defaultConfig ?? {}),
    ...(policy.toolConfigs?.[toolName]?.config ?? {})
  } satisfies ToolConfigRecord;
  return Object.keys(config).length > 0 ? config : undefined;
}

function toolGateSettings(world: WorldReader, policy: ToolPolicyData, toolName: string): {
  autoApproveExecution: boolean;
  autoApplyChange: boolean;
  autoApplyChangeDelaySeconds: number;
  autoSubmitResult: boolean;
} {
  if (isYoloToolPolicy(policy)) {
    return { autoApproveExecution: true, autoApplyChange: true, autoApplyChangeDelaySeconds: 0, autoSubmitResult: true };
  }
  const config = policy.toolConfigs?.[toolName];
  const definitions = world.tryGetResource(ToolRuntimeDefinitionsKey) ?? [];
  const meta = definitions.find((tool) => tool.declaration.name === toolName)?.declaration.metadata;
  return {
    autoApproveExecution: config?.autoApproveExecution ?? meta?.defaultAutoApproveExecution ?? true,
    autoApplyChange: config?.autoApplyChange ?? meta?.defaultAutoApplyChange ?? true,
    autoApplyChangeDelaySeconds: normalizeAutoApplyDelay(config?.autoApplyChangeDelaySeconds ?? meta?.defaultAutoApplyChangeDelaySeconds ?? 3),
    autoSubmitResult: config?.autoSubmitResult ?? meta?.defaultAutoSubmitResult ?? true
  };
}

function normalizeAutoApplyDelay(value: number): number {
  return Math.min(600, Math.max(0, Math.floor(Number.isFinite(value) ? value : 3)));
}

function requiresExecutionApproval(world: WorldReader, policy: ToolPolicyData, call: ToolCallData): boolean {
  if (call.name === RUN_AGENT_TOOL_NAME && isReadonlyRunAgentOperation(parseToolCallArgs(call.argsJson))) return false;
  if (call.name === ASK_USER_TOOL_NAME || call.name === SUBMIT_PLAN_TOOL_NAME || isRunAgentInterruptCall(call)) return false;
  if (toolGateSettings(world, policy, call.name).autoApproveExecution !== false) return false;
  const config = effectiveToolConfig(world, policy, call.name);
  if (config?.autoApproveReadonly === true && isReadonlyCommandCall(parseToolCallArgs(call.argsJson))) return false;
  return true;
}

function isRunAgentInterruptCall(call: ToolCallData): boolean {
  if (call.name !== RUN_AGENT_TOOL_NAME) return false;
  const args = parseToolCallArgs(call.argsJson);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  return (args as { operation?: unknown }).operation === 'interrupt_subtree';
}

function isCommandToolName(toolName: string): boolean {
  return toolName === 'shell' || toolName === 'bash';
}

function parseToolCallArgs(argsJson: string | undefined): unknown {
  if (!argsJson) return {};
  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    return {};
  }
}

interface RunAgentArgs {
  operation?: string;
  taskName?: string;
  prompt?: string;
  answerBridgeId?: string;
  agent?: { id?: string; type?: string };
  foregroundWaitMs?: number;
}

interface RunAgentToolProgress {
  childRunId?: string;
  runId?: string;
  agentId?: string;
  agentType?: string;
  conversationId?: string;
  answerBridgeId?: string;
  foregroundWaitMs?: number;
  startedAt?: number;
}

export interface LaunchChildAgentRunValue {
  progress: RunAgentToolProgress;
  deliveryMode: DeliveryMode;
  background: boolean;
  childMessageId: string;
  childRevisionId: string;
  childContent: MessageContent;
  contextPolicy: Omit<RunContextPolicyRecord, 'id'>;
  targetConversationTitle?: string;
  agentMirror?: {
    id: string;
    typeId: string;
    name: string;
    description?: string;
    source?: AgentSource;
  };
}

export interface ReliableChildContinuationTarget {
  answerBridgeId: string;
  conversationId: string;
  agentId: string;
  agentType: string;
}

export interface ReliableChildAgentLaunchIds {
  conversationId: string;
  answerBridgeId: string;
  childRunId: string;
  childMessageId: string;
  childRevisionId: string;
  startedAt: number;
}

/**
 * Read-only child launch planner. It does not materialize Conversation/Message/Turn facts in the live
 * World; they become visible only after the multi-scope `answer_bridge.open` transaction commits.
 */
export function planReliableChildAgentRun(
  world: WorldReader,
  input: {
    sourceRunId: string;
    sourceToolCallId: string;
    argsJson: string;
    ids: ReliableChildAgentLaunchIds;
    continuation?: ReliableChildContinuationTarget;
  }
): { ok: true; value: LaunchChildAgentRunValue } | { ok: false; reason: string } {
  const sourceRun = world.entityByRecordId(AgentRun, input.sourceRunId);
  const sourceToolCall = world.entityByRecordId(ToolCall, input.sourceToolCallId);
  if (sourceRun === undefined || sourceToolCall === undefined || !runTarget(world, sourceRun)) {
    return { ok: false, reason: '可靠 run_agent 缺少已提交的父 Turn/ToolCall/Target 投影。' };
  }

  let args: RunAgentArgs;
  try {
    args = input.argsJson ? JSON.parse(input.argsJson) as RunAgentArgs : {};
  } catch (error) {
    return { ok: false, reason: `run_agent 参数不是合法 JSON: ${String(error)}` };
  }
  const operation = args.operation;
  if (operation !== 'spawn' && operation !== 'send') return { ok: false, reason: '可靠 child launch 必须明确使用 operation=spawn 或 send。' };
  if (operation === 'spawn' && (!args.taskName?.trim() || args.answerBridgeId !== undefined || input.continuation)) {
    return { ok: false, reason: 'spawn 必须提供 taskName，且不能提供已有子对话引用。' };
  }
  if (operation === 'send' && (!args.answerBridgeId?.trim() || !input.continuation)) {
    return { ok: false, reason: 'send 必须提供可验证的已有子对话引用。' };
  }
  if (args.agent?.id !== undefined) return { ok: false, reason: 'run_agent 不接受 agent.id；新建使用 agent.type，续接使用 answerBridgeId。' };
  const prompt = args.prompt?.trim();
  if (!prompt) return { ok: false, reason: 'run_agent 缺少必填 prompt。' };
  const foregroundWait = normalizeRunAgentForegroundWaitMs(args.foregroundWaitMs);
  if (!foregroundWait.ok) return foregroundWait;

  const requestedBridgeId = args.answerBridgeId?.trim();
  if (!!requestedBridgeId !== !!input.continuation
    || (requestedBridgeId && requestedBridgeId !== input.continuation?.answerBridgeId)) {
    return {
      ok: false,
      reason: requestedBridgeId
        ? `未找到 answerBridgeId 绑定的可靠子对话：${requestedBridgeId}`
        : '可靠 child continuation 缺少 answerBridgeId。'
    };
  }

  let targetAgentId: string;
  let targetAgentType: string;
  let targetConversationId: string;
  let answerBridgeId: string;
  let targetConversationTitle: string | undefined;
  let agentMirror: LaunchChildAgentRunValue['agentMirror'];

  if (input.continuation) {
    const targetAgent = findAgentById(world, input.continuation.agentId);
    const targetConversation = world.entityByRecordId(Conversation, input.continuation.conversationId);
    if (targetAgent === undefined || targetConversation === undefined) {
      return { ok: false, reason: `answerBridgeId 绑定的 Agent/Conversation 投影不完整：${input.continuation.answerBridgeId}` };
    }
    targetAgentId = input.continuation.agentId;
    targetAgentType = input.continuation.agentType;
    targetConversationId = input.continuation.conversationId;
    answerBridgeId = input.continuation.answerBridgeId;
    targetConversationTitle = world.get(targetConversation, Conversation)?.title;
  } else {
    const requestedKind = args.agent?.type?.trim() || DEFAULT_RUN_AGENT_TYPE;
    const blueprints = world.getResource(AgentBlueprintsKey);
    const resolvedType = resolveAgentType(world, blueprints, requestedKind);
    if (!resolvedType) {
      return { ok: false, reason: `未知 Agent 类型: ${requestedKind}。可用类型：${availableAgentTypes(world, blueprints).join(', ')}` };
    }
    const { definition, typeAgentData, typeId } = resolvedType;
    targetAgentId = createRunAgentAgentId(world, typeId);
    targetAgentType = typeId;
    targetConversationId = input.ids.conversationId;
    answerBridgeId = input.ids.answerBridgeId;
    targetConversationTitle = args.taskName!.trim();
    agentMirror = {
      id: targetAgentId,
      typeId,
      name: typeAgentData?.name ?? definition.name,
      ...(typeAgentData?.description ?? definition.description
        ? { description: typeAgentData?.description ?? definition.description }
        : {}),
      source: typeAgentData?.source ?? 'builtin'
    };
  }

  const promptWithAnswerBridge = `${prompt}\n\n[Agent answer bridge]\n本次任务已绑定默认回答通道。需要把阶段性结论或最终正文提交给来源 Agent 时，请调用 submit_agent_answer({ title, content }) 并省略 childRef；Runtime 会使用当前子任务的默认通道。只有在用户明确要求提交到其它通道时，才传入当前模型上下文中提供的短 childRef。继续同一子对话、中断或重试不会改变默认通道。最终自然语言回复可以保持简短。`;
  const background = foregroundWait.value === 0;
  return {
    ok: true,
    value: {
      background,
      deliveryMode: background ? 'notification' : 'tool_response',
      childMessageId: input.ids.childMessageId,
      childRevisionId: input.ids.childRevisionId,
      childContent: { role: 'user', parts: [{ text: promptWithAnswerBridge }] },
      contextPolicy: { historyMode: 'full' },
      ...(targetConversationTitle ? { targetConversationTitle } : {}),
      ...(agentMirror ? { agentMirror } : {}),
      progress: {
        childRunId: input.ids.childRunId,
        runId: input.ids.childRunId,
        agentId: targetAgentId,
        agentType: targetAgentType,
        conversationId: targetConversationId,
        answerBridgeId,
        foregroundWaitMs: foregroundWait.value,
        startedAt: input.ids.startedAt
      }
    }
  };
}

function normalizeRunAgentForegroundWaitMs(value: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: 0 };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 86_400_000) {
    return { ok: false, reason: 'run_agent.foregroundWaitMs 省略时默认为 0；传入时必须是 0 到 86400000 的整数毫秒数。' };
  }
  return { ok: true, value };
}

function resolveAgentType(
  world: WorldReader,
  blueprints: BuiltinAgentRegistry,
  selector: string
): { definition: BuiltinAgentDefinition; typeId: string; typeAgent?: Entity; typeAgentData?: AgentData } | undefined {
  const configured = findAgentTypeBySelector(world, blueprints, selector);
  if (configured !== undefined) {
    const agent = world.get(configured, Agent);
    if (!agent) return undefined;
    const declaredKind = world.get(configured, AgentKind)?.kind || agent.id;
    const typeId = agent.id;
    return {
      definition: resolveAgentDefinition(blueprints, typeId)
        ?? resolveAgentDefinition(blueprints, declaredKind)
        ?? definitionFromExistingAgent(agent, typeId),
      typeId,
      typeAgent: configured,
      typeAgentData: agent
    };
  }
  const definition = resolveAgentDefinition(blueprints, selector);
  if (!definition) return undefined;
  const typeAgent = findAgentTypeBySelector(world, blueprints, definition.id)
    ?? findAgentTypeBySelector(world, blueprints, definition.kind);
  const typeAgentData = typeAgent !== undefined ? world.get(typeAgent, Agent) : undefined;
  const typeId = typeAgentData?.id ?? definition.id;
  return {
    definition,
    typeId,
    ...(typeAgent !== undefined ? { typeAgent } : {}),
    ...(typeAgentData ? { typeAgentData } : {})
  };
}

function resolveAgentDefinition(blueprints: BuiltinAgentRegistry, kind: string): BuiltinAgentDefinition | undefined {
  return blueprints.agents[kind]
    ?? Object.values(blueprints.agents).find((candidate) => candidate.kind === kind || candidate.id === kind);
}

function findAgentTypeBySelector(world: WorldReader, blueprints: BuiltinAgentRegistry, selector: string): Entity | undefined {
  const exact = world.entityByRecordId(Agent, selector);
  if (exact !== undefined && isAvailableAgentTypeEntity(world, blueprints, exact)) return exact;
  const matches = world.query(Agent).filter((entity) => isAvailableAgentTypeEntity(world, blueprints, entity)
    && world.get(entity, AgentKind)?.kind === selector);
  if (matches.length > 1) throw new Error(`Agent type selector is ambiguous: ${selector}`);
  return matches[0];
}

function isAvailableAgentTypeEntity(world: WorldReader, blueprints: BuiltinAgentRegistry, entity: Entity): boolean {
  if (isTemporaryAgentEntity(world, entity)) return false;
  const agent = world.get(entity, Agent);
  if (!agent) return false;
  if (agent.source !== 'builtin') return true;
  const kind = world.get(entity, AgentKind)?.kind;
  return resolveAgentDefinition(blueprints, agent.id) !== undefined
    || (!!kind && resolveAgentDefinition(blueprints, kind) !== undefined);
}

function definitionFromExistingAgent(agent: { id: string; name: string; description?: string }, kind: string): BuiltinAgentDefinition {
  return {
    id: agent.id,
    kind,
    name: agent.name,
    description: agent.description,
    systemPrompt: '',
    toolPolicy: { allowedTools: [] }
  };
}

function availableAgentTypes(world: WorldReader, blueprints: BuiltinAgentRegistry): string[] {
  const configured = world.query(Agent)
    .filter((entity) => isAvailableAgentTypeEntity(world, blueprints, entity))
    .map((entity) => world.get(entity, Agent)?.id)
    .filter((id): id is string => !!id);
  return [...new Set([...configured, ...Object.values(blueprints.agents).map((definition) => definition.kind)])];
}

function createRunAgentAgentId(world: WorldReader, kind: string): string {
  const id = nextAuxiliaryId(`agent${agentSelectorSlug(kind).replace(/[^a-z0-9]/g, '')}`);
  if (findAgentById(world, id) !== undefined) throw new Error(`Generated temporary Agent identity already exists: ${id}`);
  return id;
}

function findAgentById(world: WorldReader, id: string): Entity | undefined {
  return world.entityByRecordId(Agent, id);
}
