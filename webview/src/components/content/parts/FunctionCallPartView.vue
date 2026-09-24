<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { IconFileDiff, IconTool, IconPlayerStop, IconRefresh } from '@tabler/icons-vue';
import {
  ASK_USER_TOOL_NAME,
  DELETE_TOOL_NAME,
  READ_AGENT_ANSWER_TOOL_NAME,
  SKILLS_TOOL_NAME,
  SUBMIT_AGENT_ANSWER_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TRANSFER_TOOL_NAME
} from '@shared/protocol';
import { MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN } from '@shared/agentScheduling';
import { submitPlanOutputFromResult } from '@shared/planReview';
import type {
  FunctionCallPart,
  InteractionResultPayload,
  ToolCallEventRecord,
  ToolCallRecord,
  ToolCallStatus,
  ToolSchedulingMode
} from '@shared/protocol';
import type { DurableInteractionRequestKind } from '@shared/conversationReliability';
import type { ReliableKernelClientDetailKind } from '@shared/reliableKernelClientFeed';
import {
  interactionViewFromReliableRuntime,
  type InteractionView
} from '@webview/domain/interactionProjection';
import {
  shouldKeepTransientToolCallPreview,
  transientToolCallPreviewForMessage
} from '@webview/domain/reliableTransientModel';
import type { ReliableToolOutcomeProjectionStatus } from '@webview/domain/reliableConversationProjection';
import {
  reliableKernelDetailDemandSignature,
  reliableKernelDetailKey
} from '@webview/domain/reliableDetailKey';
import { useInteractionStore } from '@webview/stores/useInteractionStore';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { bridge, BridgeMessageType } from '@webview/transport';
import AskUserContent from '@webview/components/askUser/AskUserContent.vue';
import PlanProposalContent from '@webview/components/plan/PlanProposalContent.vue';
import TaskListDisplay from '@webview/components/taskList/TaskListDisplay.vue';
import { resolveToolDisplay } from '../toolDisplay/registry';
import { isRunAgentSpawnArguments } from '../toolDisplay/runAgentToolDisplay';
import { parseShellArgs, parseShellResultOutput } from '../toolDisplay/shellToolModel';
import ContentBlockSection from '../ContentBlockSection.vue';
import CollapsibleContentBlock from '../CollapsibleContentBlock.vue';
import ToolDiffView from '../toolDisplay/ToolDiffView.vue';
import InlineDataPartView from './InlineDataPartView.vue';
import TextPartView from './TextPartView.vue';
import StreamingToolCallPreview from './StreamingToolCallPreview.vue';
import type { ToolDisplayDiff, ToolDisplaySection, ToolHeaderAction } from '../toolDisplay/types';

const props = defineProps<{
  part: FunctionCallPart;
  messageId?: string;
  partIndex?: number;
  /** Function-call ordinal within the containing message; survives transient/durable call-id replacement. */
  toolOrdinal?: number;
  markdown?: boolean;
  streaming?: boolean;
  streamingPhase?: 'waiting' | 'thinking' | 'writing';
  batchIndex?: number;
  batchMode?: ToolSchedulingMode;
  batchState?: 'active' | 'completed' | 'pending';
  batchPosition?: 'single' | 'first' | 'middle' | 'last';
  batchSize?: number;
  activeBatchIndex?: number;
  batchColorIndex?: number;
}>();

