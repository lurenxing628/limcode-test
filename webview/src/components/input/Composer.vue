<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconFolder, IconHistory, IconListDetails, IconPaperclip, IconPencilExclamation, IconPlayerStop, IconRobot, IconSend2, IconTrash, IconWorld } from '@tabler/icons-vue';
import { workEnvironmentDisplayPath, workEnvironmentSortKey as buildWorkEnvironmentSortKey } from '@shared/workEnvironmentCatalog';
import {
  type AgentRecord,
  type InlineDataPart,
  type LlmProviderConfigRecord,
  type LlmProviderModelRecord,
  type MessageContent,
  type TurnAuthoritySelection,
  type WorkEnvironmentRecord
} from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useConversationUiStore } from '@webview/stores/useConversationUiStore';
import { useSessionStore } from '@webview/stores/useSessionStore';
import { DEFAULT_WORKFLOW_OPTION_ID, useWorkflowStore } from '@webview/stores/useWorkflowStore';
import { useWorkEnvironmentStore } from '@webview/stores/useWorkEnvironmentStore';
import { useAgentStore } from '@webview/stores/useAgentStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import RichContentEditor from '@webview/components/content/RichContentEditor.vue';
import AskUserTopPanel from '@webview/components/askUser/AskUserTopPanel.vue';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import SettingsSelectableList, { type SettingsSelectableListItem } from '@webview/components/settings/global/SettingsSelectableList.vue';
import BackgroundCommandPanel from '@webview/components/input/BackgroundCommandPanel.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import SummaryRebuildConfirm from '@webview/components/input/SummaryRebuildConfirm.vue';
import { summaryRebuildTooltipRows } from '@webview/components/input/summaryRebuildPreview';
import { useSummaryRebuildPreview } from '@webview/composables/useSummaryRebuildPreview';
import ReliableContextStatus from '@webview/components/conversation/ReliableContextStatus.vue';
import ReliableAgentStatusPanel from '@webview/components/input/ReliableAgentStatusPanel.vue';
import ReliableQueuePanel from '@webview/components/input/ReliableQueuePanel.vue';
import SteeringStatusPanel from '@webview/components/input/SteeringStatusPanel.vue';
import SessionThinkingControl from '@webview/components/input/SessionThinkingControl.vue';
import { modelRequestNativeCapabilities } from '@webview/reliability/modelRequestStreamStats';

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    placeholder?: string;
    expandBoundary?: HTMLElement | null;
  }>(),
  { disabled: false, placeholder: '', expandBoundary: null }
);

const emit = defineEmits<{
  (event: 'submit', text: string, content: MessageContent | undefined, authority: TurnAuthoritySelection): void;
}>();

const clientState = useClientStateStore();
const globalSettings = useGlobalSettingsStore();
const workflowStore = useWorkflowStore();
const agentStore = useAgentStore();
const modelProfileStore = useModelProfileStore();
watch(() => clientState.currentConversationId, (conversationId, _previous, onCleanup) => {
  if (conversationId) onCleanup(modelProfileStore.activateScope('conversation', conversationId));
}, { immediate: true });
const confirmedEffectiveModel = computed(() => clientState.currentConversationId
  ? modelProfileStore.effectiveFor('conversation', clientState.currentConversationId)
  : undefined);
const confirmedChannelConfig = computed(() => globalSettings.llmProviderConfigs.configs.find(config =>
  config.id === confirmedEffectiveModel.value?.providerConfigId));
const workEnvironmentStore = useWorkEnvironmentStore();
const ui = useConversationUiStore();
const session = useSessionStore();
const reliableConversation = useReliableConversation();
const {
  interruptCurrentConversation,
  sendMessage,
  interruptPending,
  interruptPhase,
  compressContext,
  compressionPending,
  currentAuthoritySelection,
  currentTurnInputAcknowledgements,
  currentTurnInputFailure,
  dismissTurnInputAcknowledgement,
  dismissTurnInputFailure,
  steerCurrentTurn,
  currentSteeringSubmitting,
  steeringSubmissionResultsById,
  dismissSteeringSubmissionResult
} = useChat();
const highlighted = ref(false);
const editorExpanded = ref(false);
const editor = ref<{ focus: () => void } | null>(null);
const editorShell = ref<HTMLElement | null>(null);
const expandedEditorHeight = ref(0);
const collapsedEditorHeight = ref(0);
const agentDropdownCloseSignal = ref(0);
const modeDropdownCloseSignal = ref(0);
const channelDropdownCloseSignal = ref(0);
const workEnvironmentDropdownCloseSignal = ref(0);
const fileInput = ref<HTMLInputElement | null>(null);
const attachmentScroller = ref<HTMLElement | null>(null);
const channelModelPanel = ref<{ configId: string; style: Record<string, string> } | null>(null);
const currentSubmissionCommandId = ref<string>();
const currentSteerCommandId = ref<string>();

const draft = computed({
  get: () => ui.composerDraft,
  set: (next: string) => ui.setComposerDraft(next)
});
// Interaction 与普通输入是独立控制面：等待 AskUser/Plan 时，用户仍可创建排队 TurnIntent。
const savingSessionSelections = ref<Record<string, boolean>>({});
const savingSessionSelection = computed(() => !!savingSessionSelections.value[clientState.currentConversationId ?? '']);
const conversationInputDisabled = computed(() =>
  props.disabled || Boolean(currentSubmissionCommandId.value) || currentSteeringSubmitting.value || savingSessionSelection.value
);
const effectivePlaceholder = computed(() => props.placeholder);
const expandTitle = computed(() => (editorExpanded.value ? '恢复输入框高度' : '扩大输入框'));
const sendTitle = computed(() => {
  if (currentSubmissionCommandId.value) return '正在确认消息已保存';
  if (currentSteeringSubmitting.value) return '正在提交介入消息';
  if (ui.isEditing) return '提交编辑';
  if (nativeSteeringAvailable.value) return '立即介入当前回复';
  return currentExecution.value ? '加入消息队列（不会解除当前审批或等待）' : '发送';
});
const currentExecution = computed(() => Object.values(reliableConversation.feed.records.Turn ?? {}).find((turn) =>
  turn.conversation_id === reliableConversation.conversationId.value && turn.status === 'active'
));
/** 只有进行中原生请求的冻结能力（response.created 时写入）决定普通发送是否使用转向。 */
const activeStreamingModelRequest = computed(() => {
  const turn = currentExecution.value;
  if (!turn || typeof turn.id !== 'string') return undefined;
  return Object.values(reliableConversation.feed.records.ModelRequest ?? {})
    .filter((request) => request.turn_id === turn.id && request.status === 'streaming')
    .sort((left, right) => (Number(right.request_seq) || 0) - (Number(left.request_seq) || 0))[0];
});
const nativeSteeringAvailable = computed(() =>
  modelRequestNativeCapabilities(activeStreamingModelRequest.value)?.steering === true
);
const canCompressCurrentContext = computed(() =>
  !currentExecution.value
  && !compressionPending.value
  && !!reliableConversation.conversationId.value
  && reliableConversation.projection.value.messages.length >= 2
);

