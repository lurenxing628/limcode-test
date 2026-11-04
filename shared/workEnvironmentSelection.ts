import type { WorkEnvironmentRecord } from './protocol';
import { isLocalFolderWorkEnvironment, workEnvironmentIdFromUri } from './workEnvironmentCatalog';

export interface WorkEnvironmentSelectionPolicy {
  autoAllowWorkspaceFolders?: boolean;
  allowedWorkEnvironmentIds: readonly string[];
  defaultWorkEnvironmentId?: string | null;
}

export function autoAllowWorkspaceFolders(
  policy?: Pick<WorkEnvironmentSelectionPolicy, 'autoAllowWorkspaceFolders'>
): boolean {
  return policy?.autoAllowWorkspaceFolders !== false;
}

/** Uses this Host's projected availability; persisted folders from other windows grant no access. */
export function automaticallyAllowedWorkspaceFolders(
  environments: readonly WorkEnvironmentRecord[],
  policy?: Pick<WorkEnvironmentSelectionPolicy, 'autoAllowWorkspaceFolders'>
): WorkEnvironmentRecord[] {
  if (!autoAllowWorkspaceFolders(policy)) return [];
  return environments.filter(environment => environment.available
    && environment.source === 'workspaceFolder' && isLocalFolderWorkEnvironment(environment));
}

export interface WorkEnvironmentSelection {
  allowed: WorkEnvironmentRecord[];
  active?: WorkEnvironmentRecord;
  error?: string;
  source?: 'explicit' | 'inherited' | 'project' | 'default' | 'single';
}

/** Shared by Turn freezing and the composer. Ordering never grants a different working root. */
export function resolveWorkEnvironmentSelection(input: {
  environments: readonly WorkEnvironmentRecord[];
  policy?: WorkEnvironmentSelectionPolicy;
  inheritedPolicy?: WorkEnvironmentSelectionPolicy;
  explicitWorkEnvironmentId?: string;
  project?: { uri: string };
  projectMissing?: boolean;
}): WorkEnvironmentSelection {
  const byId = new Map(input.environments.map(environment => [environment.id, environment]));
  // A child inherits the parent's exact frozen boundary. Its Agent's own settings cannot narrow
  // that boundary, and newly opened folders cannot expand it during this execution lineage.
  const ids = input.inheritedPolicy?.allowedWorkEnvironmentIds ?? [
    ...(input.policy?.allowedWorkEnvironmentIds ?? input.environments.map(environment => environment.id)),
    ...automaticallyAllowedWorkspaceFolders(input.environments, input.policy).map(environment => environment.id)
  ];
  const allowedIds = new Set(ids);
  const allowed = [...allowedIds].map(id => byId.get(id))
    .filter((environment): environment is WorkEnvironmentRecord => !!environment?.available);
  const select = (id: string, source: NonNullable<WorkEnvironmentSelection['source']>): WorkEnvironmentSelection => {
    const environment = byId.get(id);
    const label = environment?.name || id;
    if (!environment) return { allowed, source, error: `工作环境不存在：${label}，请重新选择工作环境。` };
    // A child Agent conversation's list is also bounded by the conversation that started it; say so,
    // since adjusting this conversation's own settings cannot lift that limit.
    if (!allowedIds.has(id)) return { allowed, source, error: input.inheritedPolicy
      ? `工作目录「${label}」不在派出这个子 Agent 的对话允许的范围内。这个限制来自派出它的对话，请从允许的目录中重新选择。`
      : `工作环境未获当前策略允许：${label}，请调整策略或重新选择。` };
    if (!environment.available) return { allowed, source, error: `当前窗口的工作环境不可用：${label}，请打开对应目录或重新选择。` };
    return { allowed, active: environment, source };
  };
  if (input.explicitWorkEnvironmentId) return select(input.explicitWorkEnvironmentId, 'explicit');
  if (input.inheritedPolicy) return input.inheritedPolicy.defaultWorkEnvironmentId
    ? select(input.inheritedPolicy.defaultWorkEnvironmentId, 'inherited')
    : { allowed, source: 'inherited' };
  if (input.projectMissing) return { allowed, error: '会话绑定的项目不存在，请重新绑定项目或显式选择工作环境。' };
  if (input.project) return select(workEnvironmentIdFromUri(input.project.uri), 'project');
  if (input.policy?.defaultWorkEnvironmentId) return select(input.policy.defaultWorkEnvironmentId, 'default');
  if (allowed.length === 1) return { allowed, active: allowed[0], source: 'single' };
  if (allowed.length > 1) return { allowed, error: '存在多个工作环境，请明确选择本次会话使用的目录。' };
  return { allowed };
}
