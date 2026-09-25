import {
  isFunctionCallPart,
  TASK_LIST_ITEM_STATUSES,
  TASK_LIST_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  type MessageRecord,
  type TaskListItemStatus,
  type TaskListToolItemRecord,
  type TaskListToolMode,
  type TaskListToolOperationRecord,
  type ToolCallRecord
} from './protocol';

const TERMINAL_STATUSES = new Set<TaskListItemStatus>(['completed', 'cancelled']);

export const TASK_LIST_STATUS_LABELS: Record<TaskListItemStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '受阻',
  cancelled: '已取消'
};

export type TaskListChangeKind = 'added' | 'updated' | 'status_changed' | 'completed' | 'deleted' | 'rewritten';

export const TASK_LIST_CHANGE_LABELS: Record<TaskListChangeKind, string> = {
  added: '新增',
  updated: '更新',
  status_changed: '状态变更',
  completed: '完成',
  deleted: '删除',
  rewritten: '重写'
};

export interface TaskListItemView {
  key: string;
  title: string;
  description?: string;
  status: TaskListItemStatus;
  createdOrder: number;
  updatedOrder: number;
  sourceToolCallId?: string;
}

export interface TaskListChangeItemView extends TaskListItemView {
  changeKind?: TaskListChangeKind;
  previousStatus?: TaskListItemStatus;
  deleted?: boolean;
}

export interface TaskListStatsView {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  blocked: number;
  cancelled: number;
  open: number;
}

export interface TaskListSnapshotView {
  items: TaskListItemView[];
  stats: TaskListStatsView;
  activeItem?: TaskListItemView;
}

export interface TaskListTimelineEntry {
  toolCall: ToolCallRecord;
  operation: TaskListToolOperationRecord;
  snapshotBefore: TaskListSnapshotView;
  snapshotAfter: TaskListSnapshotView;
  changes: TaskListChangeItemView[];
}

export interface TaskListTimelineView {
  entries: TaskListTimelineEntry[];
  snapshot: TaskListSnapshotView;
}



export interface TaskListOrderInput {
  operationIndex: number;
  toolCallId: string;
}

export function buildTaskListTimeline(input: {
  messages: readonly MessageRecord[];
  toolCalls: readonly ToolCallRecord[];
  conversationId: string;
}): TaskListTimelineView {
  const calls = sortedTaskListToolCalls(input.messages, input.toolCalls, input.conversationId)
    .filter(isAppliedTaskListToolCall);
  const entries: TaskListTimelineEntry[] = [];
  let snapshot = emptyTaskListSnapshot();

  calls.forEach((toolCall, operationIndex) => {
    const operation = taskListOperationFromToolCall(toolCall, { allowArgsFallback: true });
    if (!operation) return;

    const snapshotBefore = cloneSnapshot(snapshot);
    const snapshotAfter = applyTaskListOperation(snapshotBefore, operation, {
      operationIndex,
      toolCallId: toolCall.id
    });
    const changes = taskListChangesForOperation(snapshotBefore, snapshotAfter, operation);
    entries.push({ toolCall, operation, snapshotBefore, snapshotAfter, changes });
    snapshot = snapshotAfter;
  });

  return { entries, snapshot };
}

export function applyTaskListOperationsAfterMessageSeq(input: {
  snapshot: TaskListSnapshotView;
  messages: readonly MessageRecord[];
  toolCalls: readonly ToolCallRecord[];
  conversationId: string;
  minSeqExclusive: number;
  operationStartIndex?: number;
}): TaskListSnapshotView {
  const messageById = new Map(input.messages.map((message) => [message.id, message]));
  const calls = sortedTaskListToolCalls(input.messages, input.toolCalls, input.conversationId)
    .filter(isAppliedTaskListToolCall)
    .filter((toolCall) => {
      const seq = messageById.get(toolCall.messageId)?.seq;
      return typeof seq === 'number' && seq > input.minSeqExclusive;
    });
  if (calls.length === 0) return cloneSnapshot(input.snapshot);

  let snapshot = cloneSnapshot(input.snapshot);
  let operationIndex = input.operationStartIndex ?? nextOperationIndex(snapshot);
  for (const toolCall of calls) {
    const operation = taskListOperationFromToolCall(toolCall, { allowArgsFallback: true });
    if (!operation) continue;
    snapshot = applyTaskListOperation(snapshot, operation, {
      operationIndex,
      toolCallId: toolCall.id
    });
    operationIndex += 1;
  }
  return snapshot;
}

export function taskListTimelineEntryForToolCall(input: {
  messages: readonly MessageRecord[];
  toolCalls: readonly ToolCallRecord[];
  conversationId: string;
  toolCallId: string;
}): TaskListTimelineEntry | undefined {
  return buildTaskListTimeline(input).entries.find((entry) => entry.toolCall.id === input.toolCallId);
}