function compressCurrentContext(): void {
  const conversationId = reliableConversation.conversationId.value;
  if (!conversationId || !canCompressCurrentContext.value) return;
  compressContext(conversationId, { kind: 'current_head' });
}
const summaryRebuildTarget = ref<{ conversationId: string; rootId: string }>();
const currentContextRootId = computed(() => {
  const status = Object.values(reliableConversation.feed.records.ConversationContextStatus ?? {})
    .find((candidate) => candidate.conversation_id === reliableConversation.conversationId.value);
  return typeof status?.root_id === 'string' ? status.root_id : '';
});
const summaryRebuildCanConfirm = computed(() => canCompressCurrentContext.value
  && summaryRebuildTarget.value?.conversationId === reliableConversation.conversationId.value
  && summaryRebuildTarget.value?.rootId === currentContextRootId.value);
const summaryRebuildPreview = useSummaryRebuildPreview();
const summaryRebuildTooltip = summaryRebuildTooltipRows();

function beginSummaryRebuild(): void {
  if (!canCompressCurrentContext.value || !currentContextRootId.value) return;
  summaryRebuildTarget.value = {
    conversationId: reliableConversation.conversationId.value,
    rootId: currentContextRootId.value
  };
  summaryRebuildPreview.request(summaryRebuildTarget.value.conversationId, summaryRebuildTarget.value.rootId);
}

function closeSummaryRebuild(): void {
  summaryRebuildTarget.value = undefined;
  summaryRebuildPreview.reset();
}

function confirmSummaryRebuild(): void {
  if (!summaryRebuildCanConfirm.value || !summaryRebuildTarget.value) return;
  compressContext(summaryRebuildTarget.value.conversationId, { kind: 'current_head' }, {
    sourceReplay: 'immutable_provenance'
  });
  closeSummaryRebuild();
}
const channelOptions = computed<SettingsDropdownOption[]>(() =>
  globalSettings.llmProviderConfigs.configs.map((config) => {
    const model = selectedModelForConfig(config);
    return {
      value: config.id,
      label: config.name,
      buttonLabel: model ? `${config.name} · ${model}` : config.name,
      description: model ? `${providerLabel(config.provider)} · ${model}` : providerLabel(config.provider)
    };
  })
);
const channelModelPanelConfig = computed(() => channelModelPanel.value ? globalSettings.llmProviderConfigs.configs.find((config) => config.id === channelModelPanel.value?.configId) : undefined);
const channelModelPanelModels = computed(() => channelModelPanelConfig.value?.models ?? []);
const channelModelPanelItems = computed<SettingsSelectableListItem[]>(() => channelModelPanelModels.value.map((model) => ({
  id: model.id,
  title: model.name || model.id,
  description: modelDescription(model)
})));
const workEnvironmentOptions = computed<SettingsDropdownOption[]>(() =>
  workEnvironmentStore.allowedEnvironmentsForConversation(clientState.currentConversationId)
    .sort((left, right) => workEnvironmentSortKey(left).localeCompare(workEnvironmentSortKey(right), 'zh-CN') || left.id.localeCompare(right.id))
    .map((environment) => ({
      value: environment.id,
      label: environment.name,
      description: middleEllipsis(workEnvironmentDisplayPath(environment), 58),
      icon: IconFolder
    }))
);
const workEnvironmentSelection = computed(() => workEnvironmentStore.environmentSelectionForConversation(clientState.currentConversationId));
const workEnvironmentSwitchingEnabled = computed(() => workEnvironmentStore.workEnvironmentEnabledForConversation(clientState.currentConversationId));
const workEnvironmentLabel = computed(() => workEnvironmentSelection.value.error
  ? '工作目录待选择'
  : workEnvironmentSelection.value.active?.name ?? '未绑定工作目录');
const workEnvironmentDescription = computed(() => workEnvironmentSelection.value.error
  ?? (workEnvironmentSelection.value.active ? workEnvironmentDisplayPath(workEnvironmentSelection.value.active) : '当前没有可用的工作目录。'));
const frozenWorkEnvironmentSelection = computed(() => workEnvironmentStore.frozenEnvironmentSelectionForConversation(clientState.currentConversationId));
const displayedWorkEnvironmentSelection = computed(() => frozenWorkEnvironmentSelection.value ?? workEnvironmentSelection.value);
const displayedWorkEnvironmentLabel = computed(() => displayedWorkEnvironmentSelection.value.error
  ? '工作目录不可用'
  : displayedWorkEnvironmentSelection.value.active?.name ?? '未绑定工作目录');
const displayedWorkEnvironmentDescription = computed(() => displayedWorkEnvironmentSelection.value.error
  ?? (displayedWorkEnvironmentSelection.value.active ? workEnvironmentDisplayPath(displayedWorkEnvironmentSelection.value.active) : '本回合没有可用的工作目录。'));
