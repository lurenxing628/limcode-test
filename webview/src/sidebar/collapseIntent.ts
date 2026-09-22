/**
 * 侧边栏折叠意图管理
 *
 * 区分"用户显式折叠"与"持久化展开集合"，使两条自动展开路径都尊重用户的折叠意图。
 * SidebarApp.vue 通过本模块维护 expandedConversationIds / userCollapsedConversationIds。
 */

import {
  flattenConversationHistoryForest,
  summarizeDescendantAgents,
  type ConversationHistoryDescendantAgentSummary,
  type ConversationHistoryTreeNode
} from '@shared/conversationHistoryTree';
import type { ConversationOriginLinkRecord } from '@shared/protocol';

export interface VisibleHistoryNode {
  entry: ConversationHistoryTreeNode['entry'];
  originLink?: ConversationOriginLinkRecord;
  parentConversationId?: string;
  depth: number;
  visualDepth: number;
  childCount: number;
  hasChildren: boolean;
  expanded: boolean;
  descendantAgents: ConversationHistoryDescendantAgentSummary;
}

export interface ExpandResult {
  expandedIds: Set<string>;
  changed: boolean;
}

export interface ToggleResult {
  expandedIds: Set<string>;
  userCollapsedIds: Set<string>;
}

/** 展平整棵森林，用于查找节点与祖先链。 */
export function allHistoryNodes(forest: readonly ConversationHistoryTreeNode[]): ConversationHistoryTreeNode[] {
  return flattenConversationHistoryForest(forest);
}

/** 收集运行中的子 Agent 会话 ID（originKind === 'agent' 且正在运行）。 */
export function runningAgentConversationIds(
  nodes: readonly ConversationHistoryTreeNode[]
): Set<string> {
  return new Set(nodes
    .filter((node) => node.originLink?.originKind === 'agent')
    .filter((node) => node.entry.runState === 'running' || node.entry.isRunning)
    .map((node) => node.entry.id));
}

/**
 * 为新出现的运行中子 Agent 展开祖先，遇到用户显式折叠的祖先即停止向上。
 */
export function expandNewlyActiveAgentAncestors(options: {
  nodes: readonly ConversationHistoryTreeNode[];
  expandedIds: ReadonlySet<string>;
  userCollapsedIds: ReadonlySet<string>;
  previouslyActiveAgentIds: ReadonlySet<string>;
}): ExpandResult {
  const { nodes, expandedIds, userCollapsedIds, previouslyActiveAgentIds } = options;
  const nodeById = new Map(nodes.map((node) => [node.entry.id, node]));
  const newlyActiveIds = [...runningAgentConversationIds(nodes)]
    .filter((id) => !previouslyActiveAgentIds.has(id));
  if (newlyActiveIds.length === 0) return { expandedIds: new Set(expandedIds), changed: false };

  const nextExpanded = new Set(expandedIds);
  let changed = false;
  for (const activeId of newlyActiveIds) {
    let node = nodeById.get(activeId);
    while (node?.parentConversationId) {
      // 用户显式折叠过的祖先保持折叠，不再被自动展开覆盖
      if (userCollapsedIds.has(node.parentConversationId)) break;
      if (!nextExpanded.has(node.parentConversationId)) {
        nextExpanded.add(node.parentConversationId);
        changed = true;
      }
      node = nodeById.get(node.parentConversationId);
    }
  }
  return { expandedIds: nextExpanded, changed };
}

/**
 * 为当前激活会话展开祖先，遇到用户显式折叠的祖先即停止向上。
 */
