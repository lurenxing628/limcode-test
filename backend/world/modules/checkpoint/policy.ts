import { fileURLToPath } from 'url';
import type {
  CheckpointPolicyRecord,
  CheckpointToolTriggerConfigRecord,
  CheckpointTriggerConfigRecord,
  ToolDefinitionRecord
} from '../../../../shared/protocol';
import { STORAGE_VERSION } from '../../../capabilities/vscodeStorage/constants';
import { isPathInside } from '../../../capabilities/filesystem/pathContainment';

export const DEFAULT_CHECKPOINT_MAX_BYTES = 50 * 1024 * 1024;

export const DEFAULT_CHECKPOINT_TRIGGERS: CheckpointTriggerConfigRecord = {
  conversationInitial: false,
  userMessageBefore: true,
  userMessageAfter: false,
  llmResponseBefore: false,
  llmResponseAfter: false,
  agentRunCompletedBefore: false,
  agentRunCompletedAfter: false,
  manual: true
};

export const DEFAULT_CHECKPOINT_TOOL_TRIGGER: CheckpointToolTriggerConfigRecord = {
  before: true,
  after: false
};

export interface EmptyDirectoryManifest {
  schemaVersion: typeof STORAGE_VERSION;
  emptyDirectories: string[];
}

export function normalizeCheckpointPolicy(input: Partial<CheckpointPolicyRecord> & { id: string; name: string }): CheckpointPolicyRecord {
  const now = Date.now();
  return {
    id: input.id,
    name: input.name.trim() || '存档点策略',
    enabled: input.enabled ?? true,
    initialSnapshotMaxBytes: normalizeByteLimit(input.initialSnapshotMaxBytes),
    preserveEmptyDirectories: input.preserveEmptyDirectories ?? true,
    useGitignore: input.useGitignore ?? true,
    skipPatterns: uniquePatterns(input.skipPatterns),
    triggers: { ...DEFAULT_CHECKPOINT_TRIGGERS, ...(input.triggers ?? {}) },
    toolTriggers: normalizeCheckpointToolTriggers(input.toolTriggers),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  };
}

export function workspaceContainsProject(workspaceFolderUris: readonly string[], projectUri: string): boolean {
  const projectPath = fsPathFromUri(projectUri);
  if (!projectPath) return false;
  return workspaceFolderUris.some((uri) => {
    const workspacePath = fsPathFromUri(uri);
    return !!workspacePath && isPathInside(workspacePath, projectPath);
  });
}

export function emptyDirectoryManifest(paths: readonly string[]): EmptyDirectoryManifest {
  return {
    schemaVersion: STORAGE_VERSION,
    emptyDirectories: [...new Set(paths.map(normalizeRelativePath).filter(Boolean))].sort()
  };
}

export function triggerConfigKey(trigger: string): keyof CheckpointTriggerConfigRecord | undefined {
  switch (trigger) {
    case 'conversation_initial': return 'conversationInitial';
    case 'user_message_before': return 'userMessageBefore';
    case 'user_message_after': return 'userMessageAfter';
    case 'llm_response_before': return 'llmResponseBefore';
    case 'llm_response_after': return 'llmResponseAfter';
    case 'agent_run_completed_before': return 'agentRunCompletedBefore';
    case 'agent_run_completed_after': return 'agentRunCompletedAfter';
    case 'manual': return 'manual';
    default: return undefined;
  }
}

export function normalizeCheckpointToolTriggers(
  input: Record<string, Partial<CheckpointToolTriggerConfigRecord>> | undefined
): Record<string, CheckpointToolTriggerConfigRecord> {
  const result: Record<string, CheckpointToolTriggerConfigRecord> = {};
  for (const [rawName, config] of Object.entries(input ?? {})) {
    const toolName = rawName.trim();
    if (!toolName) continue;
    result[toolName] = normalizeCheckpointToolTriggerConfig(config);
  }
  return result;
}

export function mergeCheckpointToolTriggers(
  base: Record<string, Partial<CheckpointToolTriggerConfigRecord>> | undefined,
  override: Record<string, Partial<CheckpointToolTriggerConfigRecord>> | undefined
): Record<string, CheckpointToolTriggerConfigRecord> {
  const result = normalizeCheckpointToolTriggers(base);
  for (const [rawName, config] of Object.entries(override ?? {})) {
    const toolName = rawName.trim();
    if (!toolName) continue;
    result[toolName] = normalizeCheckpointToolTriggerConfig({ ...(result[toolName] ?? {}), ...config });
  }
  return result;
}

export function defaultCheckpointToolTriggerForDefinition(tool: ToolDefinitionRecord | undefined): CheckpointToolTriggerConfigRecord {
  return normalizeCheckpointToolTriggerConfig(tool?.metadata?.checkpoint);
}

export function effectiveCheckpointToolTriggerConfig(
  toolName: string,
  input: Record<string, Partial<CheckpointToolTriggerConfigRecord>> | undefined,
  tool: ToolDefinitionRecord | undefined
): CheckpointToolTriggerConfigRecord {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) return { ...DEFAULT_CHECKPOINT_TOOL_TRIGGER };
  const defaults = defaultCheckpointToolTriggerForDefinition(tool);
  const configured = input?.[normalizedToolName];
  return normalizeCheckpointToolTriggerConfig({ ...defaults, ...(configured ?? {}) });
}

function normalizeCheckpointToolTriggerConfig(input: Partial<CheckpointToolTriggerConfigRecord> | undefined): CheckpointToolTriggerConfigRecord {
  return {
    before: input?.before ?? DEFAULT_CHECKPOINT_TOOL_TRIGGER.before,
    after: input?.after ?? DEFAULT_CHECKPOINT_TOOL_TRIGGER.after
  };
}

export function safeStorageKey(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'shadow-repo';
}

function normalizeByteLimit(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : DEFAULT_CHECKPOINT_MAX_BYTES;
}

function uniquePatterns(patterns: readonly string[] | undefined): string[] {
  const result: string[] = [];
  for (const raw of patterns ?? []) {
    const pattern = raw.replace(/\r?\n/g, '');
    if (!pattern.trim() || result.includes(pattern)) continue;
    result.push(pattern);
  }
  return result;
}

function fsPathFromUri(uri: string): string | undefined {
  try {
    if (uri.startsWith('file:')) return fileURLToPath(uri);
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}
