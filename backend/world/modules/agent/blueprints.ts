import { defineResource } from '../../../ecs/types';
import type { LlmProviderKind, PlanReviewPolicyRecord, ToolPolicySourceConfigRecord, ToolPolicyToolConfigRecord, WorkflowIconKey } from '../../../../shared/protocol';
import { EXTENSION_AGENT_NAME, EXTENSION_BRAND } from '../../../../shared/extensionIdentity';
import {
  ASK_USER_TOOL_NAME,
  DELETE_TOOL_NAME,
  EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  READ_AGENT_ANSWER_TOOL_NAME,
  SKILLS_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TOOL_POLICY_ALL_MCP_SOURCES,
  TRANSFER_TOOL_NAME,
  WRITE_TOOL_NAME
} from '../../../../shared/protocol';

export interface BuiltinModelProfileDefinition {
  id?: string;
  name?: string;
  provider?: LlmProviderKind;
  model: string;
}

export interface BuiltinToolPolicyDefinition {
  id?: string;
  name?: string;
  allowedTools: string[];
  toolConfigs?: Record<string, ToolPolicyToolConfigRecord>;
  /** MCP source restrictions that stay in force even when the scope saves its own record. */
  sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>;
}

export interface BuiltinAgentDefinition {
  id: string;
  kind: string;
  name: string;
  description?: string;
  systemPrompt: string;
  model?: BuiltinModelProfileDefinition;
  toolPolicy: BuiltinToolPolicyDefinition;
}

export interface BuiltinWorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  icon?: WorkflowIconKey;
  systemPrompt?: string;
  model?: BuiltinModelProfileDefinition;
  toolPolicy?: BuiltinToolPolicyDefinition;
  planReviewPolicy?: Omit<PlanReviewPolicyRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
}

export interface BuiltinAgentRegistry {
  agents: Record<string, BuiltinAgentDefinition>;
  workflows: Record<string, BuiltinWorkflowDefinition>;
}

export const AgentBlueprintsKey = defineResource<BuiltinAgentRegistry>('AgentBlueprints');

export const DEFAULT_SYSTEM_PROMPT = `You are ${EXTENSION_BRAND}, a concise and helpful AI coding assistant running inside VS Code. Reply in the user's language unless asked otherwise.`;
export const DEFAULT_INTEGRATED_SYSTEM_PROMPT_ID = 'system-prompt:global:integrated';
export const DEFAULT_INTEGRATED_SYSTEM_PROMPT_NAME = 'Integrated Global System Prompt';

export const DEFAULT_INTEGRATED_SYSTEM_PROMPT = [
  'You are {{$agent.name}}, a concise and helpful AI coding assistant running inside VS Code.',
  '{{$agent.description}}',
  '{{$workflow.description}}',
  'Follow the active agent profile, active workflow, user instructions, and project rules. Reply in the user\'s language unless asked otherwise.',
  'Replies render as Markdown; local absolute image paths render inline, e.g. ![](/path/to/shot.png), and local file links open in VS Code.'
].join('\n\n');

const COLLABORATION_TOOLS = ['list_agents', 'send_agent_message', 'followup_agent_task', 'read_agent_messages', 'wait_agent_messages'];
// The cross-conversation tools belong to no list: the user's switch grants them (only listing and
// reading where the list lacks run_agent, as in the read-only lists below).
const DEFAULT_TOOLS = [TASK_LIST_TOOL_NAME, ASK_USER_TOOL_NAME, SUBMIT_PLAN_TOOL_NAME, SWITCH_WORK_ENVIRONMENT_TOOL_NAME, TRANSFER_TOOL_NAME, READ_TOOL_NAME, EDIT_TOOL_NAME, WRITE_TOOL_NAME, DELETE_TOOL_NAME, 'shell', 'bash', 'run_agent', SKILLS_TOOL_NAME, READ_AGENT_ANSWER_TOOL_NAME, ...COLLABORATION_TOOLS];
const READONLY_TOOLS = [TASK_LIST_TOOL_NAME, ASK_USER_TOOL_NAME, SUBMIT_PLAN_TOOL_NAME, SWITCH_WORK_ENVIRONMENT_TOOL_NAME, READ_TOOL_NAME, 'shell', 'bash', SKILLS_TOOL_NAME, READ_AGENT_ANSWER_TOOL_NAME, 'list_agents', 'send_agent_message', 'read_agent_messages', 'wait_agent_messages'];
const DEFAULT_TOOL_CONFIGS: Record<string, ToolPolicyToolConfigRecord> = {};
/**
 * MCP tools may have side effects and are not known to be read-only, so read-only built-ins deny
 * every MCP source. Enabling a source in that Agent's or workflow's own tool settings opts it in.
 */