export function expandActiveConversationAncestors(options: {
  nodes: readonly ConversationHistoryTreeNode[];
  activeConversationId: string | undefined;
  expandedIds: ReadonlySet<string>;
  userCollapsedIds: ReadonlySet<string>;
  alreadyAutoExpandedId: string | undefined;
}): ExpandResult & { autoExpandedId: string | undefined } {
  const { nodes, activeConversationId, expandedIds, userCollapsedIds, alreadyAutoExpandedId } = options;
  if (!activeConversationId || activeConversationId === alreadyAutoExpandedId) {
    return { expandedIds: new Set(expandedIds), changed: false, autoExpandedId: alreadyAutoExpandedId };
  }

  const nodeById = new Map(nodes.map((node) => [node.entry.id, node]));
  let node = nodeById.get(activeConversationId);
  if (!node) {
    return { expandedIds: new Set(expandedIds), changed: false, autoExpandedId: alreadyAutoExpandedId };
  }

  const nextExpanded = new Set(expandedIds);
  let changed = false;
  while (node.parentConversationId) {
    // 用户显式折叠过的祖先保持折叠
    if (userCollapsedIds.has(node.parentConversationId)) break;
    if (!nextExpanded.has(node.parentConversationId)) {
      nextExpanded.add(node.parentConversationId);
      changed = true;
    }
    const parent = nodeById.get(node.parentConversationId);
    if (!parent) break;
    node = parent;
  }
  return { expandedIds: nextExpanded, changed, autoExpandedId: activeConversationId };
}

/**
 * 用户手动切换折叠状态：折叠记录显式意图，展开清除该意图。
 */
export function toggleHistoryNode(options: {
  conversationId: string;
  expandedIds: ReadonlySet<string>;
  userCollapsedIds: ReadonlySet<string>;
}): ToggleResult {
  const { conversationId, expandedIds, userCollapsedIds } = options;
  const nextExpanded = new Set(expandedIds);
  const nextCollapsed = new Set(userCollapsedIds);
  if (nextExpanded.has(conversationId)) {
    nextExpanded.delete(conversationId);
    nextCollapsed.add(conversationId);
  } else {
    nextExpanded.add(conversationId);
    nextCollapsed.delete(conversationId);
  }
  return { expandedIds: nextExpanded, userCollapsedIds: nextCollapsed };
}

/** 按展开集合展平可见节点，折叠节点的后代不渲染。 */
export function flattenVisibleHistoryNodes(options: {
  forest: readonly ConversationHistoryTreeNode[];
  expandedIds: ReadonlySet<string>;
  maxVisualDepth: number;
}): VisibleHistoryNode[] {
  const { forest, expandedIds, maxVisualDepth } = options;
  const result: VisibleHistoryNode[] = [];
  const append = (node: ConversationHistoryTreeNode, depth: number): void => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && expandedIds.has(node.entry.id);
    result.push({
      entry: node.entry,
      ...(node.originLink ? { originLink: node.originLink } : {}),
      ...(node.parentConversationId ? { parentConversationId: node.parentConversationId } : {}),
      depth,
      visualDepth: Math.min(depth, maxVisualDepth),
      childCount: node.children.length,
      hasChildren,
      expanded,
      descendantAgents: summarizeDescendantAgents(node)
    });
    if (!expanded) return;
    for (const child of node.children) append(child, depth + 1);
  };
  for (const root of forest) append(root, 0);
  return result;
}

/** 从持久化状态读取折叠意图，缺失该字段时按空集合处理。 */
export function userCollapsedIdsFromState(state: {
  userCollapsedConversationIds?: readonly string[];
}): Set<string> {
  const raw = state.userCollapsedConversationIds;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((id): id is string => typeof id === 'string' && id.length > 0));
}

/** 排序后的数组形式，便于持久化比较。 */
export function sortedIds(ids: ReadonlySet<string>): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/** 合并部分更新到侧边栏 host state，保留未传入字段。 */
export function mergeSidebarHostState(
  existing: {
    expandedConversationIds: string[];
    favoriteConversationIds: string[];
    userCollapsedConversationIds?: string[];
  },
  partial: {
    expandedConversationIds?: string[];
    favoriteConversationIds?: string[];
    userCollapsedConversationIds?: Set<string>;
  }
) {
  return {
    expandedConversationIds: partial.expandedConversationIds ?? existing.expandedConversationIds,
    favoriteConversationIds: partial.favoriteConversationIds ?? existing.favoriteConversationIds,
    userCollapsedConversationIds:
      partial.userCollapsedConversationIds !== undefined
        ? sortedIds(partial.userCollapsedConversationIds)
        : existing.userCollapsedConversationIds ?? []
  };
}

/** 兼容旧状态（缺失 userCollapsedConversationIds 字段）。 */
export function normalizeUserCollapsedIds(state: {
  userCollapsedConversationIds?: readonly string[];
}): Set<string> {
  return userCollapsedIdsFromState(state);
}
