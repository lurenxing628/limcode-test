import type { Component } from 'vue';
import type {
  AskUserToolRequestRecord,
  CheckpointRecord,
  SubmitPlanToolRequestRecord,
  CheckpointTimelineAnchorRecord,
  MessageRecord,
  ShadowRepositoryRecord,
  ToolCallEventRecord,
  ToolCallRecord
} from '@shared/protocol';
import type { TaskListChangeItemView, TaskListItemView } from '@webview/components/taskList/taskListModel';

export interface ToolDisplayRow {
  label: string;
  value: string;
}

export interface ToolDisplayDiffFile {
  path: string;
  action?: string;
  added?: number;
  removed?: number;
  truncated?: boolean;
  text: string;
}

export interface ToolDisplayDiff {
  files: ToolDisplayDiffFile[];
  summary?: string;
}

export interface ToolDisplaySection {
  kind: 'input' | 'output';
  title: string;
  text?: string;
  markdown?: boolean;
  rows?: ToolDisplayRow[];
  rowStyle?: 'keyValue' | 'lineNumber';
  diff?: ToolDisplayDiff;
  taskList?: ToolDisplayTaskList;
  askUser?: ToolDisplayAskUser;
  planProposal?: ToolDisplayPlanProposal;
}

export interface ToolDisplayTaskList {
  items: Array<TaskListItemView | TaskListChangeItemView>;
  showChange?: boolean;
  emptyText?: string;
}

export interface ToolDisplayAskUser {
  request: AskUserToolRequestRecord;
  toolCall?: ToolCallRecord;
}

export interface ToolDisplayPlanProposal {
  request: SubmitPlanToolRequestRecord;
  proposalId?: string;
  toolCall?: ToolCallRecord;
}

export interface ToolDisplayContext {
  toolName: string;
  args: unknown;
  result?: unknown;
  progress?: unknown;
  events: ToolCallEventRecord[];
  toolCall?: ToolCallRecord;
  messages?: MessageRecord[];
  toolCalls?: ToolCallRecord[];
  checkpoints?: CheckpointRecord[];
  checkpointTimelineAnchors?: CheckpointTimelineAnchorRecord[];
  shadowRepositories?: ShadowRepositoryRecord[];
  currentConversationId?: string;
  /** Child Conversation resolved from durable ChildExecutionParentLink/ChildExecution facts. */
  childConversationId?: string;
  /** Reliable plan identity is derived independently from the Interaction request identity. */
  planProposalId?: string;
  stringifyValue(value: unknown): string;
}

export interface ToolHeaderAction {
  id: string;
  label: string;
  title?: string;
  icon?: Component;
  disabled?: boolean;
  invoke(): void;
}

export interface ToolHeaderPreview {
  fileName: string;
  filePath?: string;
  added?: number;
  removed?: number;
}

export interface ToolDisplayResult {
  inputSections: ToolDisplaySection[];
  outputSections: ToolDisplaySection[];
  /** Raw call parameters and execution metadata, hidden until the user opens call details. */
  detailSections?: ToolDisplaySection[];
  headerIcon?: Component;
  headerActions: ToolHeaderAction[];
  headerPreview?: ToolHeaderPreview;
}

export type ToolDisplayResolver = (context: ToolDisplayContext) => Partial<ToolDisplayResult> | undefined;