const workflowOptions = computed<SettingsDropdownOption[]>(() => [
  {
    value: DEFAULT_WORKFLOW_OPTION_ID,
    label: '默认',
    description: '使用全局默认策略',
    icon: IconWorld
  },
  ...workflowStore.workflows.map((workflow) => ({
    value: workflow.id,
    label: workflow.name,
    description: workflow.description || (workflow.source === 'builtin' ? '内置工作流' : '用户工作流'),
    icon: IconListDetails
  }))
]);
const activeConversationAgent = computed(() => agentStore.activeAgentForConversation(clientState.currentConversationId));
const agentOptions = computed<SettingsDropdownOption[]>(() => {
  const options = agentStore.configurableAgents.map((agent) => agentOption(agent));
  const active = activeConversationAgent.value;
  if (active?.runtimeRole === 'mirror' && !options.some((option) => option.value === active.id)) {
    options.unshift(agentOption(active, true));
  }
  return options;
});
const activeAgentId = computed({
  get: () => activeConversationAgent.value?.id ?? agentOptions.value[0]?.value ?? '',
  set: (agentId: string) => selectAgent(agentId)
});
const activeWorkflowId = computed({
  get: () => workflowStore.activeWorkflowIdForConversation(clientState.currentConversationId),
  set: (workflowId: string) => selectWorkflow(workflowId)
});
const activeChannelId = computed({
  get: () => {
    const conversationId = clientState.currentConversationId;
    const local = conversationId ? modelProfileStore.localProfileFor('conversation', conversationId).profile : undefined;
    const profileConfigId = !local?.inheritModel ? local?.providerConfigId?.trim() : '';
    const effective = confirmedEffectiveModel.value;
    return profileConfigId || effective?.providerConfigId || globalSettings.llm.activeProviderConfigId || globalSettings.activeLlmProviderConfig?.id || '';
  },
  set: (configId: string) => selectChannel(configId)
});
const activeChannelConfig = computed(() => globalSettings.llmProviderConfigs.configs.find((config) => config.id === activeChannelId.value));
const activeTransport = computed<'http' | 'websocket'>(() => {
  const config = activeChannelConfig.value;
  if (!config || config.provider !== 'openai-responses') return 'http';
  const modelId = selectedModelForConfig(config);
  const modelConfig = config.modelConfigs.find((candidate) => candidate.modelId === modelId);
  return modelConfig?.openaiResponsesTransport ?? config.openaiResponsesTransport ?? 'http';
});
const runtimeTransportLabel = computed(() => activeTransport.value === 'websocket' ? 'WebSocket' : 'HTTP');
const runtimeReloadRequired = computed(() => session.status === 'ready' && (!session.runtime || session.runtime.reloadRequired));
const runtimeBadgeLabel = computed(() => runtimeReloadRequired.value ? '需重载' : '正常');
const runtimeDiagnosticRows = computed(() => {
  const config = activeChannelConfig.value;
  return [
    {
      label: '状态',
      value: runtimeReloadRequired.value
        ? session.runtime ? '扩展已更新，需要重新加载窗口' : '扩展信息暂不可用，请重新加载窗口'
        : '正常'
    },
    { label: '模型渠道', value: config?.name || (config ? providerLabel(config.provider) : '未选择') },
    { label: 'LLM', value: config ? selectedModelForConfig(config) || config.model || '未选择' : '未选择' },
    { label: '连接方式', value: runtimeTransportLabel.value }
  ];
});
const runtimeDiagnosticAriaLabel = computed(() => runtimeReloadRequired.value
  ? '扩展需要重新加载；查看连接状态'
  : '连接正常；查看连接状态');

const activeWorkEnvironmentId = computed({
  get: () => workEnvironmentStore.activeEnvironmentForConversation(clientState.currentConversationId)?.id ?? '',
  set: (workEnvironmentId: string) => selectWorkEnvironment(workEnvironmentId)
});
const editorShellStyle = computed(() => {
  if (!editorExpanded.value || !expandedEditorHeight.value) return undefined;
  return {
    '--composer-expanded-editor-height': `${expandedEditorHeight.value}px`
  };
});
const SUPPORTED_COMPOSER_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'text/plain'
]);
const COMPOSER_EXTENSION_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain'
};
const attachmentSnapshots = ref<Record<'chat' | 'edit', InlineDataPart[]>>({ chat: [], edit: [] });
const selectedAttachments = computed<InlineDataPart[]>({
  get: () => attachmentSnapshots.value[ui.composerMode],
  set: (value) => {
    attachmentSnapshots.value = { ...attachmentSnapshots.value, [ui.composerMode]: value };
  }
});
const attachmentRefreshKey = computed(() => selectedAttachments.value.map((part, index) => index + ':' + (part.inlineData.name ?? '') + ':' + (part.inlineData.sizeBytes ?? 0)).join('|'));
const hasDraftContent = computed(() => draft.value.trim().length > 0 || selectedAttachments.value.length > 0);
const attachmentLimitBytes = computed(() => Math.max(1, globalSettings.attachments.maxStoredInlineFileMb || 20) * 1024 * 1024);
const attachmentTotalBytes = computed(() => selectedAttachments.value.reduce(
  (total, part) => total + Math.max(0, part.inlineData.sizeBytes ?? 0),
  0
));

watch(
  () => currentSubmissionCommandId.value
    ? currentTurnInputAcknowledgements.value[currentSubmissionCommandId.value]
    : undefined,
  (acknowledgement) => {
    const commandId = currentSubmissionCommandId.value;
    if (!commandId || !acknowledgement) return;
    attachmentSnapshots.value = { ...attachmentSnapshots.value, chat: [] };
    ui.clearChatDraft();
    currentSubmissionCommandId.value = undefined;
    dismissTurnInputAcknowledgement(commandId);
  }
);

watch(
  () => currentSteerCommandId.value
    ? steeringSubmissionResultsById.value[currentSteerCommandId.value]
    : undefined,
  (result) => {
    const commandId = currentSteerCommandId.value;
    if (!commandId || !result) return;
    currentSteerCommandId.value = undefined;
    dismissSteeringSubmissionResult(commandId);
    // 失败时保留草稿和附件，不改为排队投递。
    if (!result.ok) return;
    attachmentSnapshots.value = { ...attachmentSnapshots.value, chat: [] };
    ui.clearChatDraft();
  }
);

watch(
  [
    () => currentTurnInputFailure.value?.commandId,
    () => draft.value,
    () => selectedAttachments.value.length
  ],
  () => {
    const failure = currentTurnInputFailure.value;
    if (!failure) return;
    if (failure.commandId === currentSubmissionCommandId.value) {
      currentSubmissionCommandId.value = undefined;
      dismissTurnInputFailure(failure.commandId);
      void nextTick(() => editor.value?.focus());
      return;
    }
    if (draft.value.trim() || attachmentSnapshots.value.chat.length > 0) return;
    draft.value = failure.text;
    attachmentSnapshots.value = {
      ...attachmentSnapshots.value,
      chat: (failure.content?.parts ?? []).flatMap((part) =>
        'inlineData' in part ? [structuredClone(part as InlineDataPart)] : []
      )
    };
    dismissTurnInputFailure(failure.commandId);
    void nextTick(() => editor.value?.focus());
  },
  { immediate: true }
);

let highlightTimer: number | undefined;

watch(
  () => ui.composerHighlightKey,
  () => {
    if (!ui.isEditing) return;
    attachmentSnapshots.value = {
      ...attachmentSnapshots.value,
      edit: (ui.editingMessage?.message.content.parts ?? []).flatMap((part) =>
        'inlineData' in part ? [structuredClone(part as InlineDataPart)] : []
      )
    };
    pulseHighlight();
    void nextTick(() => editor.value?.focus());
  }
);

watch(
  () => ui.composerMode,
  (mode, previous) => {
    if (mode === 'chat' && previous === 'edit') {
      attachmentSnapshots.value = { ...attachmentSnapshots.value, edit: [] };
    }
  }
);

onMounted(() => {
  globalSettings.ensureAttachments();
  window.addEventListener('keydown', onWindowKeydown);
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
  window.removeEventListener('resize', onWindowResize);
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
});