export function taskListOperationFromToolCall(
  toolCall: ToolCallRecord | undefined,
  options: { allowArgsFallback?: boolean } = {}
): TaskListToolOperationRecord | undefined {
  if (!toolCall) return undefined;

  if (toolCall.name === TASK_LIST_TOOL_NAME) {
    return options.allowArgsFallback ? taskListOperationFromArgsJson(toolCall.args) : undefined;
  }

  if (toolCall.name === SUBMIT_PLAN_TOOL_NAME) {
    // A ToolCallRecord alone cannot prove the Plan was approved. Reliable projections seed an
    // approved Plan from its durable result artifact; guessing from arguments would also activate
    // change_requested/rejected/cancelled proposals.
    return undefined;
  }

  return undefined;
}

export function taskListOperationFromArgs(args: unknown): TaskListToolOperationRecord | undefined {
  try {
    return requireTaskListOperation(args);
  } catch {
    return undefined;
  }
}

/**
 * Canonical validation boundary shared by reliable settlement and read-side projections.
 *
 * Callers that own a durable write must use this throwing form.  Read-only presentation code may
 * use taskListOperationFromArgs when malformed, non-authoritative input should simply be ignored.
 */
export function requireTaskListOperation(value: unknown): TaskListToolOperationRecord {
  const record = asRecord(value);
  if (!record) throw new TypeError('Task list operation must be a plain object.');
  const unknownOperationFields = Object.keys(record).filter((key) =>
    key !== 'kind' && key !== 'mode' && key !== 'items');
  if (unknownOperationFields.length > 0) {
    throw new TypeError(`Task list operation has unsupported fields: ${unknownOperationFields.join(', ')}.`);
  }
  if (record.kind !== undefined && record.kind !== 'task_list.operation') {
    throw new TypeError('Task list operation kind must be task_list.operation when present.');
  }
  const mode = normalizeMode(record.mode);
  if (!mode) throw new TypeError('Task list operation mode must be rewrite or update.');
  if (!Array.isArray(record.items)) throw new TypeError('Task list operation items must be an array.');

  const items = record.items.map((rawItem, index) => requireOperationItem(rawItem, index, mode));
  const seenTitles = new Set<string>();
  for (const item of items) {
    const key = titleKey(item.title);
    if (seenTitles.has(key)) {
      throw new TypeError(`Task list operation contains duplicate title: ${item.title}.`);
    }
    seenTitles.add(key);
  }
  return { kind: 'task_list.operation', mode, items };
}

export function taskListDisplayItemsFromOperation(operation: TaskListToolOperationRecord): TaskListChangeItemView[] {
  return operation.items.map((item, index): TaskListChangeItemView => ({
    key: titleKey(item.title),
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    status: item.status ?? 'pending',
    createdOrder: index,
    updatedOrder: index,
    ...(item.delete ? { deleted: true, changeKind: 'deleted' as const } : {})
  }));
}

export function formatTaskListProgress(snapshot: TaskListSnapshotView): string {
  const { stats } = snapshot;
  if (stats.total === 0) return '当前没有任务。';
  const active = snapshot.activeItem;
  return `${stats.completed}/${stats.total} 已完成，${stats.open} 个未完成${active ? ` · 当前：${active.description || active.title}` : ''}`;
}

export function formatTaskListSnapshotForContext(snapshot: TaskListSnapshotView): string {
  const lines = [
    '[Current Task List Snapshot]',
    '以下内容由上下文压缩流程自动追加，表示压缩边界处的当前 task list；它覆盖上方任何更早的 task list 快照。后续未压缩的 update_task_list 工具调用应继续在此基础上更新。',
    `进度：${formatTaskListProgress(snapshot)}`
  ];

  if (snapshot.stats.total === 0) {
    lines.push('任务：当前没有任务。');
    return lines.join('\n');
  }

  lines.push('任务：');
  snapshot.items.forEach((item, index) => {
    const statusLabel = taskListStatusLabel(item.status);
    lines.push(`${index + 1}. [${item.status} / ${statusLabel}] ${singleLine(item.title)}`);
    if (item.description) {
      lines.push(`   说明：${singleLine(item.description)}`);
    }
  });
  return lines.join('\n');
}

export function taskListStatusLabel(status: TaskListItemStatus): string {
  return TASK_LIST_STATUS_LABELS[status];
}

export function taskListChangeLabel(change: TaskListChangeKind): string {
  return TASK_LIST_CHANGE_LABELS[change];
}

export function sortedTaskListToolCalls(
  messages: readonly MessageRecord[],
  toolCalls: readonly ToolCallRecord[],
  conversationId: string
): ToolCallRecord[] {
  const messageById = new Map(messages.map((message) => [message.id, message]));
  return toolCalls
    .filter((toolCall) => {
      if (toolCall.name !== TASK_LIST_TOOL_NAME && toolCall.name !== SUBMIT_PLAN_TOOL_NAME) return false;
      const message = messageById.get(toolCall.messageId);
      return message?.conversationId === conversationId;
    })
    .sort((left, right) => compareTaskListToolCalls(left, right, messageById));
}

