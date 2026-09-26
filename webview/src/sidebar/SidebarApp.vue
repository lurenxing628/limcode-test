<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { IconAdjustmentsAlt, IconChevronRight, IconEdit, IconListDetails, IconMessage, IconPlayerStop, IconRobot, IconSettings, IconStar, IconStarFilled, IconTrash } from '@tabler/icons-vue';
import type {
  ConversationHistoryPageInfo,
  ConversationHistoryPageRecord,
  ConversationOriginLinkRecord,
  OpenConversationPanelRecord
} from '@shared/protocol';
import { createMessageId } from '@shared/protocol';
import { displayConversationTitle as formatConversationTitle } from '@shared/conversationTitle';
import {
  buildConversationHistoryForest,
  flattenConversationHistoryForest,
  selectConversationOriginLinks,
  summarizeDescendantAgents,
  type ConversationHistoryDescendantAgentSummary,
  type ConversationHistoryTreeNode
} from '@shared/conversationHistoryTree';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import {
  onSidebarMessage,
  postSidebarMessage,
  readSidebarHostState,
  writeSidebarHostState,
  getPersistedSidebarHostState
} from './sidebarHost';
import {
  SIDEBAR_MESSAGE,
  type ConversationHistoryScope,
  type ProjectFolderCandidateRecord,
  type SidebarHistoryScopeKind,
  type SidebarConversationHistoryEntry
} from './types';
import {
  expandNewlyActiveAgentAncestors,
  expandActiveConversationAncestors,
  toggleHistoryNode as toggleHistoryNodeIntent,
  flattenVisibleHistoryNodes as flattenVisibleHistoryNodesWithIntent,
  userCollapsedIdsFromState,
  allHistoryNodes,
  runningAgentConversationIds,
  sortedIds,
  type VisibleHistoryNode
} from './collapseIntent';

type SidebarView = 'history' | 'settings' | 'projectPicker';
interface ScopeOption {
  key: string;
  label: string;
  description?: string;
  scopeKind: SidebarHistoryScopeKind;
  projectFolderUri?: string;
}

interface VisibleHistoryTreeNode {
  entry: SidebarConversationHistoryEntry;
  originLink?: ConversationOriginLinkRecord;
  parentConversationId?: string;
  depth: number;
  visualDepth: number;
  childCount: number;
  hasChildren: boolean;
  expanded: boolean;
  descendantAgents: ConversationHistoryDescendantAgentSummary;
}

const PAGE_SIZE = 50;
const MAX_VISUAL_TREE_DEPTH = 8;
const SCOPE_PAGE_SIZE = 3;
const view = ref<SidebarView>('history');
const historyReady = ref(false);
const entries = ref<SidebarConversationHistoryEntry[]>([]);
const originLinks = ref<ConversationOriginLinkRecord[]>([]);
const deletingConversationIds = ref<Set<string>>(new Set());
const removedConversationIds = ref<Set<string>>(new Set());
const abortingConversationIds = ref<Set<string>>(new Set());
const abortRequests = ref<Record<string, {
  requestId: string;
  turnId: string;
  leaseGeneration: string;
}>>({});
const operationNotice = ref<{ text: string; kind: 'info' | 'error' }>();
const initialHostState = readSidebarHostState();
const expandedConversationIds = ref<Set<string>>(new Set(initialHostState.expandedConversationIds));
const userCollapsedConversationIds = ref<Set<string>>(userCollapsedIdsFromState(initialHostState));
const favoriteConversationIds = ref<Set<string>>(new Set(initialHostState.favoriteConversationIds));
const favoritesViewActive = ref(false);
const projectFolders = ref<ProjectFolderCandidateRecord[]>([]);
const activeScopeKind = ref<SidebarHistoryScopeKind>('currentProject');
const activeProjectFolderUri = ref<string | undefined>();
const currentProjectScope = ref<ConversationHistoryScope>({ kind: 'all' });
const openConversations = ref<OpenConversationPanelRecord[]>([]);
const pageInfo = ref<ConversationHistoryPageInfo>();
const scopePageIndex = ref(0);
const renameTarget = ref<SidebarConversationHistoryEntry>();
const deleteTarget = ref<SidebarConversationHistoryEntry>();
const abortTarget = ref<SidebarConversationHistoryEntry>();
const historyList = ref<HTMLElement | null>(null);
const visibleEntries = computed(() => entries.value.filter((entry) =>
  !deletingConversationIds.value.has(entry.id) && !removedConversationIds.value.has(entry.id)
  // 功能3:空会话不显示;但正在运行的会话即使暂无消息也保留,避免误藏进行中会话
  && (entry.messageCount > 0 || entry.isRunning)
));
// 收藏是纯显示层:切到收藏视图时在当前已加载条目内按收藏集过滤,最近时间排序;不影响原分区排序
const displayEntries = computed(() => {
  if (!favoritesViewActive.value) return visibleEntries.value;
  return visibleEntries.value
    .filter((entry) => favoriteConversationIds.value.has(entry.id))
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt);
});
const historyForest = computed(() => buildConversationHistoryForest(displayEntries.value, originLinks.value));
const originLinkByConversationId = computed(() => selectConversationOriginLinks(originLinks.value));
const visibleHistoryNodes = computed(() => flattenVisibleHistoryNodesWithIntent({
  forest: historyForest.value,
  expandedIds: expandedConversationIds.value,
  maxVisualDepth: MAX_VISUAL_TREE_DEPTH
}));
const historyScrollbarRefreshKey = computed(() => `${visibleEntries.value.length}:${visibleHistoryNodes.value.length}`);
const historyCountText = computed(() => {
  if (!historyReady.value) return "正在加载对话...";
  // 收藏视图只反映当前已加载页内被收藏的条目数;其他视图按后端分页 total 统计
  if (favoritesViewActive.value) {
    return `${displayEntries.value.length} 个收藏 · 当前页`;
  }
  // 待删除隐藏数只统计真正因删除/移除被隐藏的条目,不把空会话过滤算进去,避免低估总数
  const hiddenPendingDeletes = entries.value.filter((entry) =>
    deletingConversationIds.value.has(entry.id) || removedConversationIds.value.has(entry.id)
  ).length;
  const total = Math.max(0, (pageInfo.value?.total ?? entries.value.length) - hiddenPendingDeletes);
  const page = pageInfo.value ? `第 ${pageInfo.value.pageIndex + 1} 页` : "当前页";
  return `${total} 个对话 · ${page}`;
});
const currentScopeLabel = computed(() => currentProjectScope.value.kind === 'all' ? '全部历史'
  : currentProjectScope.value.kind === 'unbound' ? '未绑定' : '当前项目');