function onWindowKeydown(event: KeyboardEvent): void {
  if (!ui.isEditing || event.key !== 'Escape') return;
  event.preventDefault();
  ui.cancelEditMode();
}

function onWindowResize(): void {
  channelModelPanel.value = null;
  if (!editorExpanded.value) return;
  updateExpandedEditorHeight();
}

async function submit(): Promise<void> {
  const text = draft.value.trim();
  if ((!text && selectedAttachments.value.length === 0) || conversationInputDisabled.value) return;
  const content = buildMessageContent(text, selectedAttachments.value);
  if (ui.isEditing) {
    emit('submit', text, content, currentTurnAuthoritySelection());
    return;
  }
  if (nativeSteeringAvailable.value) {
    const submission = steerCurrentTurn(text, content);
    if (submission) currentSteerCommandId.value = submission.commandId;
    return;
  }
  const conversationId = clientState.currentConversationId;
  if (conversationId) {
    savingSessionSelections.value[conversationId] = true;
    try {
      await modelProfileStore.awaitSavedForScope('conversation', conversationId);
    } catch {
      // Scope errors are shown next to the thinking control; do not send stale settings.
      return;
    } finally {
      delete savingSessionSelections.value[conversationId];
    }
    if (clientState.currentConversationId !== conversationId || draft.value.trim() !== text || conversationInputDisabled.value) return;
  }
  const submission = sendMessage(text, content, currentTurnAuthoritySelection());
  if (!submission) return;
  currentSubmissionCommandId.value = submission.commandId;
}

function openFilePicker(): void { fileInput.value?.click(); }

async function onPasteFiles(files: File[]): Promise<void> {
  await addFilesAsAttachments(files);
}

async function onAttachmentFilesChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null;
  const files = [...(input?.files ?? [])];
  if (input) input.value = '';
  await addFilesAsAttachments(files);
}

async function addFilesAsAttachments(files: File[]): Promise<void> {
  const targetMode = ui.composerMode;
  const limitBytes = attachmentLimitBytes.value;
  const limitMb = globalSettings.attachments.maxStoredInlineFileMb || 20;
  for (const file of files) {
    let targetAttachments = attachmentSnapshots.value[targetMode];
    const mimeType = attachmentMimeTypeForFile(file);
    if (!SUPPORTED_COMPOSER_MIME_TYPES.has(mimeType)) {
      globalSettings.status = `当前 LLM 仅支持 PNG、JPEG、WebP、PDF 和纯文本附件；未添加 ${file.name}。`;
      continue;
    }
    if (file.size > limitBytes) {
      globalSettings.status = `附件 ${file.name} 超过 ${limitMb}MB，未添加。`;
      continue;
    }
    if (attachmentBytes(targetAttachments) + file.size > limitBytes) {
      globalSettings.status = `本条消息的附件总大小超过 ${limitMb}MB，未添加 ${file.name}。`;
      continue;
    }
    const data = await readFileAsBase64(file);
    // FileReader can finish after the user switches between chat and edit. Commit to the bucket
    // selected when reading started, never whichever mode happens to be current after the await.
    targetAttachments = attachmentSnapshots.value[targetMode];
    if (attachmentBytes(targetAttachments) + file.size > limitBytes) {
      globalSettings.status = `本条消息的附件总大小超过 ${limitMb}MB，未添加 ${file.name}。`;
      continue;
    }
    attachmentSnapshots.value = {
      ...attachmentSnapshots.value,
      [targetMode]: [
        ...targetAttachments,
        { inlineData: { mimeType, data, name: file.name, storage: 'embedded', status: 'available', sizeBytes: file.size } }
      ]
    };
  }
}

function attachmentBytes(attachments: InlineDataPart[]): number {
  return attachments.reduce((total, part) => total + Math.max(0, part.inlineData.sizeBytes ?? 0), 0);
}

function removeAttachment(index: number): void {
  selectedAttachments.value.splice(index, 1);
}

function buildMessageContent(text: string, attachments: InlineDataPart[]): MessageContent | undefined {
  if (attachments.length === 0) return undefined;
  return {
    role: 'user',
    parts: [
      ...(text ? [{ text }] : []),
      ...attachments.map((part) => ({ inlineData: { ...part.inlineData } }))
    ]
  };
}

function attachmentMimeTypeForFile(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const normalizedName = file.name.toLowerCase();
  const extension = Object.keys(COMPOSER_EXTENSION_MIME_TYPES)
    .find((candidate) => normalizedName.endsWith(candidate));
  return extension ? COMPOSER_EXTENSION_MIME_TYPES[extension] : 'application/octet-stream';
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      resolve(value.replace(/^data:[^,]+,/, ''));
    };
    reader.readAsDataURL(file);
  });
}

function attachmentDisplayName(part: InlineDataPart): string {
  return part.inlineData.name || part.inlineData.mimeType;
}

function attachmentSizeLabel(part: InlineDataPart): string {
  const bytes = part.inlineData.sizeBytes;
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function onAttachmentWheel(event: WheelEvent): void {
  const element = attachmentScroller.value;
  if (!element) return;
  const maxScrollLeft = element.scrollWidth - element.clientWidth;
  if (maxScrollLeft <= 1) return;

  const rawDelta = event.deltaX || event.deltaY;
  if (!rawDelta) return;
  event.preventDefault();

  const unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE
    ? element.clientWidth
    : event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 24
      : 1;
  element.scrollLeft = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft + rawDelta * unit));
}

function interruptConversation(): void {
  // Ordinary Stop closes only the parent-side foreground wait. Child subtree cancellation is a
  // separate explicit authority and must never be inferred from the generic composer button.
  interruptCurrentConversation(false);
}

function toggleEditorExpanded(): void {
  if (!editorExpanded.value) {
    collapsedEditorHeight.value = editorShell.value?.getBoundingClientRect().height ?? 0;
    updateExpandedEditorHeight();
  }

  editorExpanded.value = !editorExpanded.value;
  void nextTick(() => {
    if (editorExpanded.value) updateExpandedEditorHeight();
    editor.value?.focus();
  });
}

function updateExpandedEditorHeight(): void {
  const shell = editorShell.value;
  if (!shell) return;

  const shellRect = shell.getBoundingClientRect();
  const boundaryRect = props.expandBoundary?.getBoundingClientRect();
  const boundaryTop = boundaryRect?.top ?? 0;
  const availableHeight = shellRect.bottom - boundaryTop;
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return;

  const minHeight = collapsedEditorHeight.value || shellRect.height;
  expandedEditorHeight.value = Math.floor(Math.min(availableHeight, Math.max(minHeight, availableHeight * 0.9)));
}