const reliableConversation = useReliableConversation();
const interactions = useInteractionStore();
const expanded = ref(false);
const userChangedExpanded = ref(false);
const autoOpenedActionIds = ref<Set<string>>(new Set());
const expandedPlanSectionKeys = ref<Set<string>>(new Set());
const autoApplyCountdown = ref<number | undefined>(undefined);
const cancelFeedback = ref<{
  requestId: string;
  phase: 'submitting' | 'committed' | 'failed';
  message: string;
} | undefined>(undefined);
const interactionResolutionNotice = ref('');
const disposeCancelError = bridge.on(BridgeMessageType.Error, (message) => {
  const current = cancelFeedback.value;
  if (
    !current
    || message.correlationId !== current.requestId
    || message.payload?.requestType !== BridgeMessageType.ToolExecutionCancel
  ) return;
  clearCancelProjectionTimer();
  cancelFeedback.value = {
    ...current,
    phase: 'failed',
    message: message.payload.message || '中断未能提交，请重试'
  };
});
const observedCancelResult = computed(() => {
  const pending = cancelFeedback.value;
  const callId = toolCall.value?.id;
  return pending && callId ? interactions.resultFor(callId, pending.requestId) : undefined;
});
let autoApplyCountdownTimer: ReturnType<typeof setInterval> | undefined;
let cancelProjectionTimer: ReturnType<typeof setTimeout> | undefined;
const CANCEL_PROJECTION_DEADLINE_MS = 30_000;
const toolCall = computed<ToolCallRecord | undefined>(() => {
  const partId = props.part.id;
  if (!props.messageId) return undefined;
  const calls = reliableConversation.projection.value.toolCallsByMessageId[props.messageId] ?? [];
  const exact = partId
    ? calls.find((call) => call.id === partId || call.functionCallId === partId)
    : undefined;
  if (exact) return exact;
  return calls.find((call) =>
    call.name === props.part.functionCall.name
    && (props.toolOrdinal === undefined || call.schedulingOrdinal === props.toolOrdinal)
  );
});
const toolResult = computed(() => {
  const call = toolCall.value;
  if (!call) return undefined;
  return reliableConversation.projection.value.toolResultByCallId[call.id];
});
const toolResponseParts = computed(() => toolCall.value?.responseParts ?? []);
const toolOutcomeStatus = computed<ReliableToolOutcomeProjectionStatus | undefined>(() => {
  const callId = toolCall.value?.id;
  return callId ? reliableConversation.projection.value.toolOutcomeStatusByCallId[callId] : undefined;
});
const toolEvents = computed<ToolCallEventRecord[]>(() => {
  const callId = toolCall.value?.id;
  if (!callId) return [];
  return reliableConversation.projection.value.toolCallEventsByCallId[callId] ?? [];
});
const transientPreview = computed(() => {
  const partId = props.part.id;
  if (!partId || !props.messageId) return undefined;
  const projection = reliableConversation.projection.value;
  const durableCallId = toolCall.value?.id;
  // 转向边界拆分出的展示条目没有独立的持久化身份；预览与正文详请一律回溯到来源聚合消息，
  // durable ToolCall 的归属仍按拆分条目自身（ToolCallSourceLink 精确解析后的位置）。
  const sourceMessageId = projection.splitSourceMessageIdByMessageId[props.messageId] ?? props.messageId;
  if (durableCallId) {
    if (projection.interactionByToolCallId[durableCallId]?.status === 'pending') return undefined;
    const exactCall = toolCall.value?.id === partId || toolCall.value?.functionCallId === partId;
    if (exactCall && !shouldKeepTransientToolCallPreview(
      toolCall.value,
      projection.toolOutcomeStatusByCallId[durableCallId]
    )) return undefined;
    const revisionId = projection.messageRevisionIdByMessageId[sourceMessageId];
    const messageDetail = revisionId
      ? reliableConversation.feed.details[reliableKernelDetailKey('message-content', revisionId)]
      : undefined;
    if (
      messageDetail?.status === 'error'
      && messageDetail.nextRetryAt === undefined
      && (messageDetail.retryCount ?? 0) >= 4
    ) return undefined;
  }
  return transientToolCallPreviewForMessage(
    reliableConversation.feed.transientModelRequests,
    Object.values(reliableConversation.feed.records.ModelRequestMessageLink ?? {}),
    reliableConversation.conversationId.value,
    sourceMessageId,
    partId,
    { includeFinal: true }
  );
});
const executionInteraction = computed(() => reliableInteractionForKind('exec_approval'));
const fileChangeInteractionView = computed(() => reliableInteractionForKind('patch_approval'));
const resultReviewInteraction = computed(() => reliableInteractionForKind('result_review'));
const askUserInteractionView = computed(() => reliableInteractionForKind('ask_user'));
const planReviewInteractionView = computed(() => reliableInteractionForKind('plan_review'));
const reliablePlanProposalId = computed(() => {
  const call = toolCall.value;
  return call?.name === SUBMIT_PLAN_TOOL_NAME ? `plan-proposal:${call.id}` : undefined;
});
const fileChangeInteraction = computed(() => fileChangeInteractionView.value?.request);
const finalizing = computed(() => isFinalizingProgress(toolCall.value?.progress));
const displayProgress = computed(() => {
  const progress = toolCall.value?.progress;
  if (isInternalApprovalProgress(progress) || isFinalizingProgress(progress)) return undefined;
  return progress;
});
const toolDisplay = computed(() => resolveToolDisplay({
  toolName: props.part.functionCall.name,
  args: props.part.functionCall.args,
  result: toolResult.value,
  progress: displayProgress.value,
  events: toolEvents.value,
  toolCall: toolCall.value,
  messages: reliableConversation.projection.value.messages,
  toolCalls: reliableConversation.projection.value.toolCalls,
  checkpoints: [],
  checkpointTimelineAnchors: [],
  shadowRepositories: [],
  currentConversationId: reliableConversation.conversationId.value,
  childConversationId: toolCall.value
    ? reliableConversation.projection.value.childConversationIdByToolCallId[toolCall.value.id]
    : undefined,
  planProposalId: reliablePlanProposalId.value,
  stringifyValue
}));
const reliableFileDiff = computed<ToolDisplayDiff | undefined>(() => {
  const callId = toolCall.value?.id;
  if (!callId) return undefined;
  const projection = reliableConversation.projection.value.fileDiffByToolCallId[callId];
  if (!projection) return undefined;
  return {
    files: projection.files.map((file) => ({
      path: file.path,
      action: file.action,
      added: file.added,
      removed: file.removed,
      truncated: file.truncated,
      text: file.text
    }))
  };
});
const inputSections = computed(() => toolDisplay.value.inputSections);
const outputSections = computed(() => {
  const sections = [...toolDisplay.value.outputSections];
  if (reliableFileDiff.value && !sections.some((section) => section.diff)) {
    sections.push({ kind: 'output', title: 'Diff 预览', diff: reliableFileDiff.value });
  }
  return sections;
});
const toolIcon = computed(() => toolDisplay.value.headerIcon ?? IconTool);
const retryableDetailTargets = computed(() => {
  const callId = toolCall.value?.id;
  if (!callId) return [];
  return expandedDetailTargets(callId).filter(({ kind, recordId }) => {
    const detail = reliableConversation.feed.details[reliableKernelDetailKey(kind, recordId)];
    return detail?.status === 'error' && detail.terminalError !== true;
  });
});
const headerActions = computed<ToolHeaderAction[]>(() => {
  const call = toolCall.value;
  const actions: ToolHeaderAction[] = (
    call
    && reliableConversation.projection.value.fileChangeSetIdByToolCallId[call.id]
    && reliableFileDiff.value
  )
    ? [{
        id: `open-reliable-diff-${call.id}`,
        label: '查看差异',
        title: '使用执行记录中的修改前后内容查看差异，不依赖工作区当前文件',
        icon: IconFileDiff,
        disabled: false,
        invoke: () => {
          bridge.request(BridgeMessageType.ToolDiffOpen, {
            toolCallId: call.id,
            ...(reliableConversation.conversationId.value
              ? { conversationId: reliableConversation.conversationId.value }
              : {})
          });
        }
      }]
    : [...toolDisplay.value.headerActions];
  if (call && retryableDetailTargets.value.length > 0) {
    actions.push({
      id: `retry-reliable-details-${call.id}`,
      label: '重试详情',
      title: '立即重新读取参数、结果或文件差异详情',
      icon: IconRefresh,
      disabled: false,
      invoke: retryExpandedDetailErrors
    });
  }
  return actions;
});
const headerPreview = computed(() => toolDisplay.value.headerPreview);
const hasArgs = computed(() => inputSections.value.length > 0);
const hasOutput = computed(() => outputSections.value.length > 0);
const executionApproved = computed(() => isExecutionApprovedProgress(toolCall.value?.progress));
const executionApprovalPending = computed(() => toolCall.value?.status === 'awaiting_approval' && executionApproved.value);
const needsExecutionDecision = computed(() => executionInteraction.value?.request.state === 'pending');
const needsChangeApplyDecision = computed(() => fileChangeInteractionView.value?.request.state === 'pending');
const needsResultSubmitDecision = computed(() => resultReviewInteraction.value?.request.state === 'pending');
const settledControlInteractionAwaitingOutcome = computed(() => {
  const status = toolCall.value?.status;
  if (!status || !['queued', 'awaiting_approval', 'awaiting_change_apply', 'awaiting_result_submit'].includes(status)) {
    return false;
  }
  return [executionInteraction.value, fileChangeInteractionView.value, resultReviewInteraction.value]
    .some((target) => !!target && target.request.state !== 'pending');
});
const interactionDecisionPending = computed(() => [executionInteraction.value, fileChangeInteractionView.value, resultReviewInteraction.value]
  .some((target) => !!target && interactions.isPending(target.request.id)));
const interactionOutboxIssue = computed(() => [
  executionInteraction.value,
  fileChangeInteractionView.value,
  resultReviewInteraction.value
].flatMap((target) => target ? [interactions.issueFor(target.request.id)] : [])
  .find((message): message is string => Boolean(message)));
const interactionResolutionMessage = computed(() =>
  interactionResolutionNotice.value || interactionOutboxIssue.value
);
const hasMandatoryInteraction = computed(() => Boolean(
  askUserInteractionView.value?.request.state === 'pending'
  || planReviewInteractionView.value?.request.state === 'pending'
));
const terminalResultDetailUnavailable = computed(() => {
  const call = toolCall.value;
  if (!call || !['success', 'warning', 'error'].includes(call.status)) return false;
  const key = reliableKernelDetailKey('tool-result-content', call.id);
  return reliableConversation.feed.details[key]?.status !== 'ready';
});
const expandedDetailDemandSignature = computed(() => {
  const call = toolCall.value;
  const hydrate = expanded.value || hasMandatoryInteraction.value;
  const targets = call && hydrate
    ? expandedDetailTargets(call.id).map(({ kind, recordId }) => {
        const key = reliableKernelDetailKey(kind, recordId);
        return { kind, recordId, status: reliableConversation.feed.details[key]?.status };
      })
    : undefined;
  return reliableKernelDetailDemandSignature({
    hydrate,
    callId: call?.id,
    updatedAt: call?.updatedAt,
    targets
  });
});
const defaultAutoExpandTool = computed(() => [
  ASK_USER_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  'write',
  'edit'
].includes(props.part.functionCall.name));
const hasDetails = computed(() => hasArgs.value
  || hasOutput.value
  || toolResponseParts.value.length > 0
  || terminalResultDetailUnavailable.value
  || Boolean(toolCall.value?.error)
  || executionApprovalPending.value
  || hasMandatoryInteraction.value);