const activeScopeKey = computed(() => favoritesViewActive.value ? 'favorites' : scopeOptionKey(activeScopeKind.value, activeProjectFolderUri.value));
const scopeOptions = computed<ScopeOption[]>(() => {
  const options: ScopeOption[] = [
    { key: 'favorites', label: '⭐ 收藏', scopeKind: 'all' },
    { key: 'currentProject', label: currentScopeLabel.value, scopeKind: 'currentProject' },
    { key: 'all', label: '全部历史', scopeKind: 'all' },
    { key: 'unbound', label: '未绑定', scopeKind: 'unbound' }
  ];

  for (const folder of projectFolders.value) {
    const path = displayProjectUri(folder.uri);
    options.push({
      key: scopeOptionKey('project', folder.uri),
      label: folder.name || path,
      description: middleEllipsis(path, 48),
      scopeKind: 'project',
      projectFolderUri: folder.uri
    });
  }

  return options;
});
const pagedScopeOptions = computed(() => {
  const pages: ScopeOption[][] = [];
  for (let index = 0; index < scopeOptions.value.length; index += SCOPE_PAGE_SIZE) {
    pages.push(scopeOptions.value.slice(index, index + SCOPE_PAGE_SIZE));
  }
  return pages;
});
const scopePageCount = computed(() => Math.max(1, pagedScopeOptions.value.length));
const safeScopePageIndex = computed(() => Math.min(scopePageIndex.value, scopePageCount.value - 1));
const visibleScopeOptions = computed(() => {
  const safeIndex = safeScopePageIndex.value;
  return scopeOptions.value.slice(safeIndex * SCOPE_PAGE_SIZE, (safeIndex + 1) * SCOPE_PAGE_SIZE);
});
const activeVisibleScopeIndex = computed(() => visibleScopeOptions.value.findIndex((option) => option.key === activeScopeKey.value));
const scopeTrackStyle = computed(() => ({
  transform: `translateX(-${safeScopePageIndex.value * 100}%)`
}));
const scopeIndicatorStyle = computed(() => {
  const index = activeVisibleScopeIndex.value;
  return {
    left: index >= 0 ? `calc(${(100 / SCOPE_PAGE_SIZE) * index}% + 8px)` : '8px',
    width: `calc(${100 / SCOPE_PAGE_SIZE}% - 16px)`,
    opacity: index >= 0 ? '1' : '0'
  };
});
const canPreviousScopePage = computed(() => safeScopePageIndex.value > 0);
const canNextScopePage = computed(() => safeScopePageIndex.value + 1 < scopePageCount.value);
const isRenameDialogOpen = computed(() => !!renameTarget.value);
const isDeleteDialogOpen = computed(() => !!deleteTarget.value);
const isAbortDialogOpen = computed(() => !!abortTarget.value);
const renameInitialTitle = computed(() => renameTarget.value?.title ?? '');
const renameDialogDescription = computed(() => {
  const title = displayConversationTitle(renameTarget.value);
  return title ? `为「${middleEllipsis(title, 48)}」输入新的对话标题。` : '输入新的对话标题。';
});
const deleteDialogDescriptionHtml = computed(() => {
  const title = displayConversationTitle(deleteTarget.value);
  const target = title ? `「${escapeHtml(middleEllipsis(title, 48))}」` : '这个对话';
  return `将删除${target}、其启动的所有子 Agent 对话，以及关联消息、工具记录和运行记录。此操作<strong>无法撤销</strong>。`;
});
const abortDialogDescriptionHtml = computed(() => {
  const title = displayConversationTitle(abortTarget.value);
  const target = title ? `「${escapeHtml(middleEllipsis(title, 48))}」` : '这个对话';
  const childAgent = abortTarget.value
    ? originLinkByConversationId.value.get(abortTarget.value.id)?.originKind === 'agent'
    : false;
  if (childAgent) {
    return `确定终止${target}吗？将同时终止此子 Agent 及其启动的所有子 Agent，<strong>不会删除对话记录</strong>。`;
  }
  return `确定终止${target}的后台任务吗？只终止当前后台运行任务，<strong>不会删除对话记录</strong>。`;
});
const deleteConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '删除' }
];
const abortConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '终止' }
];

let disposeMessages: (() => void) | undefined;
let currentHistoryPageIdentity = '';
let autoExpandedActiveConversationId: string | undefined;
let activeAgentConversationIds = new Set<string>();
let operationNoticeTimer: ReturnType<typeof setTimeout> | undefined;