function pulseHighlight(): void {
  highlighted.value = true;
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => {
    highlighted.value = false;
    highlightTimer = undefined;
  }, 650);
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'openai-compatible':
      return 'OpenAI Compatible';
    case 'openai-responses':
      return 'OpenAI Responses';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    case 'deepseek':
      return 'DeepSeek';
    default:
      return provider;
  }
}

function selectedModelForConfig(config: LlmProviderConfigRecord): string {
  const conversationId = clientState.currentConversationId;
  const profile = conversationId ? modelProfileStore.localProfileFor('conversation', conversationId).profile : undefined;
  const effective = confirmedEffectiveModel.value;
  const profileModel = profile?.providerConfigId?.trim() === config.id && !profile.inheritModel ? profile.model.trim()
    : effective?.providerConfigId === config.id ? effective.model : '';
  return profileModel || config.model;
}

function currentTurnAuthoritySelection(): TurnAuthoritySelection {
  return currentAuthoritySelection();
}

function modelDescription(model: LlmProviderModelRecord): string {
  return model.createdAt ? `ID: ${model.id} · ${model.createdAt}` : `ID: ${model.id}`;
}

function openChannelModelPanel(configId: string, event: MouseEvent): void {
  if (channelModelPanel.value?.configId === configId) {
    channelModelPanel.value = null;
    return;
  }
  const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  if (!target) return;
  channelModelPanel.value = { configId, style: channelModelPanelStyleFor(target) };
}

function channelModelPanelStyleFor(anchor: HTMLElement): Record<string, string> {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const width = Math.min(170, Math.max(150, window.innerWidth - margin * 2));
  const height = 220;
  let left = rect.right + gap;
  if (left + width > window.innerWidth - margin) left = rect.left - width - gap;
  if (left < margin) left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
  let top = rect.top;
  if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
  if (top < margin) top = margin;
  return {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    width: `${Math.round(width)}px`,
    height: `${height}px`
  };
}

function selectChannelModel(config: LlmProviderConfigRecord, item: SettingsSelectableListItem): void {
  const modelId = item.id;
  if (!config.models.some((model) => model.id === modelId)) return;
  const conversationId = clientState.currentConversationId;
  if (conversationId) {
    setConversationModelProfile(conversationId, config, modelId);
  } else {
    globalSettings.selectLlmProviderConfigModel(config.id, modelId);
  }
  channelModelPanel.value = null;
}

function selectChannel(configId: string): void {
  if (!configId) return;
  const conversationId = clientState.currentConversationId;
  if (conversationId) {
    const config = globalSettings.llmProviderConfigs.configs.find((candidate) => candidate.id === configId);
    if (config) setConversationModelProfile(conversationId, config, selectedModelForConfig(config));
    return;
  }
  globalSettings.selectLlmProviderConfig(configId);
}

function setConversationModelProfile(conversationId: string, config: LlmProviderConfigRecord, modelId: string): void {
  const model = modelId.trim();
  if (!conversationId || !config.id || !model) return;
  modelProfileStore.setProfileForScope('conversation', conversationId, {
    name: '对话临时 LLM',
    providerConfigId: config.id,
    provider: config.provider,
    model
  });
}

function selectAgent(agentId: string): void {
  const conversationId = clientState.currentConversationId;
  if (!conversationId || !agentId) return;
  agentStore.selectAgent(conversationId, agentId);
}

function selectWorkflow(workflowId: string): void {
  const conversationId = clientState.currentConversationId;
  if (!conversationId) return;
  if (workflowId === DEFAULT_WORKFLOW_OPTION_ID) {
    workflowStore.selectDefault(conversationId);
    return;
  }
  workflowStore.selectWorkflow(conversationId, workflowId);
}

function selectWorkEnvironment(workEnvironmentId: string): void {
  if (!workEnvironmentId) return;
  const conversationId = clientState.currentConversationId;
  if (!conversationId) return;
  workEnvironmentStore.selectConversationEnvironment(conversationId, workEnvironmentId);
}

function closeChannelModelPanel(): void {
  channelModelPanel.value = null;
}

function onAgentDropdownOpen(): void {
  closeChannelModelPanel();
  modeDropdownCloseSignal.value += 1;
  channelDropdownCloseSignal.value += 1;
  workEnvironmentDropdownCloseSignal.value += 1;
}

function onModeDropdownOpen(): void {
  closeChannelModelPanel();
  agentDropdownCloseSignal.value += 1;
  channelDropdownCloseSignal.value += 1;
  workEnvironmentDropdownCloseSignal.value += 1;
}

function onChannelDropdownOpen(): void {
  closeChannelModelPanel();
  agentDropdownCloseSignal.value += 1;
  modeDropdownCloseSignal.value += 1;
  workEnvironmentDropdownCloseSignal.value += 1;
}

function onWorkEnvironmentDropdownOpen(): void {
  closeChannelModelPanel();
  agentDropdownCloseSignal.value += 1;
  modeDropdownCloseSignal.value += 1;
  channelDropdownCloseSignal.value += 1;
}

function workEnvironmentSortKey(environment: WorkEnvironmentRecord): string {
  return buildWorkEnvironmentSortKey(environment);
}

function agentOption(agent: AgentRecord, disabled = false): SettingsDropdownOption {
  return {
    value: agent.id,
    label: agent.name,
    description: agent.description || agentSourceDescription(agent),
    icon: IconRobot,
    disabled
  };
}

function agentSourceDescription(agent: AgentRecord): string {
  if (agent.runtimeRole === 'mirror') return `临时镜像 · ${agent.typeAgentId ?? agent.kind}`;
  if (agent.source === 'builtin') return `内置 Agent · ${agent.kind}`;
  return `用户 Agent · ${agent.kind}`;
}

function middleEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(4, Math.floor((maxLength - 3) / 2));
  const head = value.slice(0, keep);
  const tail = value.slice(value.length - keep);
  return `${head}…${tail}`;
}
</script>