const autoExpandDetails = computed(() => hasMandatoryInteraction.value
  || toolCall.value?.display?.autoExpand === true
  || (toolCall.value?.display?.autoExpand === undefined && defaultAutoExpandTool.value));
const autoOpenDiffPreview = computed(() => toolCall.value?.display?.autoOpenDiffPreview === true);
const autoApplyChange = computed(() => {
  const policy = fileChangeInteraction.value?.policySnapshot;
  return policy?.autoDecision === 'accept' && (policy.mode === 'auto_at' || policy.mode === 'auto_immediate');
});
const autoApplyDelaySeconds = computed(() => {
  const request = fileChangeInteraction.value;
  const notBeforeAt = request?.policySnapshot.notBeforeAt;
  if (!request || notBeforeAt === undefined) return 0;
  return Math.max(0, Math.ceil((notBeforeAt - request.createdAt) / 1000));
});
const autoApplyHint = computed(() => {
  if (!needsChangeApplyDecision.value || !autoApplyChange.value) return undefined;
  const remaining = autoApplyCountdown.value ?? autoApplyDelaySeconds.value;
  return remaining <= 0 ? '正在等待系统应用更改' : `${remaining} 秒后自动应用更改`;
});
const commandRuntimeStatus = computed(() => toolCall.value ? shellRuntimeStatusLabel(toolCall.value, toolResult.value) : undefined);
const interactionStatusLabel = computed(() => {
  if (needsChangeApplyDecision.value) return '等待批准应用更改';
  if (needsExecutionDecision.value) return '等待批准执行';
  if (needsResultSubmitDecision.value) return '等待确认是否把结果发送给 LLM';
  if (settledControlInteractionAwaitingOutcome.value) return '决定已提交，正在完成处理';
  return undefined;
});
const statusLabel = computed(() => cancelFeedback.value?.message
  ?? (finalizing.value ? '工具已完成，正在提交结果' : undefined)
  ?? commandRuntimeStatus.value?.label
  ?? interactionStatusLabel.value
  ?? (toolCall.value
    ? labelForToolCall(toolCall.value, toolResult.value, toolOutcomeStatus.value)
    : props.streaming ? '正在生成工具调用' : '工具状态不完整'));
// 可中断：正在推进（排队/执行/应用更改）或已批准待执行；等待用户决策的状态各有专用按钮，不重复给中断入口。
// 注意：命令工具转后台后是终态 success（已把“成功”返回给 LLM），不再算可中断——后台命令的终止在后台命令面板里做。
const canCancel = computed(() => {
  const call = toolCall.value;
  if (!call || finalizing.value) return false;
  switch (call.status) {
    case 'queued':
    case 'awaiting_user_input':
    case 'awaiting_child':
    case 'executing':
    case 'applying_change':
      return true;
    case 'awaiting_approval':
      return isExecutionApprovedProgress(call.progress);
    default:
      return false;
  }
});
const statusTitle = computed(() => {
  if (!toolCall.value) {
    return props.streaming
      ? 'LLM 正在生成工具调用'
      : '工具调用信息尚未同步完整';
  }
  if (toolOutcomeStatus.value === 'missing') return '工具结果尚未同步完整';
  if (finalizing.value) return '工具已执行，正在保存结果';
  const runtimeStatus = commandRuntimeStatus.value?.status;
  return runtimeStatus ? '工具状态：' + statusLabel.value + ' · 命令 ' + runtimeStatus : '工具状态：' + statusLabel.value;
});
const durationLabel = computed(() => {
  const duration = toolCall.value?.durationMs;
  if (duration === undefined) return undefined;
  return duration < 1000 ? `${Math.round(duration)} 毫秒` : `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} 秒`;
});
const summaryLabel = computed(() => toolCall.value?.summary?.trim() || fallbackToolSummary(props.part.functionCall.name, props.part.functionCall.args));
const inlineProgressLabel = computed(() => toolCall.value?.error ? undefined : boundedInlineValue(displayProgress.value));
const inlineErrorLabel = computed(() => boundedInlineValue(toolCall.value?.error));
const summaryDisplay = computed(() => {
  const summary = summaryLabel.value;
  if (!summary) return undefined;

  const lineRangeMatch = summary.match(/^(.*?)(\[L\d+(?:-\d*)?\])$/);
  return lineRangeMatch
    ? { main: lineRangeMatch[1] ?? '', suffix: lineRangeMatch[2] }
    : { main: summary };
});
const commandAccessLabel = computed(() => {
  if (!isCommandTool(props.part.functionCall.name)) return undefined;
  const args = parseShellArgs(props.part.functionCall.args);
  return args.readonly?.trim().toLowerCase() === 'true' ? '只读' : '读写';
});
const commandForegroundWaitLabel = computed(() => {
  if (!isCommandTool(props.part.functionCall.name)) return undefined;
  const args = parseShellArgs(props.part.functionCall.args);
  return formatShellForegroundWaitLabel(args.foregroundWaitMs);
});
const commandSummaryPrefix = computed(() => {
  const labels = [commandAccessLabel.value, commandForegroundWaitLabel.value].filter((label): label is string => Boolean(label));
  if (labels.length === 0) return undefined;
  const prefix = labels.join(' · ');
  return summaryDisplay.value ? `${prefix} ·` : prefix;
});
const hasCommandSummaryMeta = computed(() => Boolean(commandAccessLabel.value || commandForegroundWaitLabel.value));
const summaryTitle = computed(() => [commandAccessLabel.value, commandForegroundWaitLabel.value, summaryLabel.value].filter(Boolean).join(' · ') || undefined);
const streamingPreviewMaxBodyHeight = computed(() => {
  const size = Math.max(1, props.batchSize ?? 1);
  if (props.batchMode !== 'parallel' || size === 1) return 168;
  return Math.max(32, Math.min(96, Math.floor(192 / size)));
});
const hasBatchMeta = computed(() => props.batchIndex !== undefined && props.batchMode !== undefined && props.batchState !== undefined);
const batchModeLabel = computed(() => props.batchMode === 'parallel' ? '并行执行' : '依次执行');
const batchStateLabel = computed(() => {
  switch (props.batchState) {
    case 'active': return '当前执行';
    case 'completed': return '已完成';
    case 'pending': return '等待中';
    default: return '';
  }
});
const batchTitle = computed(() => {
  if (!hasBatchMeta.value) return undefined;
  const active = props.activeBatchIndex ? `当前执行组：${props.activeBatchIndex}` : '当前执行组：无';
  return `执行组 ${props.batchIndex} · ${batchModeLabel.value} · ${batchStateLabel.value} · ${active}`;
});
const toggleLabel = computed(() => {
  if (!hasDetails.value) return `工具调用 ${props.part.functionCall.name}`;
  return expanded.value ? '收起工具调用内容' : '展开工具调用内容';
});

watch(autoExpandDetails, (autoExpand) => {
  if (autoExpand && !userChangedExpanded.value) expanded.value = true;
}, { immediate: true });

watch(() => toolCall.value?.id, () => {
  userChangedExpanded.value = false;
  expanded.value = autoExpandDetails.value;
  autoOpenedActionIds.value = new Set();
  clearAutoApplyTimers();
});