onMounted(() => {
  disposeMessages = onSidebarMessage((message) => {
    if (message.type === SIDEBAR_MESSAGE.conversationOperationResult) {
      if (
        message.operation === 'abort'
        && (!message.requestId || abortRequests.value[message.conversationId]?.requestId !== message.requestId)
      ) return;
      setConversationOperationPending(message.operation, message.conversationId, false);
      if (message.operation === 'abort') clearAbortRequest(message.conversationId);
      if (message.operation === 'delete' && message.ok) {
        const next = new Set(removedConversationIds.value);
        const deletedConversationIds = Array.isArray(message.deletedConversationIds)
          ? message.deletedConversationIds
          : [message.conversationId];
        for (const deletedConversationId of deletedConversationIds) next.add(deletedConversationId);
        removedConversationIds.value = next;
      }
      const text = message.message
        ?? (message.operation === 'delete'
          ? '对话已删除。'
          : message.status === 'already_satisfied'
            ? '目标任务已经结束，无需再次终止。'
            : '后台任务已终止。');
      showOperationNotice(text, message.ok ? 'info' : 'error');
      return;
    }
    if (message.type !== SIDEBAR_MESSAGE.state) return;
    historyReady.value = true;
    const nextScopeKind = favoritesViewActive.value ? activeScopeKind.value : (message.activeScopeKind ?? activeScopeKind.value);
    const nextPageIdentity = historyPageIdentity(message.history);
    if (nextPageIdentity !== currentHistoryPageIdentity) {
      currentHistoryPageIdentity = nextPageIdentity;
      autoExpandedActiveConversationId = undefined;
    }
    entries.value = Array.isArray(message.history?.entries) ? message.history.entries : [];
    for (const entry of entries.value) {
      if (!entry.isRunning && abortingConversationIds.value.has(entry.id)) {
        setConversationOperationPending('abort', entry.id, false);
        clearAbortRequest(entry.id);
      }
    }
    originLinks.value = Array.isArray(message.history?.originLinks) ? message.history.originLinks : [];
    pageInfo.value = message.history?.pageInfo;
    activeScopeKind.value = nextScopeKind;
    if (message.activeProjectFolderUri !== undefined) activeProjectFolderUri.value = message.activeProjectFolderUri;
    else if (nextScopeKind !== 'project') activeProjectFolderUri.value = undefined;
    currentProjectScope.value = message.currentProjectScope ?? currentProjectScope.value;
    projectFolders.value = Array.isArray(message.projectFolders) ? message.projectFolders : [];
    openConversations.value = Array.isArray(message.openConversations) ? message.openConversations : [];
    ensureActiveScopeVisible();
    ensureActiveConversationAncestorsExpanded();
    ensureNewActiveAgentAncestorsExpanded();
  });
  postSidebarMessage({ type: SIDEBAR_MESSAGE.ready });
});

onBeforeUnmount(() => {
  disposeMessages?.();
  if (operationNoticeTimer !== undefined) clearTimeout(operationNoticeTimer);
});

function setView(next: SidebarView): void {
  view.value = next;
}

function openConversation(entry: SidebarConversationHistoryEntry): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.openConversation, conversationId: entry.id, title: displayConversationTitle(entry) });
}

function requestHistoryPage(
  scopeKind: SidebarHistoryScopeKind = activeScopeKind.value,
  cursor?: string,
  projectFolderUri = activeProjectFolderUri.value
): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.historyPageGet, scopeKind, projectFolderUri, cursor, limit: PAGE_SIZE });
}

function switchScope(option: ScopeOption): void {
  if (option.key === 'favorites') {
    favoritesViewActive.value = true;
    return; // 收藏在当前已加载条目内本地筛选,不发分页请求
  }
  favoritesViewActive.value = false;
  activeScopeKind.value = option.scopeKind;
  activeProjectFolderUri.value = option.projectFolderUri;
  requestHistoryPage(option.scopeKind, undefined, option.projectFolderUri);
}

function nextPage(): void {
  if (!pageInfo.value?.nextCursor) return;
  requestHistoryPage(activeScopeKind.value, pageInfo.value.nextCursor, activeProjectFolderUri.value);
}

function previousPage(): void {
  if (!pageInfo.value?.previousCursor) return;
  requestHistoryPage(activeScopeKind.value, pageInfo.value.previousCursor, activeProjectFolderUri.value);
}

function nextScopePage(): void {
  if (!canNextScopePage.value) return;
  scopePageIndex.value += 1;
}

function previousScopePage(): void {
  if (!canPreviousScopePage.value) return;
  scopePageIndex.value -= 1;
}

function startNewConversation(): void {
  if (projectFolders.value.length > 1) {
    setView('projectPicker');
    return;
  }
  createNewConversation();
}

function createNewConversation(projectFolderUri?: string): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.newConversation, ...(projectFolderUri ? { projectFolderUri } : {}) });
  setView('history');
}

function openGlobalSettings(): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.openGlobalSettings });
}

function openWorkflowSettings(): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.openWorkflowSettings });
}

function openAgentSettings(): void {
  postSidebarMessage({ type: SIDEBAR_MESSAGE.openAgentSettings });
}

function renameConversation(entry: SidebarConversationHistoryEntry): void {
  renameTarget.value = entry;
}

function confirmRenameConversation(title: string): void {
  const target = renameTarget.value;
  renameTarget.value = undefined;
  const nextTitle = title.trim();
  if (!target || !nextTitle) return;
  if (nextTitle === target.title.trim()) return;
  postSidebarMessage({ type: SIDEBAR_MESSAGE.renameConversation, conversationId: target.id, title: nextTitle });
}

