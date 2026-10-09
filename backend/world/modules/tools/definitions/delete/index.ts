import { DELETE_TOOL_NAME } from '../../../../../../shared/protocol';
import type { FsDeletePathResult } from '../../../../../capabilities/types';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig } from '../filePathPolicy';
import { defineToolDefinitionModule } from '../types';
import { normalizeDisplayPath } from '../../../../../../shared/displayPath';
import { validateDeleteToolArguments } from '../../../../../../shared/fileToolArguments';
import { ToolArgumentError } from '../../../../../../shared/toolArgumentUtils';

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
      'Dry-run and non-recursive directory deletion are not supported by this tool.',
      'Supports relative paths and absolute paths. Relative paths are resolved from the current work environment root; by default this tool only allows paths inside the current project root or explicitly allowed local work environment roots.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          minItems: 1,
          description: 'File or directory paths to delete. Always use an array, even for one path. Relative paths are resolved from the current work environment root; absolute paths are supported when allowed by tool policy or when they are inside an explicitly allowed local work environment root.',
          items: { type: 'string', minLength: 1, description: 'File or directory path to delete.' }
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
    let args: ReturnType<typeof validateDeleteToolArguments>;
    try { args = validateDeleteToolArguments(rawArgs); }
    catch (error) {
      if (!(error instanceof ToolArgumentError)) throw error;
      return { ok: false, output: error.message };
    }

    const allowOutsideProjectPaths = allowOutsideProjectPathsFromConfig(ctx?.config, false);
    const paths: DeletePathStatusItem[] = [];

    for (const inputPath of args.paths) {
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

function toDeletePathStatusItem(result: FsDeletePathResult): DeletePathStatusItem {
  return {
    path: result.path,
    success: true
  };
}

function summarizeDeleteToolCall(rawArgs: unknown): string | undefined {
  let args: ReturnType<typeof validateDeleteToolArguments>;
  try { args = validateDeleteToolArguments(rawArgs); }
  catch { return undefined; }
  const first = normalizeDisplayPath(args.paths[0]);
  if (!first) return undefined;
  const suffix = args.paths.length > 1 ? ` +${args.paths.length - 1}` : '';
  return `delete ${first}${suffix}`;
}