const READONLY_MCP_SOURCES: Record<string, ToolPolicySourceConfigRecord> = { [TOOL_POLICY_ALL_MCP_SOURCES]: { enabled: false } };

export function createDefaultAgentBlueprints(): BuiltinAgentRegistry {
  return {
    agents: {
      main: {
        id: 'main',
        kind: 'main',
        name: EXTENSION_AGENT_NAME,
        description: 'General-purpose Agent for daily conversation and development collaboration.',
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        toolPolicy: { name: 'Main Agent Tools', allowedTools: DEFAULT_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      worker: {
        id: 'worker',
        kind: 'worker',
        name: 'Worker Agent',
        description: 'General-purpose worker Agent capable of multi-step tool operations.',
        systemPrompt: `You are a peer ${EXTENSION_BRAND} worker agent. Complete assigned implementation or investigation tasks independently, use tools when useful, and report concise results with important details.`,
        toolPolicy: { name: 'Worker Agent Tools', allowedTools: DEFAULT_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS }
      },
      explore: {
        id: 'explore',
        kind: 'explore',
        name: 'Explore Agent',
        description: 'Read-only Agent for searching, reading, and analyzing code.',
        systemPrompt: 'You are a read-only exploration agent. Inspect code, run safe read-only commands, and report findings. Do not modify files.',
        toolPolicy: { name: 'Explore Agent Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS, sourceConfigs: READONLY_MCP_SOURCES }
      },
      reviewer: {
        id: 'reviewer',
        kind: 'reviewer',
        name: 'Reviewer',
        description: 'Review code, design, risks, bugs, and maintainability issues. Only use when you are uncertain about the consequences of changes — skip trivial/small modifications and changes you are confident about.',
        systemPrompt: 'Review code, design, risks, bugs, and maintainability issues. Do not modify files unless explicitly requested. Only use this reviewer when you are uncertain about the consequences of changes — skip trivial/small modifications and changes you are confident about.',
        toolPolicy: { name: 'Reviewer Agent Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS, sourceConfigs: READONLY_MCP_SOURCES }
      }
    },
    workflows: {
      plan: {
        id: 'builtin:plan',
        name: 'Plan',
        description: 'Plan first: analyze requirements, identify risks, and decompose tasks before implementation.',
        systemPrompt: 'Plan first. Before any file edit, write, delete, non-readonly command, or child agent task, call submit_plan with plan as the full implementation plan and taskList as a non-empty complete ordered execution task list using mode="rewrite" and unique titles, then wait for user approval. Task status tracks progress and must not narrow or replace the approved Plan scope. If the user requests changes, revise and submit both the plan and its complete taskList again. Only proceed with mutating tools after approval.',
        planReviewPolicy: {
          mode: 'before_mutation',
          allowReadonlyBeforeApproval: true,
          requireForToolRiskLevels: ['write', 'command', 'agent']
        }
      },
      review: {
        id: 'builtin:review',
        name: 'Review',
        description: 'Review workflow: assess risks, correctness, regressions, security, and maintainability.',
        systemPrompt: 'Act in review workflow. Focus on correctness, risks, regressions, security, maintainability, and concrete improvement suggestions.',
        toolPolicy: { name: 'Review Workflow Tool Narrowing', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS, sourceConfigs: READONLY_MCP_SOURCES }
      },
      readonly: {
        id: 'builtin:readonly',
        name: 'Read Only',
        description: 'Read-only exploration workflow with tool narrowing to read-only tools.',
        systemPrompt: 'Use read-only exploration workflow. Do not modify files or execute destructive commands.',
        toolPolicy: { name: 'Read Only Workflow Tools', allowedTools: READONLY_TOOLS, toolConfigs: DEFAULT_TOOL_CONFIGS, sourceConfigs: READONLY_MCP_SOURCES }
      }
    }
  };
}