function closeRenameDialog(): void {
  renameTarget.value = undefined;
}

function deleteConversation(entry: SidebarConversationHistoryEntry): void {
  deleteTarget.value = entry;
}

function confirmDeleteConversation(): void {
  const target = deleteTarget.value;
  deleteTarget.value = undefined;
  if (!target) return;
  setConversationOperationPending('delete', target.id, true);
  postSidebarMessage({ type: SIDEBAR_MESSAGE.deleteConversation, conversationId: target.id });
}

function closeDeleteDialog(): void {
  deleteTarget.value = undefined;
}

function abortConversation(entry: SidebarConversationHistoryEntry): void {
  abortTarget.value = entry;
}

function confirmAbortConversation(): void {
  const target = abortTarget.value;
  abortTarget.value = undefined;
  if (!target) return;
  const existing = abortRequests.value[target.id];
  if (!existing && (!target.activeTurnId || !target.executionLeaseGeneration)) {
    showOperationNotice('运行身份已变化，请等待列表刷新后重试。', 'error');
    return;
  }
  const request = existing ?? {
    requestId: createMessageId(),
    turnId: target.activeTurnId!,
    leaseGeneration: target.executionLeaseGeneration!
  };
  setConversationOperationPending('abort', target.id, true);
  abortRequests.value = { ...abortRequests.value, [target.id]: request };
  postSidebarMessage({
    type: SIDEBAR_MESSAGE.abortConversation,
    conversationId: target.id,
    ...request
  });
}

function closeAbortDialog(): void {
  abortTarget.value = undefined;
}

function toggleHistoryNode(node: VisibleHistoryNode): void {
  if (!node.hasChildren) return;
  const result = toggleHistoryNodeIntent({
    conversationId: node.entry.id,
    expandedIds: expandedConversationIds.value,
    userCollapsedIds: userCollapsedConversationIds.value
  });
  expandedConversationIds.value = result.expandedIds;
  userCollapsedConversationIds.value = result.userCollapsedIds;
  persistExpandedConversationIds();
}

function onHistoryItemKeydown(event: KeyboardEvent, node: VisibleHistoryNode): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openConversation(node.entry);
    return;
  }
  if (event.key === 'ArrowRight' && node.hasChildren && !node.expanded) {
    event.preventDefault();
    toggleHistoryNode(node);
    return;
  }
  if (event.key === 'ArrowLeft' && node.hasChildren && node.expanded) {
    event.preventDefault();
    toggleHistoryNode(node);
  }
}

function statusClass(entry: SidebarConversationHistoryEntry): string {
  if (entry.runState === 'awaiting_parent') return 'status-streaming';
  if (entry.runState === 'delivery_failed' || entry.runState === 'interrupted') return 'status-partial';
  if (entry.runState === 'completed') return 'status-final';
  if (entry.isRunning) return 'status-running';
  if (entry.status === 'streaming') return 'status-streaming';
  if (entry.status === 'final') return 'status-final';
  if (entry.status === 'partial') return 'status-partial';
  return 'status-empty';
}

function statusText(entry: SidebarConversationHistoryEntry): string {
  if (abortingConversationIds.value.has(entry.id)) return '正在终止后台任务';
  const childAgentConversation = originLinkByConversationId.value.get(entry.id)?.originKind === 'agent';
  if (childAgentConversation) {
    if (entry.runState === 'running') return `子 Agent：${entry.runStatusLabel || '运行中'}`;
    if (entry.runState === 'awaiting_parent') return '子 Agent：等待主 Agent 处理';
    if (entry.runState === 'delivery_failed') return '子 Agent：回答发送失败';
    if (entry.runState === 'interrupted') return '子 Agent 已中断';
    if (entry.runState === 'completed') return '子 Agent 已完成';
  }
  if (entry.isRunning) return childAgentConversation
    ? `子 Agent：${entry.runStatusLabel || '运行中'}`
    : `后台任务：${entry.runStatusLabel || '执行中'}`;
  if (entry.status === 'streaming') return childAgentConversation ? '子 Agent 正在回复' : '正在回复';
  if (entry.status === 'final') return childAgentConversation ? '子 Agent 已完成' : '已完成';
  if (entry.status === 'partial') return childAgentConversation ? '子 Agent 的回复未完成' : '回复未完成';
  return childAgentConversation ? '子 Agent 尚未开始' : '暂无消息';
}

function showRunBadge(entry: SidebarConversationHistoryEntry): boolean {
  if (entry.isRunning) return true;
  return entry.runState === 'awaiting_parent'
    || entry.runState === 'delivery_failed'
    || entry.runState === 'interrupted';
}

function runBadgeText(entry: SidebarConversationHistoryEntry): string {
  if (abortingConversationIds.value.has(entry.id)) return '正在终止';
  if (entry.runState === 'awaiting_parent') return '等待主 Agent 处理';
  if (entry.runState === 'delivery_failed') return '回答发送失败';
  if (entry.runState === 'interrupted') return '已中断';
  return entry.runStatusLabel || '执行中';
}

function runBadgeClass(entry: SidebarConversationHistoryEntry): string | undefined {
  if (entry.runState === 'awaiting_parent') return 'is-awaiting-parent';
  if (entry.runState === 'delivery_failed') return 'is-delivery-failed';
  if (entry.runState === 'interrupted') return 'is-interrupted';
  return undefined;
}