watch(
  () => `${autoOpenDiffPreview.value}:${headerActions.value.map((action) => `${action.id}:${action.disabled === true ? 'disabled' : 'enabled'}`).join('|')}`,
  () => {
    if (!autoOpenDiffPreview.value) return;
    const action = headerActions.value.find((item) =>
      (item.id.startsWith('open-live-diff-') || item.id.startsWith('open-reliable-diff-'))
      && !item.disabled
    );
    if (!action || autoOpenedActionIds.value.has(action.id)) return;
    autoOpenedActionIds.value.add(action.id);
    action.invoke();
  },
  { immediate: true, flush: 'post' }
);

watch(
  expandedDetailDemandSignature,
  () => {
    const call = toolCall.value;
    if (!call || (!expanded.value && !hasMandatoryInteraction.value)) return;
    reliableConversation.ensureDetails({
      toolCallIds: [call.id],
      priority: hasMandatoryInteraction.value ? 'critical' : 'expanded'
    });
  },
  { immediate: true }
);

watch(
  () => `${fileChangeInteraction.value?.id ?? ''}:${fileChangeInteraction.value?.revision ?? 0}:${fileChangeInteraction.value?.state ?? ''}:${fileChangeInteraction.value?.updatedAt ?? 0}:${fileChangeInteraction.value?.policySnapshot.notBeforeAt ?? 0}`,
  scheduleAutoApplyCountdown,
  { immediate: true }
);

watch(observedCancelResult, (result) => {
  if (result) applyInteractionFeedback(result.payload);
});

onBeforeUnmount(() => {
  disposeCancelError();
  clearAutoApplyTimers();
  clearCancelProjectionTimer();
});

watch(() => toolCall.value?.id, () => {
  expandedPlanSectionKeys.value = new Set();
  clearCancelProjectionTimer();
  cancelFeedback.value = undefined;
  interactionResolutionNotice.value = '';
});

watch(() => toolCall.value?.status, (status) => {
  if (status === 'success' || status === 'warning' || status === 'error') {
    clearCancelProjectionTimer();
    cancelFeedback.value = undefined;
    interactionResolutionNotice.value = '';
  }
});

function isCommandTool(toolName: string): boolean {
  return toolName === 'shell' || toolName === 'bash';
}

function formatShellForegroundWaitLabel(foregroundWaitMs: number | undefined): string | undefined {
  if (typeof foregroundWaitMs !== 'number' || !Number.isFinite(foregroundWaitMs)) return undefined;
  if (foregroundWaitMs <= 0) return '立即后台';
  return `前台等待 ${formatSeconds(foregroundWaitMs / 1000)}秒`;
}

