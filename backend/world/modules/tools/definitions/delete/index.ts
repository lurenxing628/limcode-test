import { DELETE_TOOL_NAME } from '../../../../../../shared/protocol';
import type { FsDeletePathResult } from '../../../../../capabilities/types';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig } from '../filePathPolicy';
import { defineToolDefinitionModule } from '../types';
import { normalizeDisplayPath } from '../../../../../../shared/displayPath';

interface DeleteArgs {
  paths?: unknown;
}

interface DeletePathStatusItem {
  path: string;
  success: boolean;
}

interface DeleteToolOutput {
  paths: DeletePathStatusItem[];
}

export const deleteToolModule = defineToolDefinitionModule({
  id: DELETE_TOOL_NAME,
  create() {
    return deleteTool;
  }
});

export const deleteTool: ToolDefinition = {
  declaration: {
    name: DELETE_TOOL_NAME,
    description: [
      'Delete one or more files/directories from the current work environment.',
      'Use this controlled delete tool first for simple file/folder deletion; avoid shell/bash/PowerShell/rm/del/Remove-Item for ordinary deletions.',
      'Always pass paths as an array, even for a single target. Each item can be a file or folder and is detected automatically. Directories are deleted recursively.',
      'Supports relative paths and absolute paths. Relative paths are resolved from the current work environment root; by default this tool only allows paths inside the current project root or explicitly allowed local work environment roots.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'File or directory paths to delete. Always use an array, even for one path. Relative paths are resolved from the current work environment root; absolute paths are supported when allowed by tool policy or when they are inside an explicitly allowed local work environment root.',
          items: { type: 'string', description: 'File or directory path to delete.' }
        }
      },
      required: ['paths']
    },
    metadata: {
      category: 'filesystem',
      scope: 'file',
      riskLevel: 'write',
      readonly: false,
      defaultEnabled: true,
      defaultAutoApproveExecution: false,
      defaultAutoExpand: true,
      supportsChangeApply: true,
      supportsDiffPreview: true,
      defaultAutoOpenDiffPreview: false,
      defaultAutoApplyChange: false,
      defaultAutoApplyChangeDelaySeconds: 3,
      requiresApproval: true,
      checkpoint: { before: true, after: true }
    },
    configSchema: { fields: [allowOutsideProjectPathsField(false)] },
    defaultConfig: allowOutsideProjectPathsDefaultConfig(false)
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'filesystem_delete_side_effect'),
  summary: summarizeDeleteToolCall,
  async execute(rawArgs, deps, ctx) {
    const parsed = deletePathsFromArgs(rawArgs);
    if (!parsed.ok) return { ok: false, output: parsed.error };

    const allowOutsideProjectPaths = allowOutsideProjectPathsFromConfig(ctx?.config, false);
    const paths: DeletePathStatusItem[] = [];

    for (const inputPath of parsed.paths) {
      try {
        const result = await deps.fs.deletePath(inputPath, {
          workEnvironment: ctx?.workEnvironment,
          accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments,
          allowOutsideProjectPaths
        });
        paths.push(toDeletePathStatusItem(result));
      } catch {
        paths.push({ path: inputPath, success: false });
      }
    }

    const output: DeleteToolOutput = { paths };
    return { ok: paths.every((item) => item.success), output };
  }
};

function deletePathsFromArgs(rawArgs: unknown): { ok: true; paths: string[] } | { ok: false; error: string } {
  const args = (rawArgs ?? {}) as DeleteArgs;
  if (!Array.isArray(args.paths)) return { ok: false, error: 'Missing required argument: paths (array)' };
  const paths: string[] = [];
  for (let index = 0; index < args.paths.length; index += 1) {
    const value = args.paths[index];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, error: `Invalid paths[${index}]: expected non-empty string` };
    }
    paths.push(value.trim());
  }
  if (paths.length === 0) return { ok: false, error: 'Missing required argument: paths must contain at least one path' };
  return { ok: true, paths };
}

function toDeletePathStatusItem(result: FsDeletePathResult): DeletePathStatusItem {
  return {
    path: result.path,
    success: true
  };
}

function summarizeDeleteToolCall(rawArgs: unknown): string | undefined {
  const parsed = deletePathsFromArgs(rawArgs);
  if (!parsed.ok) return undefined;
  const first = normalizeDisplayPath(parsed.paths[0]);
  if (!first) return undefined;
  const suffix = parsed.paths.length > 1 ? ` +${parsed.paths.length - 1}` : '';
  return `delete ${first}${suffix}`;
}
