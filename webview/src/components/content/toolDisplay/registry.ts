import type { Component } from 'vue';
import {
  IconBook,
  IconFileDescription,
  IconMessageQuestion,
  IconPencil,
  IconPlaylistAdd,
  IconSwitch,
  IconTerminal2,
  IconTrash,
  IconTool,
  IconTransfer,
  IconUsers,
  IconWriting
} from '@tabler/icons-vue';
import {
  ASK_USER_TOOL_NAME,
  DELETE_TOOL_NAME,
  EDIT_TOOL_NAME,
  READ_AGENT_ANSWER_TOOL_NAME,
  READ_TOOL_NAME,
  SKILLS_TOOL_NAME,
  SUBMIT_AGENT_ANSWER_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TRANSFER_TOOL_NAME,
  WRITE_TOOL_NAME
} from '@shared/protocol';
import { readAgentAnswerToolDisplay, submitAgentAnswerToolDisplay } from './agentAnswerToolDisplay';
import { askUserToolDisplay } from './askUserToolDisplay';
import { deleteToolDisplay, editToolDisplay, writeToolDisplay } from './fileChangeToolDisplay';
import { readFileToolDisplay } from './readFileToolDisplay';
import { runAgentToolDisplay } from './runAgentToolDisplay';
import { skillsToolDisplay } from './skillsToolDisplay';
import { shellToolDisplay } from './shellToolDisplay';
import { submitPlanToolDisplay } from './submitPlanToolDisplay';
import { switchWorkEnvironmentToolDisplay } from './switchWorkEnvironmentToolDisplay';
import { taskListToolDisplay } from './taskListToolDisplay';
import { transferFilesToolDisplay } from './transferFilesToolDisplay';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplayResult, ToolDisplaySection } from './types';

const TOOL_DISPLAY_RESOLVERS: Record<string, ToolDisplayResolver> = {
  [TASK_LIST_TOOL_NAME]: taskListToolDisplay,
  [ASK_USER_TOOL_NAME]: askUserToolDisplay,
  [SUBMIT_PLAN_TOOL_NAME]: submitPlanToolDisplay,
  [READ_TOOL_NAME]: readFileToolDisplay,
  [EDIT_TOOL_NAME]: editToolDisplay,
  [WRITE_TOOL_NAME]: writeToolDisplay,
  [DELETE_TOOL_NAME]: deleteToolDisplay,
  run_agent: runAgentToolDisplay,
  [SUBMIT_AGENT_ANSWER_TOOL_NAME]: submitAgentAnswerToolDisplay,
  [READ_AGENT_ANSWER_TOOL_NAME]: readAgentAnswerToolDisplay,
  shell: shellToolDisplay,
  bash: shellToolDisplay,
  [SWITCH_WORK_ENVIRONMENT_TOOL_NAME]: switchWorkEnvironmentToolDisplay,
  [TRANSFER_TOOL_NAME]: transferFilesToolDisplay,
  [SKILLS_TOOL_NAME]: skillsToolDisplay
};

const TOOL_HEADER_ICONS: Record<string, Component> = {
  [TASK_LIST_TOOL_NAME]: IconPlaylistAdd,
  [ASK_USER_TOOL_NAME]: IconMessageQuestion,
  [SUBMIT_PLAN_TOOL_NAME]: IconPlaylistAdd,
  [READ_TOOL_NAME]: IconFileDescription,
  [EDIT_TOOL_NAME]: IconPencil,
  [WRITE_TOOL_NAME]: IconWriting,
  [DELETE_TOOL_NAME]: IconTrash,
  run_agent: IconUsers,
  [SUBMIT_AGENT_ANSWER_TOOL_NAME]: IconUsers,
  [READ_AGENT_ANSWER_TOOL_NAME]: IconUsers,
  shell: IconTerminal2,
  bash: IconTerminal2,
  [SWITCH_WORK_ENVIRONMENT_TOOL_NAME]: IconSwitch,
  [TRANSFER_TOOL_NAME]: IconTransfer,
  [SKILLS_TOOL_NAME]: IconBook
};

export function resolveToolHeaderIcon(toolName: string): Component {
  return TOOL_HEADER_ICONS[toolName] ?? IconTool;
}

export function resolveToolDisplay(context: ToolDisplayContext): ToolDisplayResult {
  const fallback = defaultToolDisplay(context);
  const custom = TOOL_DISPLAY_RESOLVERS[context.toolName]?.(context);

  return {
    inputSections: custom?.inputSections ?? fallback.inputSections,
    outputSections: custom?.outputSections ?? fallback.outputSections,
    headerIcon: custom?.headerIcon ?? fallback.headerIcon ?? resolveToolHeaderIcon(context.toolName),
    headerActions: custom?.headerActions ?? fallback.headerActions,
    headerPreview: custom?.headerPreview
  };
}

function defaultToolDisplay(context: ToolDisplayContext): ToolDisplayResult {
  const inputText = context.stringifyValue(context.args).trim();
  const inputSections: ToolDisplaySection[] = inputText && inputText !== '{}'
    ? [{ kind: 'input', title: '输入', text: inputText }]
    : [];

  const outputSections: ToolDisplaySection[] = [];
  if (context.result !== undefined) {
    outputSections.push(...defaultResultSections(context));
  } else if (context.progress !== undefined) {
    outputSections.push({ kind: 'output', title: '输出', text: context.stringifyValue(context.progress) });
  } else {
    const eventText = defaultEventText(context);
    if (eventText) outputSections.push({ kind: 'output', title: '事件', text: eventText });
  }

  return { inputSections, outputSections, headerActions: [] };
}

function defaultResultSections(context: ToolDisplayContext): ToolDisplaySection[] {
  const result = context.result;
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const explanation = [record.error, record.reason].find((value): value is string =>
      typeof value === 'string' && value.trim().length > 0);
    if (explanation) return [
      { kind: 'output', title: '结果说明', text: explanation },
      ...(Object.keys(record).length > 1
        ? [{ kind: 'output' as const, title: '输出', text: context.stringifyValue(result) }]
        : [])
    ];
  }
  return [{ kind: 'output', title: '输出', text: context.stringifyValue(result) }];
}

function defaultEventText(context: ToolDisplayContext): string {
  return context.events
    .map((event) => event.delta ?? (event.payload !== undefined ? context.stringifyValue(event.payload) : ''))
    .filter(Boolean)
    .join('');
}

export type { ToolDisplayContext, ToolDisplayResult, ToolDisplaySection, ToolHeaderAction } from './types';