function formatSeconds(seconds: number): string {
  if (Number.isInteger(seconds)) return String(seconds);
  const fractionDigits = seconds < 10 ? 2 : 1;
  return seconds.toFixed(fractionDigits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function environmentDisplayRef(value: unknown): string | undefined {
  const text = boundedInlineValue(value);
  if (!text) return undefined;
  return text.startsWith('work-env-') ? '工作环境' : text;
}

function fallbackToolSummary(toolName: string, args: unknown): string | undefined {
  const source = isRecord(args) ? args : undefined;
  if (!source) return undefined;
  if (toolName === SWITCH_WORK_ENVIRONMENT_TOOL_NAME) {
    const workEnvironmentRef = boundedInlineValue(source.workEnvironmentRef);
    return workEnvironmentRef ? `切换工作环境 · ${workEnvironmentRef}` : '切换工作环境';
  }
  if (toolName === SKILLS_TOOL_NAME) {
    const name = boundedInlineValue(source.name);
    if (!name) return undefined;
    const rawSource = typeof source.source === 'string'
      ? source.source.trim().replace(/^\./, '').toLowerCase()
      : '';
    const skillSource = ['agents', 'claude', 'global'].includes(rawSource) ? rawSource : '';
    return `载入技能 · ${skillSource ? `${skillSource}:` : ''}${name}`;
  }
  if (toolName === SUBMIT_AGENT_ANSWER_TOOL_NAME) {
    const title = boundedInlineValue(source.title);
    return title ? `提交 Agent 回答 · ${title}` : '提交 Agent 回答';
  }
  if (toolName === READ_AGENT_ANSWER_TOOL_NAME) {
    const childRef = boundedInlineValue(source.childRef);
    return childRef ? `读取 Agent 回答 · ${childRef}` : '读取 Agent 回答';
  }
  if (toolName === 'run_agent') {
    const operation = source.operation;
    const answerBridgeId = boundedInlineValue(source.answerBridgeId);
    if (operation === 'list') return '列出已有子 Agent';
    if (operation === 'read') return answerBridgeId ? `读取子 Agent · ${answerBridgeId}` : '读取子 Agent';
    if (operation === 'wait') return '等待子 Agent 回答';
    if (operation === 'send') return answerBridgeId ? `继续子 Agent · ${answerBridgeId}` : '继续子 Agent';
    if (operation === 'interrupt_subtree') return '终止子 Agent 子树';
    if (operation !== 'spawn') return '子 Agent 操作';
    const agent = isRecord(source.agent) ? source.agent : undefined;
    const agentType = boundedInlineValue(agent?.type) ?? 'worker';
    const taskName = boundedInlineValue(source.taskName);
    return taskName ? `启动 ${agentType} · ${taskName}` : `启动 ${agentType}`;
  }
  if (toolName === TRANSFER_TOOL_NAME) {
    const transfers = Array.isArray(source.transfers) ? source.transfers.filter(isRecord) : [];
    const first = transfers[0];
    if (!first) return '传输文件';
    const from = [environmentDisplayRef(first.fromEnvironment), boundedInlineValue(first.fromPath)].filter(Boolean).join(':');
    const to = [environmentDisplayRef(first.toEnvironment), boundedInlineValue(first.toPath)].filter(Boolean).join(':');
    const suffix = transfers.length > 1 ? ` +${transfers.length - 1}` : '';
    return boundedInlineValue(`${from} → ${to}${suffix}`);
  }
  if (toolName === DELETE_TOOL_NAME && Array.isArray(source.paths)) {
    const paths = source.paths.map(boundedInlineValue).filter((path): path is string => Boolean(path));
    if (paths.length > 0) return `delete ${paths[0]}${paths.length > 1 ? ` +${paths.length - 1}` : ''}`;
  }
  if (toolName === TASK_LIST_TOOL_NAME && Array.isArray(source.items)) {
    const items = source.items.filter(isRecord);
    const mode = source.mode === 'rewrite' ? '重写任务清单' : '更新任务清单';
    const active = items.find((item) => item.status === 'in_progress' && item.delete !== true);
    const activeTitle = boundedInlineValue(active?.title);
    return `${mode} · ${items.length} 项${activeTitle ? ` · 当前：${activeTitle}` : ''}`;
  }
  for (const key of ['explanation', 'summary', 'question', 'title', 'path', 'query', 'skill', 'url', 'instructions', 'researchId']) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return boundedInlineValue(value);
  }
  if (Array.isArray(source.urls)) {
    const urls = source.urls.map(boundedInlineValue).filter((url): url is string => Boolean(url));
    if (urls.length > 0) return `${urls[0]}${urls.length > 1 ? ` +${urls.length - 1}` : ''}`;
  }
  if ((toolName === 'bash' || toolName === 'shell') && typeof source.command === 'string') {
    return boundedInlineValue(source.command);
  }
  if (toolName === SUBMIT_PLAN_TOOL_NAME && typeof source.plan === 'string') return '提交 Plan 等待用户审批';
  if (toolName === TASK_LIST_TOOL_NAME) return '更新任务清单';
  return undefined;
}

function boundedInlineValue(value: unknown): string | undefined {
  let result: string | undefined;
  if (typeof value === 'string') result = value;
  else if (isRecord(value)) {
    for (const key of ['message', 'label', 'status', 'phase', 'current']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        result = candidate;
        break;
      }
    }
  }
  const normalized = result?.trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  return normalized.length > 140 ? `${normalized.slice(0, 137)}…` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function reliableInteractionForKind(kind: DurableInteractionRequestKind): InteractionView | undefined {
  const callId = toolCall.value?.id;
  if (!callId) return undefined;
  const interaction = reliableConversation.projection.value.interactionByToolCallId[callId];
  if (!interaction) return undefined;
  return interactionViewFromReliableRuntime({
    interaction,
    conversationId: reliableConversation.conversationId.value,
    toolCallId: callId,
    expectedKind: kind
  });
}

function resolveToolInteraction(kind: DurableInteractionRequestKind, decision: 'accept' | 'reject'): void {
  const target: InteractionView | undefined = kind === 'exec_approval'
    ? executionInteraction.value
    : kind === 'patch_approval'
      ? fileChangeInteractionView.value
      : kind === 'result_review'
        ? resultReviewInteraction.value
        : undefined;
  if (!target || target.request.state !== 'pending') return;
  if (kind === 'patch_approval') clearAutoApplyTimers();
  const result = interactions.resolve(
    target,
    decision,
    decision === 'reject' ? { reason: rejectionReason(kind) } : {}
  );
  interactionResolutionNotice.value = result.message ?? '';
}

function cancelToolExecution(): void {
  const call = toolCall.value;
  if (!call || cancelFeedback.value?.phase === 'committed') return;
  const requestId = bridge.request(BridgeMessageType.ToolExecutionCancel, {
    toolCallId: call.id,
    conversationId: reliableConversation.conversationId.value
  });
  clearCancelProjectionTimer();
  cancelFeedback.value = { requestId, phase: 'submitting', message: '正在提交中断' };
}

function rejectionReason(kind: DurableInteractionRequestKind): string {
  if (kind === 'exec_approval') return '用户拒绝执行工具。';
  if (kind === 'patch_approval') return '用户拒绝应用更改。';
  return '用户拒绝将工具结果发送给 LLM。';
}

function applyInteractionFeedback(result: InteractionResultPayload): void {
  const current = cancelFeedback.value;
  if (!current) return;
  switch (result.status) {
    case 'committed':
    case 'already_applied':
      cancelFeedback.value = { ...current, phase: 'committed', message: '中断已提交，等待状态同步' };
      requestCancelProjectionRecovery(result.conversationId);
      return;
    case 'already_satisfied':
    case 'already_resolved':
      cancelFeedback.value = { ...current, phase: 'committed', message: '目标已结束，正在同步状态' };
      requestCancelProjectionRecovery(result.conversationId);
      return;
    case 'stale':
      clearCancelProjectionTimer();
      cancelFeedback.value = { ...current, phase: 'failed', message: '目标状态已变化，已请求重新同步' };
      requestConversationResync(result.conversationId);
      return;
    case 'rejected':
    case 'blocked':
    case 'outcome_unknown':
      clearCancelProjectionTimer();
      cancelFeedback.value = { ...current, phase: 'failed', message: result.reason?.trim() || '中断未能完成，请重试' };
  }
}

function requestCancelProjectionRecovery(conversationId: string): void {
  requestConversationResync(conversationId);
  clearCancelProjectionTimer();
  cancelProjectionTimer = setTimeout(() => {
    cancelProjectionTimer = undefined;
    const current = cancelFeedback.value;
    if (!current || current.phase !== 'committed') return;
    cancelFeedback.value = {
      ...current,
      phase: 'failed',
      message: '中断已提交，但页面状态尚未同步；请重试同步或重载窗口'
    };
    requestConversationResync(conversationId);
  }, CANCEL_PROJECTION_DEADLINE_MS);
}

function requestConversationResync(conversationId: string): void {
  bridge.request(BridgeMessageType.ClientResync, { conversationId });
}

function clearCancelProjectionTimer(): void {
  if (cancelProjectionTimer !== undefined) clearTimeout(cancelProjectionTimer);
  cancelProjectionTimer = undefined;
}

function scheduleAutoApplyCountdown(): void {
  clearAutoApplyTimers();
  const request = fileChangeInteraction.value;
  const notBeforeAt = request?.policySnapshot.notBeforeAt;
  if (!request || request.state !== 'pending' || !autoApplyChange.value || notBeforeAt === undefined) return;
  const update = () => {
    autoApplyCountdown.value = Math.max(0, Math.ceil((notBeforeAt - Date.now()) / 1000));
  };
  update();
  if (autoApplyCountdown.value === 0) return;
  autoApplyCountdownTimer = setInterval(() => {
    update();
    if (autoApplyCountdown.value === 0 && autoApplyCountdownTimer) {
      clearInterval(autoApplyCountdownTimer);
      autoApplyCountdownTimer = undefined;
    }
  }, 250);
}

function clearAutoApplyTimers(): void {
  if (autoApplyCountdownTimer) clearInterval(autoApplyCountdownTimer);
  autoApplyCountdownTimer = undefined;
  autoApplyCountdown.value = undefined;
}

function setExpanded(value: boolean): void {
  userChangedExpanded.value = true;
  expanded.value = value;
  if (value) retryExpandedDetailErrors();
}

function fileDiffDetailTargets(callId: string): Array<{
  kind: 'file-change-diff';
  recordId: string;
}> {
  return (reliableConversation.projection.value.fileDiffMemberIdsByToolCallId[callId] ?? [])
    .map((recordId) => ({ kind: 'file-change-diff', recordId }));
}

function expandedDetailTargets(callId: string): Array<{
  kind: ReliableKernelClientDetailKind;
  recordId: string;
}> {
  const projection = reliableConversation.projection.value;
  const targets: Array<{ kind: ReliableKernelClientDetailKind; recordId: string }> = [
    { kind: 'tool-arguments-content', recordId: callId },
    { kind: 'tool-result-content', recordId: callId },
    ...fileDiffDetailTargets(callId),
    ...(projection.toolEventIdsByCallId[callId] ?? []).map((recordId) => ({
      kind: 'tool-event-content' as const,
      recordId
    }))
  ];
  const promptId = projection.interactionPromptIdByToolCallId[callId];
  if (promptId) targets.push({ kind: 'interaction-prompt', recordId: promptId });
  return targets;
}

function retryExpandedDetailErrors(): void {
  const call = toolCall.value;
  if (!call) return;
  for (const { kind, recordId } of expandedDetailTargets(call.id)) {
    const key = reliableKernelDetailKey(kind, recordId);
    const detail = reliableConversation.feed.details[key];
    if (detail?.status !== 'error' || detail.terminalError) continue;
    reliableConversation.feed.retryDetail(kind, recordId, { priority: 'expanded' });
  }
}

function planSectionKey(section: ToolDisplaySection): string | undefined {
  if (!section.planProposal) return undefined;
  return section.planProposal.toolCall?.id
    ?? section.planProposal.proposalId
    ?? `${section.title}:${section.planProposal.request.plan}`;
}

function isPlanSectionExpanded(section: ToolDisplaySection): boolean {
  const key = planSectionKey(section);
  return !!key && expandedPlanSectionKeys.value.has(key);
}

function updatePlanSectionExpanded(section: ToolDisplaySection, value: boolean): void {
  const key = planSectionKey(section);
  if (!key) return;
  const next = new Set(expandedPlanSectionKeys.value);
  if (value) next.add(key);
  else next.delete(key);
  expandedPlanSectionKeys.value = next;
}

function invokeHeaderAction(action: ToolHeaderAction): void {
  if (action.disabled) return;
  action.invoke();
}

function shellRuntimeStatusLabel(call: ToolCallRecord, result: unknown): { label: string; status: string } | undefined {
  if (!isCommandTool(call.name)) return undefined;
  const output = parseShellResultOutput(result);
  if (!output) return undefined;
  if (output.running === true || output.status === 'running') return { label: '后台运行中', status: 'running' };
  if (output.killed === true || output.status === 'killed') return { label: '已终止', status: 'killed' };
  if (typeof output.exitCode === 'number' && output.exitCode !== 0) return { label: '异常终止', status: output.status ?? 'exited' };
  if (output.status === 'exited') return { label: '已退出', status: 'exited' };
  return undefined;
}
function labelForToolCall(
  call: ToolCallRecord,
  result: unknown,
  outcomeStatus: ReliableToolOutcomeProjectionStatus | undefined
): string {
  if (call.status === 'queued' && isRunAgentStartupCall(call)) {
    return `正在等待启动子 Agent（本轮最多同时启动 ${MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN} 个）`;
  }
  if (call.status === 'awaiting_approval' && isExecutionApprovedProgress(call.progress)) {
    return isWaitingForPreviousProgress(call.progress) ? '已批准，等待前面的工具完成' : '已批准，等待执行';
  }
  if (call.name === SUBMIT_PLAN_TOOL_NAME) {
    const planOutput = submitPlanOutputFromResult(result);
    if (call.status === 'awaiting_user_input') return '等待审批 Plan';
    if (planOutput?.status === 'approved') return 'Plan 已批准';
    if (planOutput?.status === 'change_requested') return '要求修改 Plan';
    if (planOutput?.status === 'rejected') return 'Plan 已拒绝';
    if (planOutput?.status === 'cancelled') return 'Plan 已取消';
  }
  if (call.status === 'error' && isInterruptedResult(result)) {
    return '已被用户中断';
  }
  if (call.status === 'error' && isDeniedResult(result)) {
    return deniedStatusLabel(result, call.error);
  }
  if (outcomeStatus === 'missing') return '工具状态不完整';
  if (outcomeStatus === 'outcome_unknown') return '执行结果未知';
  if (outcomeStatus === 'conflict') return '工具结果冲突';
  if (outcomeStatus === 'cancelled') return '工具执行已取消';
  if (outcomeStatus === 'partial') return '工具部分完成';
  if (call.status === 'success' && call.name === 'run_agent' && isBackgroundAgentRunResult(result)) return '子 Agent 已在后台运行';
  if (call.status === 'success' && isAsyncAgentRunResult(result)) return '子 Agent 已启动';
  if (call.status === 'warning' && isPartialEditResult(result)) return '部分成功';
  return labelForStatus(call.status);
}

function labelForStatus(status: ToolCallStatus): string {
  const labels: Record<ToolCallStatus, string> = {
    streaming: '正在生成工具调用',
    queued: '等待执行',
    awaiting_approval: '等待批准执行',
    awaiting_user_input: '等待用户回答',
    awaiting_child: '等待子 Agent 回答',
    executing: '工具执行中',
    awaiting_change_apply: '等待应用更改',
    applying_change: '正在应用更改',
    change_applied: '更改已应用',
    change_rejected: '更改已拒绝',
    awaiting_result_submit: '等待确认是否把结果发送给 LLM',
    success: '工具执行成功',
    warning: '执行完成（有警告）',
    error: '工具执行失败'
  };
  return labels[status];
}

function isRunAgentStartupCall(call: ToolCallRecord): boolean {
  return call.name === 'run_agent' && isRunAgentSpawnArguments(call.args);
}

function isDeniedResult(result: unknown): boolean {
  return isRecord(result) && result.denied === true;
}

function isInterruptedResult(result: unknown): boolean {
  const output = toolOutput(result);
  return (isRecord(result) && result.interrupted === true) || (isRecord(output) && output.interrupted === true);
}

function deniedStatusLabel(result: unknown, error: string | undefined): string {
  const reason = isRecord(result) && typeof result.reason === 'string' ? result.reason : error ?? '';
  if (reason.includes('更改')) return '已拒绝更改';
  if (reason.includes('结果') || reason.includes('使用')) return '已拒绝结果';
  if (reason.includes('执行')) return '已拒绝执行';
  return '已拒绝工具调用';
}

function isBackgroundAgentRunResult(result: unknown): boolean {
  const output = toolOutput(result);
  if (!isRecord(output)) return false;
  return (output.state === 'active' || output.state === 'starting')
    && typeof output.childExecutionId === 'string'
    && typeof output.answerBridgeId === 'string';
}

function isAsyncAgentRunResult(result: unknown): boolean {
  return isRecord(result) && result.status === 'async_launched';
}

function isPartialEditResult(result: unknown): boolean {
  const output = toolOutput(result);
  if (!isRecord(output) || output.kind !== 'file_edit.result') return false;
  return typeof output.failed === 'number' && output.failed > 0 && typeof output.applied === 'number' && output.applied > 0;
}

function toolOutput(result: unknown): unknown {
  const record = isRecord(result) ? result : undefined;
  return record && 'output' in record ? record.output : result;
}

function isExecutionApprovedProgress(progress: unknown): boolean {
  return isRecord(progress) && progress.executionApproved === true;
}

function isWaitingForPreviousProgress(progress: unknown): boolean {
  return isRecord(progress) && progress.waitingForPrevious === true;
}

function isInternalApprovalProgress(progress: unknown): boolean {
  if (!isRecord(progress) || progress.executionApproved !== true) return false;
  return Object.keys(progress).every((key) => key === 'executionApproved' || key === 'waitingForPrevious');
}

function isFinalizingProgress(progress: unknown): boolean {
  return isRecord(progress) && progress.phase === 'finalizing';
}
</script>

<template>
  <StreamingToolCallPreview
    v-if="transientPreview"
    :preview="transientPreview"
    :active="props.streaming === true"
    :max-body-height="streamingPreviewMaxBodyHeight"
    :compact="props.batchMode === 'parallel' && (props.batchSize ?? 1) > 1"
  />
  <CollapsibleContentBlock
    v-else
    :expanded="expanded"
    @update:expanded="setExpanded"
    class="tool-call-card"
    :class="[
      toolCall ? `status-${toolCall.status}` : props.streaming ? 'status-streaming' : 'status-incomplete',
      hasBatchMeta ? `batch-${batchState}` : undefined,
      hasBatchMeta ? `batch-pos-${batchPosition}` : undefined,
      hasBatchMeta ? `batch-mode-${batchMode}` : undefined,
      hasBatchMeta ? `batch-color-${batchColorIndex ?? 1}` : undefined
    ]"
    kind="input"
    :collapsible="hasDetails"
    lazy
    :aria-label="toggleLabel"
    :title="batchTitle"
  >
    <template #icon>
      <component :is="toolIcon" :stroke="2" aria-hidden="true" />
    </template>
    <template #summary>
      <span class="part-card-name" :class="{ 'has-summary': summaryLabel || hasCommandSummaryMeta }">{{ part.functionCall.name }}</span>
      <span v-if="headerPreview" class="part-card-summary is-preview" :title="headerPreview.filePath">
        <span class="part-card-summary-main">{{ headerPreview.fileName }}</span>
        <span
          v-if="(headerPreview.added ?? 0) > 0 || (headerPreview.removed ?? 0) > 0"
          class="part-card-diff-stats"
        >
          <span v-if="(headerPreview.added ?? 0) > 0" class="diff-stat-add">+{{ headerPreview.added }}</span>
          <span v-if="(headerPreview.removed ?? 0) > 0" class="diff-stat-del">-{{ headerPreview.removed }}</span>
        </span>
      </span>
      <span v-else-if="summaryDisplay || hasCommandSummaryMeta" class="part-card-summary" :title="summaryTitle">
        <span v-if="commandSummaryPrefix" class="part-card-summary-prefix">{{ commandSummaryPrefix }}</span>
        <span v-if="summaryDisplay" class="part-card-summary-main">{{ summaryDisplay.main }}</span>
        <span v-if="summaryDisplay?.suffix" class="part-card-summary-suffix">{{ summaryDisplay.suffix }}</span>
      </span>
    </template>
    <template #trail>
      <span v-if="inlineProgressLabel" class="part-card-meta part-card-progress" :title="inlineProgressLabel">{{ inlineProgressLabel }}</span>
      <span v-if="inlineErrorLabel" class="part-card-meta part-card-inline-error" :title="toolCall?.error">{{ inlineErrorLabel }}</span>
      <span class="part-card-status" :title="statusTitle">{{ statusLabel }}</span>
      <span v-if="durationLabel" class="part-card-meta">{{ durationLabel }}</span>
    </template>
    <template v-if="headerActions.length > 0 || canCancel" #actions>
      <button
        v-for="action in headerActions"
        :key="action.id"
        type="button"
        class="tool-header-action"
        :title="action.title"
        :aria-label="action.title ?? action.label"
        :disabled="action.disabled"
        @click.stop="invokeHeaderAction(action)"
      >
        <component :is="action.icon" v-if="action.icon" class="tool-header-action-icon" :stroke="2" aria-hidden="true" />
        <span class="tool-header-action-label">{{ action.label }}</span>
      </button>
      <button
        v-if="canCancel"
        type="button"
        class="tool-header-action tool-header-action-cancel"
        title="中断此工具调用"
        aria-label="中断此工具调用"
        :disabled="cancelFeedback?.phase === 'committed'"
        @click.stop="cancelToolExecution"
      >
        <IconPlayerStop class="tool-header-action-icon" stroke="2" aria-hidden="true" />
        <span class="tool-header-action-label">{{ cancelFeedback?.phase === 'submitting' ? '中断中' : cancelFeedback?.phase === 'committed' ? '已提交' : '中断' }}</span>
      </button>
    </template>

    <div class="part-card-details">
      <ContentBlockSection
        v-for="(section, index) in inputSections"
        :key="`input-${index}-${section.title}`"
        :kind="section.kind"
        :title="section.title"
        :text="section.markdown ? undefined : section.text"
        :unbounded="isPlanSectionExpanded(section) || !!section.planProposal"
        :class="{ 'is-plan-proposal-section': !!section.planProposal }"
      >
        <TextPartView v-if="section.markdown && section.text !== undefined" class="tool-display-markdown" :text="section.text" markdown />
        <ToolDiffView v-if="section.diff" :diff="section.diff" />
        <div v-if="section.rows?.length" class="tool-display-rows" :class="`is-${section.rowStyle ?? 'keyValue'}`">
          <template v-for="(row, rowIndex) in section.rows" :key="`${section.title}-${rowIndex}-${row.label}`">
            <span class="tool-display-row-label">{{ row.label }}</span>
            <span class="tool-display-row-value">{{ row.value }}</span>
          </template>
        </div>
        <TaskListDisplay
          v-if="section.taskList"
          class="tool-display-task-list"
          :items="section.taskList.items"
          :show-change="section.taskList.showChange ?? false"
          :empty-text="section.taskList.emptyText"
        />
        <AskUserContent
          v-if="section.askUser"
          class="tool-display-ask-user"
          :request="section.askUser.request"
          :tool-call="section.askUser.toolCall"
          :result="toolResult"
          :interaction-view="askUserInteractionView"
          placement="tool-detail"
        />
        <PlanProposalContent
          v-if="section.planProposal"
          class="tool-display-plan-proposal"
          :request="section.planProposal.request"
          :proposal-id="section.planProposal.proposalId ?? reliablePlanProposalId"
          :tool-call="section.planProposal.toolCall"
          :result="toolResult"
          :interaction-view="planReviewInteractionView"
          @panel-expanded-change="updatePlanSectionExpanded(section, $event)"
        />
      </ContentBlockSection>
      <ContentBlockSection
        v-for="(section, index) in outputSections"
        :key="`output-${index}-${section.title}`"
        :kind="section.kind"
        :title="section.title"
        :text="section.markdown ? undefined : section.text"
        :unbounded="isPlanSectionExpanded(section) || !!section.planProposal"
        :class="{ 'is-plan-proposal-section': !!section.planProposal }"
      >
        <TextPartView v-if="section.markdown && section.text !== undefined" class="tool-display-markdown" :text="section.text" markdown />
        <ToolDiffView v-if="section.diff" :diff="section.diff" />
        <div v-if="section.rows?.length" class="tool-display-rows" :class="`is-${section.rowStyle ?? 'keyValue'}`">
          <template v-for="(row, rowIndex) in section.rows" :key="`${section.title}-${rowIndex}-${row.label}`">
            <span class="tool-display-row-label">{{ row.label }}</span>
            <span class="tool-display-row-value">{{ row.value }}</span>
          </template>
        </div>
        <TaskListDisplay
          v-if="section.taskList"
          class="tool-display-task-list"
          :items="section.taskList.items"
          :show-change="section.taskList.showChange ?? false"
          :empty-text="section.taskList.emptyText"
        />
        <AskUserContent
          v-if="section.askUser"
          class="tool-display-ask-user"
          :request="section.askUser.request"
          :tool-call="section.askUser.toolCall"
          :result="toolResult"
          :interaction-view="askUserInteractionView"
          placement="tool-detail"
        />
        <PlanProposalContent
          v-if="section.planProposal"
          class="tool-display-plan-proposal"
          :request="section.planProposal.request"
          :proposal-id="section.planProposal.proposalId ?? reliablePlanProposalId"
          :tool-call="section.planProposal.toolCall"
          :result="toolResult"
          :interaction-view="planReviewInteractionView"
          @panel-expanded-change="updatePlanSectionExpanded(section, $event)"
        />
      </ContentBlockSection>
      <div v-if="toolResponseParts.length > 0" class="tool-response-attachments" aria-label="工具返回附件">
        <InlineDataPartView
          v-for="(attachment, index) in toolResponseParts"
          :key="`${attachment.inlineData.attachmentId ?? attachment.inlineData.sourcePath ?? attachment.inlineData.name ?? attachment.inlineData.mimeType}-${index}`"
          :part="attachment"
        />
      </div>
      <p v-if="toolCall?.error" class="part-card-error">{{ toolCall.error }}</p>
      <p v-else-if="executionApprovalPending && isWaitingForPreviousProgress(toolCall?.progress)" class="part-card-note">
        已批准执行，前面的工具完成后将按顺序继续。
      </p>
      <p v-else-if="executionApprovalPending" class="part-card-note">
        已批准执行，将在存档点完成后自动继续。
      </p>
    </div>
  </CollapsibleContentBlock>

  <p v-if="interactionResolutionMessage" class="part-card-note tool-interaction-resolution-note" role="status">
    {{ interactionResolutionMessage }}
  </p>

  <div v-if="!transientPreview && needsExecutionDecision" class="tool-decision-actions is-external">
    <button type="button" :disabled="interactionDecisionPending" @click="resolveToolInteraction('exec_approval', 'accept')">批准执行</button>
    <button type="button" class="secondary" :disabled="interactionDecisionPending" @click="resolveToolInteraction('exec_approval', 'reject')">拒绝</button>
  </div>
  <div v-else-if="needsChangeApplyDecision" class="tool-decision-actions is-external">
    <span v-if="autoApplyHint" class="tool-decision-hint">{{ autoApplyHint }}</span>
    <button type="button" :disabled="interactionDecisionPending" @click="resolveToolInteraction('patch_approval', 'accept')">批准并应用更改</button>
    <button type="button" class="secondary" :disabled="interactionDecisionPending" @click="resolveToolInteraction('patch_approval', 'reject')">拒绝更改</button>
  </div>
  <div v-else-if="needsResultSubmitDecision" class="tool-decision-actions is-external">
    <button type="button" :disabled="interactionDecisionPending" @click="resolveToolInteraction('result_review', 'accept')">将结果发送给 LLM</button>
    <button type="button" class="secondary" :disabled="interactionDecisionPending" @click="resolveToolInteraction('result_review', 'reject')">拒绝发送并告知 LLM</button>
  </div>
