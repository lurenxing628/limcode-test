import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import * as path from 'path';
import type { Entity, WorldReader, AccessDeclaration } from '../../../ecs/types';
import { stripInitialWorkEnvironmentSection } from '../../../../shared/runtimeContextText';
import { formatWorkEnvironmentForDisplay } from '../../../../shared/workEnvironmentCatalog';
import { Agent } from '../agent/components';
import { AgentRunTargetLink, RunWorkflowLink } from '../agentRun/components';
import { activeWorkflowForRun, runTarget } from '../agentRun/queries';
import { Conversation } from '../chat/components';
import { ConversationWorkflowSelection, Workflow } from '../workflow/components';
import { ConversationProjectLink, ProjectContext } from '../project/components';
import { runtimeContextWorkEnvironmentsForConversation, toPublicWorkEnvironmentRecord } from '../workEnvironment/queries';
import {
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink
} from '../workEnvironment/components';

export {
  SYSTEM_PROMPT_PLACEHOLDERS, RUNTIME_CONTEXT_PLACEHOLDERS,
  PROMPT_PLACEHOLDERS, DEFAULT_RUNTIME_CONTEXT_TEMPLATE
} from '../../../../shared/promptTemplateCatalog';

export const PROMPT_CONTEXT_PLACEHOLDER_READS: AccessDeclaration = {
  components: [
    Agent,
    AgentRunTargetLink,
    RunWorkflowLink,
    Conversation,
    ConversationWorkflowSelection,
    Workflow,
    ConversationProjectLink,
    ProjectContext,
    WorkEnvironment,
    WorkEnvironmentPolicy,
    WorkEnvironmentPolicyScopeLink,
    ConversationWorkEnvironmentLink,
    RunWorkEnvironmentLink
  ]
};

export interface PromptPlaceholderRenderContext {
  world: WorldReader;
  run?: Entity;
  conversation?: Entity;
  now?: Date;
}

export function renderSystemPromptTemplate(template: string, context: PromptPlaceholderRenderContext): string {
  return replacePlaceholders(template, (token) => resolveSystemPlaceholder(token, context));
}

export function renderRuntimeContextTemplate(template: string, context: PromptPlaceholderRenderContext): string {
  const rendered = replacePlaceholders(template, (token) => resolveRuntimePlaceholder(token, context));
  return currentWorkEnvironmentText(context) ? rendered : stripInitialWorkEnvironmentSection(rendered);
}

export function runtimeContextSourceHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function replacePlaceholders(template: string, resolve: (token: string) => string | undefined): string {
  return template.replace(/\{\{\$[a-zA-Z0-9_.-]+\}\}/g, (token) => resolve(token) ?? token);
}

function resolveSystemPlaceholder(token: string, context: PromptPlaceholderRenderContext): string | undefined {
  const { world, run } = context;
  const target = run !== undefined ? runTarget(world, run) : undefined;
  const agent = target ? world.get(target.agent, Agent) : undefined;
  const workflowEntity = run !== undefined ? activeWorkflowForRun(world, run) : undefined;
  const workflow = workflowEntity !== undefined ? world.get(workflowEntity, Workflow) : undefined;
  switch (token) {
    case '{{$agent.name}}': return agent?.name ?? '';
    case '{{$agent.description}}': return agent?.description ?? '';
    case '{{$workflow.name}}': return workflow?.name ?? '';
    case '{{$workflow.description}}': return workflow?.description ?? '';
    default: return undefined;
  }
}

function resolveRuntimePlaceholder(token: string, context: PromptPlaceholderRenderContext): string | undefined {
  const now = context.now ?? new Date();
  switch (token) {
    case '{{$runtime.timestamp}}': return now.toISOString();
    case '{{$runtime.date}}': return formatLocalDate(now);
    case '{{$platform.os}}': return process.platform;
    case '{{$workEnvironment.current}}': return currentWorkEnvironmentText(context);
    case '{{$workEnvironment.currentSection}}': return currentWorkEnvironmentSectionText(context);
    case '{{$workspace.name}}': return currentWorkspaceText(context, 'name');
    case '{{$workspace.uri}}': return currentWorkspaceText(context, 'uri');
    default: return undefined;
  }
}

function currentWorkEnvironmentText(context: PromptPlaceholderRenderContext): string {
  const conversation = context.conversation ?? (context.run !== undefined ? runTarget(context.world, context.run)?.conversation : undefined);
  if (conversation === undefined) return '';
  return runtimeContextWorkEnvironmentsForConversation(context.world, conversation)
    .map((environment) => formatWorkEnvironmentForDisplay(toPublicWorkEnvironmentRecord(environment.data)))
    .join('\n');
}

function currentWorkEnvironmentSectionText(context: PromptPlaceholderRenderContext): string {
  const text = currentWorkEnvironmentText(context);
  return text ? `\nInitial work environment:\n${text}` : '';
}

function currentWorkspaceText(context: PromptPlaceholderRenderContext, field: 'name' | 'uri'): string {
  const conversation = context.conversation ?? (context.run !== undefined ? runTarget(context.world, context.run)?.conversation : undefined);
  if (conversation === undefined) return '未绑定工作区。';
  const project = projectContextForConversation(context.world, conversation);
  if (!project) return '未绑定工作区。';
  return field === 'name' ? project.name : formatWorkspaceUriForPrompt(project.uri);
}

function projectContextForConversation(world: WorldReader, conversation: Entity): ProjectContextData | undefined {
  for (const entity of world.query(ConversationProjectLink)) {
    const link = world.get(entity, ConversationProjectLink);
    if (!link || link.conversation !== conversation || link.role !== 'primary') continue;
    return world.get(link.projectContext, ProjectContext);
  }
  return undefined;
}

type ProjectContextData = { id: string; kind: string; uri: string; name: string; createdAt: number; updatedAt: number };

export function formatWorkspaceUriForPrompt(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('file:')) return decodeUriFallback(trimmed);
  return fileUriToDisplayPath(trimmed) ?? decodeUriFallback(trimmed);
}

function fileUriToDisplayPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return undefined;
    const decodedPath = decodeURIComponent(parsed.pathname);
    const windowsDrivePath = decodedPath.match(/^\/([a-zA-Z]:)(?:\/(.*))?$/);
    if (windowsDrivePath) {
      const [, drive, rest = ''] = windowsDrivePath;
      return rest ? `${drive}\\${rest.replace(/\//g, '\\')}` : `${drive}\\`;
    }
    if (process.platform === 'win32') return fileURLToPath(parsed);
    return path.normalize(fileURLToPath(parsed));
  } catch {
    return undefined;
  }
}

function decodeUriFallback(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