<template>
  <div class="composer" :class="{ 'is-editing': ui.isEditing, 'is-highlighted': highlighted, 'is-editor-expanded': editorExpanded }">
    <div class="composer-zone composer-zone-top" aria-label="输入框上方功能区">
      <div class="composer-top-main">
        <ReliableQueuePanel />
        <SteeringStatusPanel />
        <AskUserTopPanel />
        <div v-if="ui.isEditing" class="composer-edit-indicator">
          <span class="composer-edit-indicator-icon" aria-hidden="true">
            <IconPencilExclamation stroke="2" />
          </span>
          <span class="composer-edit-text">{{ ui.editingTurnIntent ? '正在编辑排队消息，发送后会创建一个新的消息版本。' : '正在编辑消息，发送前需要确认。' }}</span>
          <button type="button" class="composer-edit-cancel" @click="ui.cancelEditMode">取消编辑</button>
        </div>
        <div v-if="selectedAttachments.length" class="composer-attachments-shell">
          <div ref="attachmentScroller" class="composer-attachments" aria-label="已选择附件" @wheel="onAttachmentWheel">
            <span v-for="(attachment, index) in selectedAttachments" :key="`${attachment.inlineData.name}-${index}`" class="composer-attachment-chip">
              <span class="composer-attachment-name">{{ attachmentDisplayName(attachment) }}</span>
              <span v-if="attachmentSizeLabel(attachment)" class="composer-attachment-size">{{ attachmentSizeLabel(attachment) }}</span>
              <button type="button" class="composer-attachment-remove" title="移除附件" @click="removeAttachment(index)">
                <IconTrash stroke="2" aria-hidden="true" />
              </button>
            </span>
          </div>
          <AdvancedScrollbar
            class="composer-attachments-scrollbar"
            :scroller="attachmentScroller"
            :refresh-key="attachmentRefreshKey"
            variant="minimal"
            orientation="horizontal"
          />
        </div>
      </div>
      <div class="composer-top-actions">
        <ReliableAgentStatusPanel />
        <BackgroundCommandPanel />
      </div>
    </div>

    <div class="composer-input-row">
      <div class="composer-zone composer-zone-left" aria-label="输入框左侧功能区"></div>
      <div ref="editorShell" class="composer-editor-shell" :style="editorShellStyle">
        <RichContentEditor
          ref="editor"
          v-model="draft"
          class="composer-editor"
          :placeholder="ui.isEditing ? (ui.editingTurnIntent ? '编辑排队消息内容...' : '编辑消息内容...') : effectivePlaceholder"
          :disabled="conversationInputDisabled"
          :rows="5"
          @submit="submit"
          @paste-files="onPasteFiles"
        />
      </div>
      <div class="composer-zone composer-zone-right" aria-label="输入框右侧功能区">
        <input
          ref="fileInput"
          type="file"
          class="composer-file-input"
          multiple
          accept="image/png,image/jpeg,image/webp,application/pdf,text/plain"
          @change="onAttachmentFilesChange"
        />
        <button
          type="button"
          class="composer-side-action"
          :aria-label="expandTitle"
          :aria-pressed="editorExpanded"
          :title="expandTitle"
          @click="toggleEditorExpanded"
        >
          <svg
            v-if="!editorExpanded"
            class="composer-side-action-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path stroke="none" d="M0 0h24v24H0z" fill="none" />
            <path d="M9 18l3 3l3 -3" />
            <path d="M12 15v6" />
            <path d="M15 6l-3 -3l-3 3" />
            <path d="M12 3v6" />
          </svg>
          <svg
            v-else
            class="composer-side-action-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path stroke="none" d="M0 0h24v24H0z" fill="none" />
            <path d="M9 6l3 3l3 -3" />
            <path d="M12 3v6" />
            <path d="M15 18l-3 -3l-3 3" />
            <path d="M12 15v6" />
          </svg>
        </button>
        <button
          type="button"
          class="composer-side-action"
          aria-label="添加附件"
          title="添加图片、PDF、文本、音频或视频附件"
          :disabled="conversationInputDisabled"
          @click="openFilePicker"
        >
          <IconPaperclip class="composer-side-action-icon" stroke="2" aria-hidden="true" />
        </button>
        <button
          v-if="currentExecution"
          type="button"
          class="composer-side-action composer-side-abort"
          :aria-label="interruptPhase === 'stopping' ? '正在停止当前回复' : interruptPhase === 'requesting' ? '正在提交停止请求' : '停止当前回复'"
          :title="interruptPhase === 'stopping' ? '正在停止当前回复' : interruptPhase === 'requesting' ? '正在提交停止请求' : '停止当前回复（子 Agent 与后台进程继续运行）'"
          :disabled="interruptPending"
          @click="interruptConversation"
        >
          <IconPlayerStop class="composer-side-action-icon" stroke="2" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div class="composer-zone composer-zone-bottom" aria-label="输入框下方功能区">
      <div v-if="clientState.currentConversationId || agentOptions.length || workflowOptions.length || channelOptions.length || workEnvironmentOptions.length" class="composer-meta">
        <template v-if="agentOptions.length">
          <SettingsDropdown
            v-model="activeAgentId"
            class="composer-meta-dropdown composer-agent-dropdown"
            :options="agentOptions"
            title="切换当前 Agent"
            searchable
            search-placeholder="筛选 Agent…"
            :close-signal="agentDropdownCloseSignal"
            :max-height="220"
            @open="onAgentDropdownOpen"
          />
        </template>
        <template v-if="workflowOptions.length">
          <SettingsDropdown
            v-model="activeWorkflowId"
            class="composer-meta-dropdown composer-workflow-dropdown"
            :options="workflowOptions"
            title="切换工作流"
            searchable
            search-placeholder="筛选工作流…"
            :close-signal="modeDropdownCloseSignal"
            :max-height="220"
            @open="onModeDropdownOpen"
          />
        </template>
        <template v-if="channelOptions.length">
          <SettingsDropdown
            v-model="activeChannelId"
            class="composer-meta-dropdown composer-channel-dropdown"
            :options="channelOptions"
            title="切换渠道配置页"
            empty-text="暂无渠道配置"
            searchable
            search-placeholder="筛选渠道…"
            :close-signal="channelDropdownCloseSignal"
            :max-height="220"
            @open="onChannelDropdownOpen"
          >
            <template #optionAction="{ option }">
              <button
                type="button"
                class="channel-model-toggle"
                :class="{ 'is-open': channelModelPanel?.configId === option.value }"
                :disabled="!globalSettings.llmProviderConfigs.configs.find((config) => config.id === option.value)?.models.length"
                aria-label="切换该渠道的 LLM"
                @click.stop="openChannelModelPanel(option.value, $event)"
              >
                <span class="channel-model-toggle-caret" aria-hidden="true"></span>
              </button>
            </template>
            <template #panelOverlay="{ open }">
              <section
                v-if="open && channelModelPanel && channelModelPanelConfig"
                class="channel-model-panel lc-dropdown-panel"
                :style="channelModelPanel.style"
                aria-label="切换 LLM"
                @click.stop
              >
                <div class="channel-model-panel-title">
                  <span>{{ channelModelPanelConfig.name }}</span>
                  <small>{{ providerLabel(channelModelPanelConfig.provider) }}</small>
                </div>
                <SettingsSelectableList
                  class="channel-model-list"
                  :items="channelModelPanelItems"
                  :selected-id="selectedModelForConfig(channelModelPanelConfig)"
                  search-placeholder="筛选 LLM…"
                  empty-text="该渠道暂无 LLM 列表。"
                  no-match-text="没有匹配的 LLM。"
                  :max-height="124"
                  @select="selectChannelModel(channelModelPanelConfig, $event)"
                />
              </section>
            </template>
          </SettingsDropdown>
        </template>
        <template v-if="workEnvironmentSwitchingEnabled && (workEnvironmentOptions.length || workEnvironmentSelection.error)">
          <HoverTooltipPanel :panel-title="frozenWorkEnvironmentSelection ? '下一回合工作目录' : '工作目录'" :rows="[{ label: '目录', value: workEnvironmentDescription }]">
            <SettingsDropdown
              v-model="activeWorkEnvironmentId"
              class="composer-meta-dropdown composer-work-environment-dropdown"
              :options="workEnvironmentOptions"
              :placeholder="workEnvironmentLabel"
              empty-text="暂无工作环境"
              searchable
              search-placeholder="筛选工作环境..."
              :close-signal="workEnvironmentDropdownCloseSignal"
              :max-height="220"
              @open="onWorkEnvironmentDropdownOpen"
            />
          </HoverTooltipPanel>
        </template>
        <HoverTooltipPanel
          v-if="frozenWorkEnvironmentSelection || (!workEnvironmentSwitchingEnabled && (displayedWorkEnvironmentSelection.active || displayedWorkEnvironmentSelection.error))"
          panel-title="实际工作目录"
          :rows="[{ label: frozenWorkEnvironmentSelection ? '本回合目录' : '目录', value: displayedWorkEnvironmentDescription }]"
        >
          <span class="composer-work-directory" :class="{ 'has-error': displayedWorkEnvironmentSelection.error }" tabindex="0">
            <IconFolder :size="12" aria-hidden="true" />
            {{ frozenWorkEnvironmentSelection ? '本回合：' : '' }}{{ displayedWorkEnvironmentLabel }}
          </span>
        </HoverTooltipPanel>
        <SessionThinkingControl
          v-if="clientState.currentConversationId"
          :conversation-id="clientState.currentConversationId"
          :config="confirmedChannelConfig"
          :model="confirmedEffectiveModel?.model"
        />
      </div>
      <div class="composer-actions">
        <span
          v-if="interruptPhase"
          class="composer-interrupt-status"
          data-testid="turn-interrupt-status"
          role="status"
        >{{ interruptPhase === 'stopping' ? '正在停止' : '正在请求停止' }}</span>
        <HoverTooltipPanel
          v-if="session.status === 'ready'"
          class="composer-runtime-tooltip"
          panel-title="连接状态"
          :rows="runtimeDiagnosticRows"
          :delay-ms="180"
        >
          <button
            type="button"
            class="composer-runtime-badge"
            :class="{ 'is-websocket': activeTransport === 'websocket', 'is-reload-required': runtimeReloadRequired }"
            :aria-label="runtimeDiagnosticAriaLabel"
          >
            {{ runtimeBadgeLabel }}
          </button>
        </HoverTooltipPanel>
        <ReliableContextStatus class="composer-token-usage" />
        <button
          type="button"
          class="composer-compact"
          data-testid="compression-start-current"
          :disabled="!canCompressCurrentContext"
          aria-label="压缩当前上下文"
          title="压缩当前上下文"
          @click="compressCurrentContext"
        >
          <svg class="composer-compact-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
            <path d="M5 5h14l-7 6zM5 19h14l-7-6z" />
          </svg>
        </button>
        <HoverTooltipPanel
          panel-title="从原始记录重建摘要"
          :rows="summaryRebuildTooltip"
          :delay-ms="180"
        >
          <button
            type="button"
            class="composer-compact"
            data-testid="compression-rebuild-current"
            :disabled="!canCompressCurrentContext || !currentContextRootId"
            aria-label="从原始记录重建摘要"
            @click="beginSummaryRebuild"
          >
            <IconHistory class="composer-send-icon" stroke="2" aria-hidden="true" />
          </button>
        </HoverTooltipPanel>
        <button
          type="button"
          class="composer-send"
          :disabled="conversationInputDisabled || !hasDraftContent"
          :aria-label="sendTitle"
          :title="sendTitle"
          @click="submit"
        >
          <IconSend2 class="composer-send-icon" stroke="2" aria-hidden="true" />
        </button>
      </div>
    </div>
    <SummaryRebuildConfirm
      :open="!!summaryRebuildTarget"
      :preview="summaryRebuildPreview.state.value"
      :target-current="summaryRebuildCanConfirm"
      @confirm="confirmSummaryRebuild"
      @cancel="closeSummaryRebuild"
    />
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.composer-input-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-1);
  min-width: 0;
}