</template>

<style scoped>
.tool-response-attachments {
  display: grid;
  gap: var(--space-2, 8px);
}

.tool-call-card {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  font-style: normal;
  --tool-batch-color: transparent;
}

.tool-call-card.batch-color-1 { --tool-batch-color: #6a9955; }
.tool-call-card.batch-color-2 { --tool-batch-color: #c5863a; }
.tool-call-card.batch-color-3 { --tool-batch-color: #b5cea8; }
.tool-call-card.batch-color-4 { --tool-batch-color: #ce9178; }
.tool-call-card.batch-color-5 { --tool-batch-color: #4ec9b0; }

.tool-call-card :deep(.lc-collapsible-summary) {
  flex-grow: 1;
  /* 摘要区优先让出空间；工具名自身在内部保持更高优先级。 */
  flex-shrink: 999;
  flex-basis: auto;
  min-width: 0;
}

.tool-call-card.batch-color-1 :deep(.lc-collapsible-summary),
.tool-call-card.batch-color-2 :deep(.lc-collapsible-summary),
.tool-call-card.batch-color-3 :deep(.lc-collapsible-summary),
.tool-call-card.batch-color-4 :deep(.lc-collapsible-summary),
.tool-call-card.batch-color-5 :deep(.lc-collapsible-summary) {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--tool-batch-color) 78%, var(--vscode-editor-background) 22%);
}

.tool-call-card.batch-active :deep(.lc-collapsible-summary) {
  box-shadow: inset 4px 0 0 var(--tool-batch-color);
  border-color: color-mix(in srgb, var(--vscode-panel-border) 62%, var(--tool-batch-color) 38%);
}

.tool-call-card.batch-pending :deep(.lc-collapsible-summary) {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--tool-batch-color) 38%, transparent);
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 62%, var(--vscode-editor-background) 38%);
}