function compareTaskListToolCalls(
  left: ToolCallRecord,
  right: ToolCallRecord,
  messageById: ReadonlyMap<string, MessageRecord>
): number {
  const leftMessage = messageById.get(left.messageId);
  const rightMessage = messageById.get(right.messageId);
  return (leftMessage?.seq ?? 0) - (rightMessage?.seq ?? 0)
    || functionCallPartIndex(leftMessage, left) - functionCallPartIndex(rightMessage, right)
    || left.createdAt - right.createdAt
    || compareText(left.id, right.id);
}

function functionCallPartIndex(message: MessageRecord | undefined, toolCall: ToolCallRecord): number {
  if (!message) return Number.MAX_SAFE_INTEGER;
  const functionCallId = toolCall.functionCallId ?? toolCall.id;
  const exactIndex = message.content.parts.findIndex((part) => isFunctionCallPart(part) && part.id === functionCallId);
  if (exactIndex >= 0) return exactIndex;

  const args = parseJson(toolCall.args);
  const argsText = stableJson(args);
  const matchedIndex = message.content.parts.findIndex((part) => {
    if (!isFunctionCallPart(part) || part.functionCall.name !== toolCall.name) return false;
    return stableJson(part.functionCall.args) === argsText;
  });
  return matchedIndex >= 0 ? matchedIndex : Number.MAX_SAFE_INTEGER;
}

function isAppliedTaskListToolCall(toolCall: ToolCallRecord): boolean {
  if (toolCall.status !== 'success') return false;
  return toolCall.name === TASK_LIST_TOOL_NAME;
}

function taskListOperationFromArgsJson(argsJson: string): TaskListToolOperationRecord | undefined {
  return taskListOperationFromArgs(parseJson(argsJson));
}

function normalizeMode(value: unknown): TaskListToolMode | undefined {
  return value === 'rewrite' || value === 'update' ? value : undefined;
}

function requireOperationItem(
  value: unknown,
  index: number,
  mode: TaskListToolMode
): TaskListToolItemRecord {
  const record = asRecord(value);
  if (!record) throw new TypeError(`Task list items[${index}] must be a plain object.`);
  const unknownItemFields = Object.keys(record).filter((key) =>
    key !== 'title' && key !== 'description' && key !== 'status' && key !== 'delete');
  if (unknownItemFields.length > 0) {
    throw new TypeError(`Task list items[${index}] has unsupported fields: ${unknownItemFields.join(', ')}.`);
  }
  const title = stringValue(record.title);
  if (!title) throw new TypeError(`Task list items[${index}].title must be non-empty text.`);
  if (record.description !== undefined && typeof record.description !== 'string') {
    throw new TypeError(`Task list items[${index}].description must be text when present.`);
  }
  const description = stringValue(record.description);
  if (record.status !== undefined && !taskStatusValue(record.status)) {
    throw new TypeError(`Task list items[${index}].status is invalid.`);
  }
  if (record.delete !== undefined && typeof record.delete !== 'boolean') {
    throw new TypeError(`Task list items[${index}].delete must be boolean when present.`);
  }
  const deletion = record.delete === true;
  if (mode === 'rewrite' && deletion) {
    throw new TypeError(`Task list items[${index}].delete can only be used in update mode.`);
  }
  const status = taskStatusValue(record.status);
  return {
    title,
    ...(description ? { description } : {}),
    ...(status && !deletion ? { status } : {}),
    ...(deletion ? { delete: true } : {})
  };
}

export function applyTaskListOperationToSnapshot(
  snapshot: TaskListSnapshotView,
  operation: TaskListToolOperationRecord,
  order: TaskListOrderInput
): TaskListSnapshotView {
  const byKey = new Map<string, TaskListItemView>();
  if (operation.mode === 'update') {
    for (const item of snapshot.items) byKey.set(item.key, cloneItem(item));
  }

  let nextCreatedOrder = operation.mode === 'rewrite'
    ? order.operationIndex * 10_000
    : maxCreatedOrder(byKey) + 1;
  let activeKeepKey: string | undefined;

  operation.items.forEach((input, index) => {
    const key = titleKey(input.title);
    if (input.delete === true) {
      byKey.delete(key);
      return;
    }

    const existing = byKey.get(key);
    const status = input.status ?? existing?.status ?? 'pending';
    const description = input.description ?? existing?.description;
    const item: TaskListItemView = {
      key,
      title: input.title,
      ...(description ? { description } : {}),
      status,
      createdOrder: existing?.createdOrder ?? nextCreatedOrder++,
      updatedOrder: order.operationIndex * 10_000 + index,
      sourceToolCallId: order.toolCallId
    };
    byKey.set(key, item);
    if (status === 'in_progress') activeKeepKey = key;
  });

  if (activeKeepKey) {
    for (const [key, item] of byKey) {
      if (key === activeKeepKey || item.status !== 'in_progress') continue;
      byKey.set(key, {
        ...item,
        status: 'pending',
        updatedOrder: order.operationIndex * 10_000 + operation.items.length
      });
    }
  }

  return snapshotFromItems([...byKey.values()]);
}