.composer-zone {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.composer-zone:empty {
  display: none;
}

.composer-zone-left,
.composer-zone-right {
  flex: 0 0 auto;
}

.composer-zone-right {
  align-self: stretch;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: var(--space-1);
}

.composer-zone-top {
  min-height: 28px;
  align-items: flex-start;
  justify-content: space-between;
}

.composer-top-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.composer-top-actions {
  flex: 0 0 auto;
  min-height: 28px;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  gap: var(--space-1);
  margin-left: auto;
}

.composer-zone-bottom {
  justify-content: flex-end;
  align-items: center;
  /* Narrow panels: the selectors keep the first line and the status/send group moves below as a unit, never overlapping. */
  flex-wrap: wrap;
  row-gap: 2px;
}

.composer-actions {
  flex: 0 0 auto;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.composer-edit-indicator {
  width: 100%;
  min-height: 20px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.composer-edit-indicator-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.composer-edit-indicator-icon :deep(svg) {
  width: 16px;
  height: 16px;
}

.composer-edit-text {
  flex: 1;
  min-width: 0;
}

.composer-edit-cancel {
  min-height: 24px;
  padding: 0 var(--space-2);
  border-color: transparent;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.composer-edit-cancel:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: transparent;
  border-color: transparent;
}

.composer-editor-shell {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.composer-file-input {
  display: none;
}

.composer-attachments-shell {
  position: relative;
  width: 100%;
  min-width: 0;
  height: 32px;
  padding-bottom: 6px;
}

.composer-attachments {
  width: 100%;
  min-width: 0;
  height: 26px;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-1);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.composer-attachments::-webkit-scrollbar {
  display: none;
}

.composer-attachments-scrollbar {
  z-index: 2;
}

.composer-attachment-chip {
  flex: 0 0 auto;
  max-width: min(260px, 72vw);
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px 4px 2px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  font-size: var(--font-size-xs);
}

.composer-attachment-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vscode-foreground);
}

.composer-attachment-size {
  flex: 0 0 auto;
}

.composer-attachment-remove {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.composer-attachment-remove:hover,
.composer-attachment-remove:focus-visible {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.composer-attachment-remove svg {
  width: 13px;
  height: 13px;
}

.composer.is-editor-expanded .composer-editor-shell {
  height: var(--composer-expanded-editor-height);
}

.composer-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  transition: border-color var(--lc-composer-highlight-duration) ease, box-shadow var(--lc-composer-highlight-duration) ease;
}

.composer.is-editor-expanded .composer-editor {
  height: 100%;
}

.composer.is-highlighted .composer-editor {
  border-color: var(--vscode-editorWarning-foreground, #cca700);
  box-shadow: inset 0 0 0 1px var(--vscode-editorWarning-foreground, #cca700);
}

.composer-side-action {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border-color: transparent;
}

.composer-side-action:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.composer-side-action:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  border-color: transparent;
  opacity: 0.55;
  cursor: not-allowed;
}

.composer-side-action-icon {
  width: 16px;
  height: 16px;
  color: currentColor;
  pointer-events: none;
}

.composer-side-abort {
  margin-top: auto;
}

.composer-meta {
  flex: 1 1 220px;
  min-width: 0;
  margin-right: auto;
  overflow: visible;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.4;
  white-space: nowrap;
}

.composer-meta code {
  font-size: inherit;
}

.composer-interrupt-status {
  flex: 0 0 auto;
  color: var(--vscode-editorWarning-foreground, #cca700);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.composer-meta-dropdown {
  --lc-dropdown-transform-origin: bottom left;
  --lc-dropdown-offset-y: 4px;
}

.composer-workflow-dropdown {
  width: min(120px, 18vw);
  min-width: 100px;
}

.composer-agent-dropdown {
  width: min(120px, 19vw);
  min-width: 80px;
}

.composer-channel-dropdown {
  width: min(174px, 25vw);
  min-width: 132px;
}

.composer-work-environment-dropdown {
  width: min(210px, 32vw);
  min-width: 130px;
}

.composer-meta-dropdown :deep(button.settings-dropdown-button) {
  min-height: 24px;
  border-color: transparent;
  padding: 2px 6px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-sm);
}

.composer-meta-dropdown :deep(button.settings-dropdown-button:hover:not(:disabled)),
.composer-meta-dropdown :deep(button.settings-dropdown-button[aria-expanded='true']),
.composer-meta-dropdown :deep(button.settings-dropdown-button:focus-visible),
.composer-meta-dropdown :deep(button.settings-dropdown-button:active) {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
}

.composer-meta-dropdown :deep(.settings-dropdown-panel) {
  top: auto;
  bottom: calc(100% + 4px);
  width: 100%;
}

.composer-channel-dropdown {
  width: min(174px, 25vw);
  min-width: 132px;
}

.composer-channel-dropdown :deep(.settings-dropdown-panel) {
  width: 100%;
  min-width: 100%;
}

.composer-channel-dropdown :deep(.settings-dropdown-option-row.has-option-action .project-option) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.channel-model-toggle {
  width: 30px;
  min-width: 30px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
}

.channel-model-toggle:hover:not(:disabled),
.channel-model-toggle:focus-visible,
.channel-model-toggle.is-open {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.channel-model-toggle:disabled {
  opacity: 0.42;
  cursor: default;
}

.channel-model-toggle-caret {
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 0.16s ease;
}

.channel-model-toggle.is-open .channel-model-toggle-caret {
  transform: rotate(135deg);
}

.channel-model-panel {
  position: fixed;
  z-index: 60;
  overflow: hidden;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-editor-background);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
}

.channel-model-panel-title {
  min-height: 42px;
  padding: var(--space-2);
  border-bottom: 1px solid var(--vscode-panel-border);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}

.channel-model-panel-title span {
  min-width: 0;
  overflow: hidden;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.channel-model-panel-title small {
  min-width: 0;
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.channel-model-list {
  height: calc(100% - 42px);
  border: 0;
  border-radius: 0;
  background: transparent;
}

.channel-model-list :deep(.settings-selectable-filter) {
  min-height: 28px;
}

.channel-model-list :deep(.settings-selectable-filter input) {
  min-height: 26px;
}

.channel-model-list :deep(.settings-selectable-shell) {
  min-height: 0;
}

.channel-model-list :deep(.settings-selectable-scroll) {
  min-height: 0;
}

.channel-model-list :deep(.settings-selectable-items) {
  padding: var(--space-1);
}

.channel-model-list :deep(.settings-selectable-item) {
  min-height: 42px;
  grid-template-columns: minmax(0, 1fr);
}

.composer-meta-dropdown :deep(.settings-dropdown-caret) {
  color: currentColor;
}

.composer-runtime-tooltip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  margin-left: var(--space-1);
}

.composer-runtime-badge {
  min-width: 34px;
  min-height: 22px;
  padding: 1px 6px;
  border: 1px solid var(--vscode-panel-border, transparent);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  line-height: 1;
  letter-spacing: 0.03em;
}

.composer-runtime-badge.is-websocket {
  color: var(--vscode-foreground);
  border-color: var(--vscode-descriptionForeground);
}

.composer-runtime-badge.is-reload-required {
  color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
  border-color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
}

.composer-runtime-badge:hover,
.composer-runtime-badge:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.composer-token-usage {
  flex: 0 0 auto;
  margin-left: var(--space-1);
}

.composer-send,
.composer-compact {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 30px;
  padding: 0;
  color: var(--vscode-foreground);
  background: transparent;
  border-color: transparent;
}

.composer-send:hover:not(:disabled),
.composer-compact:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.composer-send:disabled,
.composer-compact:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  border-color: transparent;
  opacity: 0.55;
  cursor: not-allowed;
}

.composer-send-icon,
.composer-compact-icon {
  width: 16px;
  height: 16px;
  color: currentColor;
  pointer-events: none;
}

.composer-compact-icon path {
  fill: currentColor;
}

.composer-compact.is-compacting,
.composer-compact-icon.is-compacting {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.composer-compact-icon.is-compacting .composer-compact-icon-top {
  animation: composer-compact-squeeze-top 1.1s ease-in-out infinite;
  transform-origin: 12px 8px;
}

.composer-compact-icon.is-compacting .composer-compact-icon-bottom {
  animation: composer-compact-squeeze-bottom 1.1s ease-in-out infinite;
  transform-origin: 12px 16px;
}

@keyframes composer-compact-squeeze-top {
  0%, 100% { transform: translateY(-1px); }
  50% { transform: translateY(2px); }
}

@keyframes composer-compact-squeeze-bottom {
  0%, 100% { transform: translateY(1px); }
  50% { transform: translateY(-2px); }
}
.composer-work-directory {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.composer-work-directory.has-error {
  color: var(--vscode-errorForeground);
}
</style>