.tool-call-card.batch-completed :deep(.lc-collapsible-summary) {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--tool-batch-color) 52%, transparent);
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 70%, var(--vscode-editor-background) 30%);
}

.tool-call-card.batch-pending :deep(.lc-collapsible-summary:hover),
.tool-call-card.batch-pending :deep(.lc-collapsible-summary:focus-visible),
.tool-call-card.batch-completed :deep(.lc-collapsible-summary:hover),
.tool-call-card.batch-completed :deep(.lc-collapsible-summary:focus-visible) {
  color: var(--vscode-foreground);
}

.part-card-name {
  min-width: 0;
  max-width: 100%;
  flex: 0 0 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: inherit;
}

.part-card-summary {
  display: inline-flex;
  align-items: baseline;
  flex: 1 1 0;
  min-width: 0;
  margin-left: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: inherit;
  font-size: var(--font-size-xs);
  font-weight: 400;
  opacity: 0.86;
}

.part-card-summary-prefix {
  flex: 0 0 auto;
  margin-right: 4px;
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 92%, var(--vscode-foreground) 8%);
  font-weight: 500;
}

.part-card-summary-main {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.part-card-summary-suffix {
  flex: 0 0 auto;
  margin-left: 4px;
  font-style: italic;
  opacity: 0.82;
}

.part-card-summary.is-preview {
  gap: 0;
}

.part-card-diff-stats {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  flex: 0 0 auto;
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  font-size: var(--font-size-xs);
}

.diff-stat-add {
  color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
}

.diff-stat-del {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
}

.tool-call-card :deep(.lc-collapsible-actions) {
  flex: 0 0 auto;
  width: auto;
  min-width: max-content;
  justify-content: center;
}

.tool-call-card :deep(.lc-collapsible-trail) {
  flex: 0 0 auto;
  width: auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.part-card-status,
.part-card-meta {
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.part-card-progress,
.part-card-inline-error {
  min-width: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.part-card-inline-error {
  color: var(--vscode-errorForeground);
}

.part-card-status {
  min-width: max-content;
  overflow: visible;
  text-align: left;
  white-space: nowrap;
}

.part-card-meta {
  min-width: max-content;
  max-width: none;
  justify-self: end;
  overflow: visible;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
}

.tool-header-action {
  width: auto;
  max-width: none;
  min-width: max-content;
  min-height: 22px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}

.tool-header-action:hover,
.tool-header-action:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.tool-header-action:disabled {
  opacity: 0.5;
  cursor: default;
}



.tool-header-action-icon {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
}

.tool-header-action-label {
  flex: 1 1 auto;
  min-width: max-content;
  overflow: visible;
  white-space: nowrap;
}

.tool-display-rows {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: stretch;
  min-width: 0;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.tool-display-row-label,
.tool-display-row-value {
  min-width: 0;
  padding-top: 1px;
  padding-bottom: 1px;
}

.tool-display-row-label {
  padding-right: 8px;
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 82%, transparent);
  text-align: left;
  white-space: nowrap;
  user-select: none;
}

.tool-display-rows.is-lineNumber .tool-display-row-label {
  min-width: 2ch;
  text-align: right;
}

.tool-display-row-value {
  border-left: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 42%, transparent);
  padding-left: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.tool-display-task-list {
  color: var(--vscode-foreground);
}

.is-plan-proposal-section {
  --lc-content-block-section-max-height: min(68vh, 560px);
  --lc-plan-proposal-max-height: min(68vh, 560px);
}

.part-card-details {
  margin: 3px 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tool-decision-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.tool-decision-actions.is-external {
  margin: 4px 0 0 24px;
  padding-left: 0;
}

.tool-decision-hint {
  min-height: 24px;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  display: inline-flex;
  align-items: center;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.tool-decision-actions button {
  min-height: 26px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
}

.tool-decision-actions button:hover,
.tool-decision-actions button:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}


.part-card-error {
  margin: 6px 0 0;
  color: var(--vscode-errorForeground);
}

.part-card-note {
  margin: 0;
  color: var(--vscode-descriptionForeground);
}

.part-card-error:first-child {
  margin-top: 0;
}

.status-success .part-card-status {
  color: var(--vscode-testing-iconPassed, #4caf50);
}

.status-warning .part-card-status,
.status-incomplete .part-card-status {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.status-error .part-card-status {
  color: var(--vscode-errorForeground);
}
</style>