function taskListChangesForOperation(
  before: TaskListSnapshotView,
  after: TaskListSnapshotView,
  operation: TaskListToolOperationRecord
): TaskListChangeItemView[] {
  if (operation.mode === 'rewrite') {
    return after.items.map((item) => ({ ...cloneItem(item), changeKind: 'rewritten' }));
  }

  const beforeByKey = new Map(before.items.map((item) => [item.key, item]));
  const afterByKey = new Map(after.items.map((item) => [item.key, item]));
  const changes: TaskListChangeItemView[] = [];

  for (const input of operation.items) {
    const key = titleKey(input.title);
    const previous = beforeByKey.get(key);
    if (input.delete === true) {
      changes.push({
        ...(previous ? cloneItem(previous) : placeholderDeletedItem(input, changes.length)),
        deleted: true,
        changeKind: 'deleted',
        ...(previous?.status ? { previousStatus: previous.status } : {})
      });
      continue;
    }

    const next = afterByKey.get(key);
    if (!next) continue;
    changes.push({
      ...cloneItem(next),
      changeKind: changeKindFor(previous, next),
      ...(previous && previous.status !== next.status ? { previousStatus: previous.status } : {})
    });
  }

  return changes;
}

function changeKindFor(previous: TaskListItemView | undefined, next: TaskListItemView): TaskListChangeKind {
  if (!previous) return 'added';
  if (previous.status !== next.status) return next.status === 'completed' ? 'completed' : 'status_changed';
  return 'updated';
}

function placeholderDeletedItem(input: TaskListToolItemRecord, index: number): TaskListItemView {
  return {
    key: titleKey(input.title),
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    status: 'cancelled',
    createdOrder: index,
    updatedOrder: index
  };
}

export function emptyTaskListSnapshot(): TaskListSnapshotView {
  return snapshotFromItems([]);
}

const applyTaskListOperation = applyTaskListOperationToSnapshot;

function snapshotFromItems(items: TaskListItemView[]): TaskListSnapshotView {
  const sorted = [...items].sort((left, right) => left.createdOrder - right.createdOrder || compareText(left.title, right.title));
  const stats = computeStats(sorted);
  const activeItem = sorted.find((item) => item.status === 'in_progress');
  return { items: sorted, stats, ...(activeItem ? { activeItem } : {}) };
}

function computeStats(items: readonly TaskListItemView[]): TaskListStatsView {
  const stats: TaskListStatsView = {
    total: items.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
    open: 0
  };
  for (const item of items) {
    if (item.status === 'pending') stats.pending += 1;
    if (item.status === 'in_progress') stats.inProgress += 1;
    if (item.status === 'completed') stats.completed += 1;
    if (item.status === 'blocked') stats.blocked += 1;
    if (item.status === 'cancelled') stats.cancelled += 1;
    if (!TERMINAL_STATUSES.has(item.status)) stats.open += 1;
  }
  return stats;
}

function cloneSnapshot(snapshot: TaskListSnapshotView): TaskListSnapshotView {
  return snapshotFromItems(snapshot.items.map(cloneItem));
}

function cloneItem(item: TaskListItemView): TaskListItemView {
  return {
    key: item.key,
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    status: item.status,
    createdOrder: item.createdOrder,
    updatedOrder: item.updatedOrder,
    ...(item.sourceToolCallId ? { sourceToolCallId: item.sourceToolCallId } : {})
  };
}

function maxCreatedOrder(items: ReadonlyMap<string, TaskListItemView>): number {
  let max = -1;
  for (const item of items.values()) max = Math.max(max, item.createdOrder);
  return max;
}

function nextOperationIndex(snapshot: TaskListSnapshotView): number {
  let maxUpdatedOrder = -1;
  for (const item of snapshot.items) maxUpdatedOrder = Math.max(maxUpdatedOrder, item.updatedOrder);
  return Math.max(0, Math.floor(maxUpdatedOrder / 10_000) + 1);
}

function titleKey(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text : undefined;
}

function taskStatusValue(value: unknown): TaskListItemStatus | undefined {
  return typeof value === 'string' && (TASK_LIST_ITEM_STATUSES as readonly string[]).includes(value)
    ? value as TaskListItemStatus
    : undefined;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseJson(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return undefined;
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