function abortActionLabel(entry: SidebarConversationHistoryEntry): string {
  if (abortingConversationIds.value.has(entry.id)) return '正在终止后台任务，点击可重发';
  return originLinkByConversationId.value.get(entry.id)?.originKind === 'agent'
    ? '终止此子 Agent 及其启动的所有子 Agent'
    : '终止后台任务';
}

function historyPreviewText(entry: SidebarConversationHistoryEntry): string {
  if (entry.preview) return entry.preview;
  return entry.messageCount > 0 ? '消息内容暂不可用。' : '暂无消息，点击继续对话。';
}

function isConversationOperationPending(entry: SidebarConversationHistoryEntry): boolean {
  return deletingConversationIds.value.has(entry.id);
}

function setConversationOperationPending(operation: 'delete' | 'abort', conversationId: string, pending: boolean): void {
  const source = operation === 'delete' ? deletingConversationIds : abortingConversationIds;
  const next = new Set(source.value);
  if (pending) next.add(conversationId);
  else next.delete(conversationId);
  source.value = next;
}

function clearAbortRequest(conversationId: string): void {
  if (!(conversationId in abortRequests.value)) return;
  const next = { ...abortRequests.value };
  delete next[conversationId];
  abortRequests.value = next;
}

function showOperationNotice(text: string, kind: 'info' | 'error'): void {
  operationNotice.value = { text, kind };
  if (operationNoticeTimer !== undefined) clearTimeout(operationNoticeTimer);
  operationNoticeTimer = setTimeout(() => {
    operationNotice.value = undefined;
    operationNoticeTimer = undefined;
  }, kind === 'error' ? 5000 : 2600);
}

function historyMeta(entry: SidebarConversationHistoryEntry): string {
  const project = activeScopeKind.value === 'all' && entry.projectName ? `${entry.projectName} · ` : '';
  return `${project}${entry.agentName || '默认 Agent'} · ${entry.messageCount || 0} 条消息 · ${formatTime(entry.updatedAt)}`;
}

function originBadgeText(entry: SidebarConversationHistoryEntry): string | undefined {
  const origin = originLinkByConversationId.value.get(entry.id);
  if (origin?.originKind === 'agent') return origin.sourceKind === 'toolCall' ? 'LLM 触发' : 'Agent 创建';
  if (origin?.originKind === 'system') return '系统创建';
  return undefined;
}

function displayConversationTitle(entry: SidebarConversationHistoryEntry | undefined): string {
  return entry ? formatConversationTitle({ id: entry.id, title: entry.title }) : '';
}

function openConversationState(entry: SidebarConversationHistoryEntry): OpenConversationPanelRecord | undefined {
  return openConversations.value.find((item) => item.conversationId === entry.id);
}

function openConversationClass(entry: SidebarConversationHistoryEntry): string | undefined {
  const state = openConversationState(entry);
  if (!state) return undefined;
  return state.visible || state.active ? 'is-open-visible' : 'is-open-hidden';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(value: number | undefined): string {
  if (!value) return '未开始';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未开始';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function displayProjectUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'file:') {
      const filePath = normalizeFilePath(decodeURIComponent(parsed.pathname));
      // UNC 项目（file://server/share/...）的主机名在 URL.host 里，不能只显示 pathname。
      return parsed.host && parsed.host !== 'localhost' ? `//${decodeURIComponent(parsed.host)}${filePath}` : filePath;
    }
  } catch {
    // keep raw uri
  }
  return uri || '';
}

function normalizeFilePath(path: string): string {
  if (!path) return '';
  const maybeDriveLetter = path.charAt(1);
  const maybeDriveSeparator = path.charAt(2);
  const hasWindowsDrivePrefix = path.charAt(0) === '/'
    && maybeDriveSeparator === ':'
    && maybeDriveLetter.toLowerCase() !== maybeDriveLetter.toUpperCase();
  return hasWindowsDrivePrefix ? path.slice(1) : path;
}

