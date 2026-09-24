import { IconMessage2, IconUsers } from '@tabler/icons-vue';
import { bridge, BridgeMessageType } from '@webview/transport';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';
import { answerFromValue, answerMarkdownSection } from './agentAnswerToolDisplay';

export const runAgentToolDisplay: ToolDisplayResolver = (context) => {
  const conversationId = context.childConversationId?.trim() || undefined;
  const answer = answerFromValue(context.result);
  const metadataSections = [
    ...runAgentListSections(context.result),
    ...runAgentMetadataSections(context)
  ];
  const outputSections = metadataSections.length > 0 || answer?.content
    ? [
        ...metadataSections,
        ...(answer?.content ? [answerMarkdownSection(answer.title ?? 'Agent 回答正文', answer.content)] : [])
      ]
    : undefined;

  return {
    headerIcon: IconUsers,
    outputSections: outputSections ?? [],
    headerActions: conversationId ? [{
        id: 'open-agent-run-conversation',
        label: '打开对话',
        title: '打开这个子 Agent 的对话',
        icon: IconMessage2,
        invoke: () => {
          bridge.request(BridgeMessageType.ConversationOpen, { conversationId });
        }
      }]
      : []
  };
};

export function isRunAgentSpawnArguments(value: unknown): boolean {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown; }
    catch { return false; }
  }
  return asRecord(parsed)?.operation === 'spawn';
}

function runAgentListSections(value: unknown): ToolDisplaySection[] {
  const record = asRecord(value);
  if (record?.operation !== 'list') return [];
  const scope = record.scope === 'tree' ? 'tree' : 'direct';
  const count = scope === 'tree' ? record.totalDescendants : record.totalDirect;
  const total = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    ? count
    : undefined;
  const rows = [
    { label: '操作', value: '列出已有子 Agent（不会启动新任务）' },
    { label: '范围', value: scope === 'tree' ? '整个子任务树' : '直接子任务' },
    ...(total !== undefined ? [{ label: '已有子任务', value: `${total} 个` }] : []),
    ...(total === 0 ? [{ label: '结果', value: '当前没有子任务；本次查询未启动子 Agent' }] : [])
  ];
  return [{ kind: 'output', title: '子 Agent 查询结果', rows, rowStyle: 'keyValue' }];
}

function runAgentMetadataSections(context: ToolDisplayContext): ToolDisplaySection[] {
  const record = asRecord(context.result) ?? asRecord(context.progress);
  if (!record) return [];
  const rows = [
    ...stateRow('子 Agent 状态', record.childExecutionState),
    ...stateRow('当前任务状态', record.activeChildTurnState),
    ...stateRow('回答提交状态', record.answerSubmissionState),
    ...stateRow('回答发送状态', record.runtimeDeliveryState),
    ...stateRow('主 Agent 处理状态', record.parentHandlingState),
    ...stateRow('结束状态', record.terminationState)
  ];
  return rows.length > 0
    ? [{ kind: 'output', title: '子 Agent 运行结果', rows, rowStyle: 'keyValue' }]
    : [];
}

function stateRow(label: string, value: unknown): Array<{ label: string; value: string }> {
  if (typeof value !== 'string') return row(label, value);
  const text = value.trim();
  if (!text) return [];
  const labels: Record<string, string> = {
    starting: '启动中',
    active: '运行中',
    running: '运行中',
    idle: '等待继续',
    interrupting: '正在终止',
    interrupted: '已终止',
    closed: '已结束',
    pending: '等待中',
    submitted: '已提交',
    delivered: '已发送',
    consumed: '已接收',
    handled: '已处理',
    failed: '失败',
    complete: '已完成',
    completed: '已完成',
    cancelled: '已取消',
    awaiting_parent: '等待主 Agent 处理',
    delivery_failed: '回答发送失败',
    success: '成功'
  };
  return [{ label, value: labels[text] ?? text }];
}

function row(label: string, value: unknown): Array<{ label: string; value: string }> {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [{ label, value: text }] : [];
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [{ label, value: String(value) }];
  try {
    return [{ label, value: JSON.stringify(value) }];
  } catch {
    return [{ label, value: String(value) }];
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