function middleEllipsis(value: string, maxLength: number): string {
  if (!value || value.length <= maxLength) return value || '';
  const keep = Math.max(4, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
}

function scopeOptionKey(scopeKind: SidebarHistoryScopeKind, projectFolderUri?: string): string {
  return scopeKind === 'project' ? `project:${projectFolderUri ?? ''}` : scopeKind;
}

function ensureActiveScopeVisible(): void {
  const index = scopeOptions.value.findIndex((option) => option.key === activeScopeKey.value);
  if (index < 0) return;
  scopePageIndex.value = Math.floor(index / SCOPE_PAGE_SIZE);
}



function ensureActiveConversationAncestorsExpanded(): void {
  const activeConversationId = openConversations.value.find((item) => item.active)?.conversationId;
  if (!activeConversationId) {
    autoExpandedActiveConversationId = undefined;
    return;
  }

  const result = expandActiveConversationAncestors({
    nodes: allHistoryNodes(historyForest.value),
    activeConversationId,
    expandedIds: expandedConversationIds.value,
    userCollapsedIds: userCollapsedConversationIds.value,
    alreadyAutoExpandedId: autoExpandedActiveConversationId
  });

  if (result.changed) {
    autoExpandedActiveConversationId = result.autoExpandedId;
    expandedConversationIds.value = result.expandedIds;
    persistExpandedConversationIds();
  }
}

function ensureNewActiveAgentAncestorsExpanded(): void {
  const nodes = allHistoryNodes(historyForest.value);
  const result = expandNewlyActiveAgentAncestors({
    nodes,
    expandedIds: expandedConversationIds.value,
    userCollapsedIds: userCollapsedConversationIds.value,
    previouslyActiveAgentIds: activeAgentConversationIds
  });

  activeAgentConversationIds = runningAgentConversationIds(nodes);

  if (result.changed) {
    expandedConversationIds.value = result.expandedIds;
    persistExpandedConversationIds();
  }
}

function persistExpandedConversationIds(): void {
  const persisted = getPersistedSidebarHostState();
  writeSidebarHostState({
    expandedConversationIds: sortedIds(expandedConversationIds.value),
    favoriteConversationIds: persisted.favoriteConversationIds,
    userCollapsedConversationIds: sortedIds(userCollapsedConversationIds.value)
  });
}

function persistFavorites(): void {
  const persisted = getPersistedSidebarHostState();
  writeSidebarHostState({
    expandedConversationIds: persisted.expandedConversationIds,
    favoriteConversationIds: sortedIds(favoriteConversationIds.value),
    userCollapsedConversationIds: persisted.userCollapsedConversationIds ?? []
  });
}

function toggleFavorite(entry: SidebarConversationHistoryEntry): void {
  const next = new Set(favoriteConversationIds.value);
  if (next.has(entry.id)) next.delete(entry.id);
  else next.add(entry.id);
  favoriteConversationIds.value = next;
  persistFavorites();
}

function isFavorite(entry: SidebarConversationHistoryEntry): boolean {
  return favoriteConversationIds.value.has(entry.id);
}

function descendantAgentSummaryText(summary: ConversationHistoryDescendantAgentSummary): string {
  const parts = [
    summary.running > 0 ? `${summary.running} 运行中` : '',
    summary.awaitingParent > 0 ? `${summary.awaitingParent} 待主 Agent 处理` : '',
    summary.interrupted > 0 ? `${summary.interrupted} 已中断` : '',
    summary.deliveryFailed > 0 ? `${summary.deliveryFailed} 回答发送失败` : ''
  ].filter(Boolean);
  return parts.join('，');
}

function hasDescendantAgentSummary(summary: ConversationHistoryDescendantAgentSummary): boolean {
  return summary.running + summary.awaitingParent + summary.interrupted + summary.deliveryFailed > 0;
}

function historyPageIdentity(history: ConversationHistoryPageRecord): string {
  const scope = history.scope.kind === 'project'
    ? `project:${history.scope.folderUri}`
    : history.scope.kind;
  return `${scope}:${history.pageInfo.cursor ?? history.pageInfo.pageIndex}`;
}

function historyNodeStyle(node: VisibleHistoryTreeNode): Record<string, string> {
  return { '--history-tree-depth': String(node.visualDepth) };
}
</script>

<template>
  <main class="sidebar-shell" :aria-busy="!historyReady">
    <section v-if="view === 'history'" class="view history-view" aria-label="对话历史">
      <div class="section-head">
        <div class="section-title-row">
          <div class="section-title-main">
            <div class="section-title">对话历史</div>
            <div class="section-count">{{ historyCountText }}</div>
          </div>
          <button type="button" class="icon-button settings-entry-button" title="设置" aria-label="设置" @click="setView('settings')">
            <IconAdjustmentsAlt class="settings-gear-icon" stroke="2" aria-hidden="true" />
          </button>
        </div>
        <div class="toolbar">
          <button type="button" class="primary-button" title="新建对话" :disabled="!historyReady" @click="startNewConversation">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            新对话
          </button>
        </div>
        <div class="history-scope-pager" aria-label="对话历史范围分页列表">
          <button
            type="button"
            class="scope-page-button"
            :disabled="!historyReady || !canPreviousScopePage"
            aria-label="上一组范围"
            title="上一组范围"
            @click="previousScopePage"
          >
            ‹
          </button>
          <div class="scope-viewport">
            <div class="scope-track" :style="scopeTrackStyle" role="tablist" aria-label="对话历史范围">
              <div v-for="(page, pageIndex) in pagedScopeOptions" :key="pageIndex" class="scope-list">
                <button
                  v-for="option in page"
                  :key="option.key"
                  type="button"
                  class="scope-tab"
                  :class="{ active: activeScopeKey === option.key }"
                  :disabled="!historyReady"
                  :title="option.description || option.label"
                  @click="switchScope(option)"
                >
                  <span class="scope-tab-label">{{ option.label }}</span>
                  <span v-if="option.description" class="scope-tab-desc">{{ option.description }}</span>
                </button>
              </div>
            </div>
            <span class="scope-indicator" :style="scopeIndicatorStyle" aria-hidden="true"></span>
          </div>
          <button
            type="button"
            class="scope-page-button"
            :disabled="!historyReady || !canNextScopePage"
            aria-label="下一组范围"
            title="下一组范围"
            @click="nextScopePage"
          >
            ›
          </button>
        </div>
      </div>

      <div v-if="operationNotice" class="operation-notice" :class="`is-${operationNotice.kind}`" role="status">
        {{ operationNotice.text }}
      </div>

      <div class="history-list-shell">
        <div v-if="!historyReady" class="history-initializing" role="status" aria-live="polite">
          <span class="history-initializing-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>正在连接本地运行时并读取当前工作区…</span>
        </div>
        <div v-else ref="historyList" class="history-list" role="tree" aria-label="分级对话历史">
          <div
            v-for="node in visibleHistoryNodes"
            :key="node.entry.id"
            class="history-item"
            :class="[
              { 'is-running': node.entry.isRunning, 'is-tree-child': node.depth > 0 },
              openConversationClass(node.entry)
            ]"
            :style="historyNodeStyle(node)"
            role="treeitem"
            tabindex="0"
            :data-conversation-id="node.entry.id"
            :aria-level="node.depth + 1"
            :aria-expanded="node.hasChildren ? node.expanded : undefined"
            :aria-label="`打开对话：${displayConversationTitle(node.entry)}`"
            @click="openConversation(node.entry)"
            @keydown="onHistoryItemKeydown($event, node)"
          >
            <span class="history-tree-guides" aria-hidden="true">
              <span
                v-for="level in node.visualDepth"
                :key="level"
                class="history-tree-guide"
                :style="{ left: `${11 + (level - 1) * 16}px` }"
              ></span>
            </span>
            <span class="history-open-strip" aria-hidden="true"></span>
            <button
              v-if="node.hasChildren"
              type="button"
              class="history-disclosure-button"
              tabindex="-1"
              :aria-label="`${node.expanded ? '折叠' : '展开'}“${displayConversationTitle(node.entry)}”的 ${node.childCount} 个子对话`"
              @click.stop="toggleHistoryNode(node)"
            >
              <IconChevronRight
                class="history-disclosure-icon lc-collapse-chevron"
                :class="{ 'is-expanded': node.expanded }"
                stroke="2"
                aria-hidden="true"
              />
            </button>
            <span v-else class="history-disclosure-placeholder" aria-hidden="true"></span>
            <div class="history-status" :aria-label="statusText(node.entry)">
              <span class="status-dot" :class="statusClass(node.entry)" aria-hidden="true"></span>
              <span class="history-status-tooltip" role="tooltip">{{ statusText(node.entry) }}</span>
            </div>
            <div class="history-main">
              <div class="history-title-row">
                <div class="history-title">{{ displayConversationTitle(node.entry) }}</div>
                <span v-if="originBadgeText(node.entry)" class="origin-badge">{{ originBadgeText(node.entry) }}</span>
              </div>
              <div class="history-preview" :class="{ 'is-pending': node.entry.previewState === 'pending', 'is-empty': node.entry.previewState === 'empty' }">{{ historyPreviewText(node.entry) }}</div>
              <div class="history-meta">
                <span>{{ historyMeta(node.entry) }}</span>
                <span v-if="showRunBadge(node.entry)" class="run-badge" :class="runBadgeClass(node.entry)" :aria-label="statusText(node.entry)">
                  <span class="run-badge-dot" aria-hidden="true"></span>
                  <span>{{ runBadgeText(node.entry) }}</span>
                </span>
                <span
                  v-if="node.hasChildren && !node.expanded && hasDescendantAgentSummary(node.descendantAgents)"
                  class="descendant-agent-summary"
                  :aria-label="`下级子 Agent：${descendantAgentSummaryText(node.descendantAgents)}`"
                >
                  <span v-if="node.descendantAgents.running" class="descendant-agent-count is-running">
                    {{ node.descendantAgents.running }} 运行
                  </span>
                  <span v-if="node.descendantAgents.awaitingParent" class="descendant-agent-count is-awaiting">
                    {{ node.descendantAgents.awaitingParent }} 待接收
                  </span>
                  <span v-if="node.descendantAgents.interrupted" class="descendant-agent-count is-interrupted">
                    {{ node.descendantAgents.interrupted }} 中断
                  </span>
                  <span v-if="node.descendantAgents.deliveryFailed" class="descendant-agent-count is-failed">
                    {{ node.descendantAgents.deliveryFailed }} 失败
                  </span>
                </span>
              </div>
            </div>
            <div class="history-actions" @click.stop @keydown.stop>
              <button
                type="button"
                class="history-action-button"
                :class="{ 'is-favorite': isFavorite(node.entry) }"
                :title="isFavorite(node.entry) ? '取消收藏' : '收藏对话'"
                :aria-label="isFavorite(node.entry) ? '取消收藏' : '收藏对话'"
                :aria-pressed="isFavorite(node.entry)"
                :disabled="isConversationOperationPending(node.entry)"
                @click="toggleFavorite(node.entry)"
              >
                <IconStarFilled v-if="isFavorite(node.entry)" class="history-action-icon" stroke="2" aria-hidden="true" />
                <IconStar v-else class="history-action-icon" stroke="2" aria-hidden="true" />
              </button>
              <button type="button" class="history-action-button" title="重命名对话标题" aria-label="重命名对话标题" :disabled="isConversationOperationPending(node.entry)" @click="renameConversation(node.entry)">
                <IconEdit class="history-action-icon" stroke="2" aria-hidden="true" />
              </button>
              <button type="button" class="history-action-button" title="删除对话" aria-label="删除对话" :disabled="isConversationOperationPending(node.entry)" @click="deleteConversation(node.entry)">
                <IconTrash class="history-action-icon" stroke="2" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="history-action-button"
                :class="{ 'is-hidden': !node.entry.isRunning }"
                :disabled="!node.entry.isRunning || isConversationOperationPending(node.entry)"
                :aria-hidden="!node.entry.isRunning"
                :tabindex="node.entry.isRunning && !isConversationOperationPending(node.entry) ? 0 : -1"
                :title="abortActionLabel(node.entry)"
                :aria-label="abortActionLabel(node.entry)"
                @click="node.entry.isRunning && abortConversation(node.entry)"
              >
                <IconPlayerStop class="history-action-icon" stroke="2" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        <AdvancedScrollbar
          v-if="historyReady"
          class="history-edge-scrollbar"
          :scroller="historyList"
          :refresh-key="historyScrollbarRefreshKey"
        />
      </div>

      <div v-if="historyReady && !visibleEntries.length" class="empty-state">
        <p class="empty-state-title">暂无对话历史</p>
        <p class="empty-state-desc">点击“新对话”创建一个独立会话空间。</p>
      </div>

      <div v-if="historyReady" class="history-pagination" aria-label="对话历史分页">
        <button type="button" class="secondary-button" :disabled="!pageInfo?.hasPrevious" @click="previousPage">上一页</button>
        <span>第 {{ (pageInfo?.pageIndex ?? 0) + 1 }} 页</span>
        <button type="button" class="secondary-button" :disabled="!pageInfo?.hasNext" @click="nextPage">下一页</button>
      </div>
    </section>

    <section v-else-if="view === 'projectPicker'" class="view project-picker-view" aria-label="选择新对话归属项目">
      <div class="settings-head">
        <button type="button" class="back-button" title="返回对话历史" aria-label="返回对话历史" @click="setView('history')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <div class="settings-heading">
          <div class="settings-title">选择项目</div>
          <div class="settings-desc">新对话将绑定到所选根文件夹</div>
        </div>
      </div>
      <div class="settings-content">
        <p class="project-picker-intro">当前是多根工作区，请选择这个新对话属于哪个项目。</p>
        <div class="project-folder-list">
          <button
            v-for="folder in projectFolders"
            :key="folder.uri"
            type="button"
            class="project-folder-button"
            :title="displayProjectUri(folder.uri)"
            :aria-label="`选择项目：${folder.name}`"
            @click="createNewConversation(folder.uri)"
          >
            <span>{{ folder.name || displayProjectUri(folder.uri) }}</span>
            <span class="project-folder-path">{{ middleEllipsis(displayProjectUri(folder.uri), 72) }}</span>
          </button>
        </div>
        <div v-if="!projectFolders.length" class="empty-state">
          <p class="empty-state-title">暂无可选项目</p>
          <p class="empty-state-desc">当前窗口没有打开的工作区文件夹。</p>
        </div>
      </div>
    </section>

    <section v-else class="view settings-view" aria-label="设置导航">
      <div class="settings-head">
        <button type="button" class="back-button" title="返回对话历史" aria-label="返回对话历史" @click="setView('history')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <div class="settings-heading">
          <div class="settings-title">设置</div>
          <div class="settings-desc">选择要配置的范围</div>
        </div>
      </div>

      <div class="settings-content">
        <p class="settings-nav-intro">这个入口只负责导航到不同设置范围，具体配置仍在各自设置页中完成。</p>

        <nav class="settings-nav-list" aria-label="设置范围">
          <button type="button" class="settings-nav-card" @click="openGlobalSettings">
            <span class="settings-nav-icon" aria-hidden="true">
              <IconSettings class="settings-gear-icon" stroke="2" />
            </span>
            <span class="settings-nav-main">
              <span class="settings-nav-title">全局设置</span>
              <span class="settings-nav-desc">模型渠道、工具权限、数据目录与默认行为。</span>
            </span>
            <span class="settings-nav-trail">
              打开
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </span>
          </button>

          <button type="button" class="settings-nav-card" @click="openAgentSettings">
            <span class="settings-nav-icon" aria-hidden="true">
              <IconRobot class="settings-gear-icon" stroke="2" />
            </span>
            <span class="settings-nav-main">
              <span class="settings-nav-title">Agent 设置</span>
              <span class="settings-nav-desc">角色、角色提示词、能力上限与默认 LLM。</span>
            </span>
            <span class="settings-nav-trail">
              打开
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </span>
          </button>

          <button type="button" class="settings-nav-card" @click="openWorkflowSettings">
            <span class="settings-nav-icon" aria-hidden="true">
              <IconListDetails class="settings-gear-icon" stroke="2" />
            </span>
            <span class="settings-nav-main">
              <span class="settings-nav-title">工作流编辑</span>
              <span class="settings-nav-desc">查看和编辑内置及自定义工作流的高级 JSON 配置。</span>
            </span>
            <span class="settings-nav-trail">
              打开
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </span>
          </button>

          <button type="button" class="settings-nav-card is-disabled" disabled>
            <span class="settings-nav-icon" aria-hidden="true">
              <IconMessage class="settings-gear-icon" stroke="2" />
            </span>
            <span class="settings-nav-main">
              <span class="settings-nav-title">对话设置</span>
              <span class="settings-nav-desc">单个对话的名称、LLM 选择、工具策略与上下文配置。</span>
            </span>
            <span class="settings-nav-badge">即将支持</span>
          </button>
        </nav>

        <div class="settings-actions">
          <button type="button" class="secondary-button" @click="setView('history')">返回对话历史</button>
        </div>
      </div>
    </section>

    <InputPanel
      :open="isRenameDialogOpen"
      title="重命名对话"
      :description="renameDialogDescription"
      label="对话标题"
      :initial-value="renameInitialTitle"
      placeholder="输入新的对话标题"
      confirm-label="保存"
      @confirm="confirmRenameConversation"
      @cancel="closeRenameDialog"
    />

    <ConfirmPanel
      :open="isDeleteDialogOpen"
      title="删除对话？"
      :description-html="deleteDialogDescriptionHtml"
      :actions="deleteConfirmActions"
      @confirm="confirmDeleteConversation"
      @cancel="closeDeleteDialog"
    />

    <ConfirmPanel
      :open="isAbortDialogOpen"
      title="终止后台任务？"
      :description-html="abortDialogDescriptionHtml"
      :actions="abortConfirmActions"
      @confirm="confirmAbortConversation"
      @cancel="closeAbortDialog"
    />
  </main>
</template>
