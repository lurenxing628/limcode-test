import { EDIT_TOOL_NAME, type EditToolMode } from '../../../../../../shared/protocol';
import { selectEditToolMode, validateEditToolArguments, type ValidatedEditToolArguments } from '../../../../../../shared/editToolArguments';
import type { FsEditFileRequest } from '../../../../../capabilities/types';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig, filePathPolicyDescription } from '../filePathPolicy';
import { normalizeDisplayPath } from '../../../../../../shared/displayPath';

interface EditArgs {
  path?: string;
  hunks?: unknown;
  insert?: { line?: number; content?: string };
  delete?: { startLine?: number; endLine?: number };
}

export const editToolModule = defineToolDefinitionModule({
  id: EDIT_TOOL_NAME,
  create() {
    return editTool;
  }
});

export const editTool: ToolDefinition = {
  declaration: {
    name: EDIT_TOOL_NAME,
    description: editToolDescription(),
    parameters: editToolParameters(),
    metadata: {
      category: 'filesystem',
      scope: 'file',
      riskLevel: 'write',
      readonly: false,
      defaultEnabled: true,
      defaultAutoExpand: true,
      defaultAutoApproveExecution: false,
      supportsChangeApply: true,
      supportsDiffPreview: true,
      defaultAutoOpenDiffPreview: false,
      defaultAutoApplyChange: true,
      defaultAutoApplyChangeDelaySeconds: 3,
      requiresApproval: true,
      checkpoint: { before: true, after: true }
    },
    configSchema: {
      fields: [allowOutsideProjectPathsField(false)]
    },
    defaultConfig: { ...allowOutsideProjectPathsDefaultConfig(false) }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'filesystem_edit_side_effect'),
  summary: summarizeEditToolCall,
  async execute(rawArgs, deps, ctx) {
    const runtimeMode = selectEditToolMode(rawArgs);
    try {
      const args = validateEditToolArguments(rawArgs);
      const displayPath = normalizeDisplayPath(args.path);
      const request = buildEditRequest(args, displayPath);
      const result = await deps.fs.proposeEditFile(request, {
        workEnvironment: ctx?.workEnvironment,
        accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments,
        allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, false)
      });
      return {
        ok: result.success,
        output: result,
        ...(result.pending ? { status: 'awaiting_change_apply' as const } : result.failed > 0 ? { status: 'warning' as const } : {})
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const displayPath = normalizeDisplayPath((rawArgs as EditArgs | undefined)?.path);
      return { ok: false, output: failedOutput(runtimeMode, displayPath, message) };
    }
  }
};

export function editToolDescription(): string {
  return [hunkModeDescription(), insertDeleteDescription()].join('\n');
}

export function editToolParameters(): unknown {
  const base = hunkModeParameters() as { type: string; properties: Record<string, unknown>; required: string[] };
  return {
    ...base,
    description: 'Provide exactly one edit branch: non-empty hunks, insert, or delete. Do not combine branches.',
    properties: {
      ...base.properties,
      insert: insertModeParameters(),
      delete: deleteModeParameters()
    },
    required: ['path'],
    oneOf: [
      { required: ['hunks'], properties: { hunks: { minItems: 1 } } },
      { required: ['insert'], properties: { insert: { required: ['line', 'content'] } } },
      { required: ['delete'], properties: { delete: { required: ['startLine', 'endLine'] } } }
    ]
  };
}

export function hunkModeDescription(): string {
  return [
    'Modify one UTF-8 text file using hunk-style search/replace.',
    'Primary hunk arguments: { path, hunks }. hunks is an ordered array; each hunk is { oldContent, newContent, replaceAll? }.',
    'Each oldContent is matched as exact existing text against the current file after prior hunks are applied. By default only the first match is replaced for that hunk. Set hunk.replaceAll=true to replace every non-overlapping match.',
    'Use multiple hunks in one call for multiple independent edits in the same file. Use write for new files or full rewrites. Use insert/delete for line-based edits.',
    filePathPolicyDescription(false)
  ].join('\n');
}

export function hunkModeParameters(): unknown {
  return {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path. Relative paths are resolved from the current work environment root; absolute paths are supported when allowed by tool policy or when they are inside an explicitly allowed local work environment root.' },
      hunks: {
        type: 'array',
        minItems: 1,
        description: 'Ordered hunk blocks. This branch is mutually exclusive with insert and delete. Each hunk performs exact search/replace in this same file.',
        items: {
          type: 'object',
          properties: {
            oldContent: { type: 'string', minLength: 1, description: 'Existing file text to find. Must be an exact non-empty substring of the current file at the time this hunk runs.' },
            newContent: { type: 'string', description: 'Replacement text exactly as it should appear in the final file. Use an empty string to remove the matched text.' },
            replaceAll: { type: 'boolean', description: 'Whether this hunk replaces every non-overlapping oldContent match. Defaults to false, replacing only the first match.' }
          },
          required: ['oldContent', 'newContent'],
          additionalProperties: false
        }
      }
    },
    required: ['path'],
    additionalProperties: false
  };
}

export function insertDeleteDescription(): string {
  return [
    '',
    'Line-based modes remain available:',
    '- insert: provide insert={ line, content } to insert text before the given 1-based line number. Use line N+1 to append after the last line.',
    '- delete: provide delete={ startLine, endLine } to remove lines in the inclusive range [startLine, endLine].',
    'Provide exactly one of hunks, insert, or delete. When using insert or delete, hunks is not required.'
  ].join('\n');
}

export function insertModeParameters(): unknown {
  return {
    type: 'object',
    description: 'Line insertion branch. Do not provide it together with hunks or delete.',
    properties: {
      line: { type: 'integer', minimum: 1, description: '1-based line number before which to insert content. Use line N+1 to append after the last line.' },
      content: { type: 'string', minLength: 1, description: 'Non-empty text to insert at the specified line position. May contain multiple lines separated by newlines.' }
    },
    required: ['line', 'content'],
    additionalProperties: false
  };
}

export function deleteModeParameters(): unknown {
  return {
    type: 'object',
    description: 'Line deletion branch. Do not provide it together with hunks or insert.',
    properties: {
      startLine: { type: 'integer', minimum: 1, description: '1-based first line to delete (inclusive).' },
      endLine: { type: 'integer', minimum: 1, description: '1-based last line to delete (inclusive).' }
    },
    required: ['startLine', 'endLine'],
    additionalProperties: false
  };
}

function buildEditRequest(args: ValidatedEditToolArguments, path: string): FsEditFileRequest {
  if (args.mode === 'insert') return { path, mode: 'insert', insert: args.insert };
  if (args.mode === 'delete') return { path, mode: 'delete', delete: args.delete };
  return { path, mode: 'hunk', hunks: args.hunks };
}

function failedOutput(mode: EditToolMode, path: string, error: string): Record<string, unknown> {
  return {
    kind: 'file_edit.result',
    mode,
    path,
    success: false,
    error,
    summary: `edit(${mode}) failed: ${error}`
  };
}

function summarizeEditToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as EditArgs;
  const path = normalizeDisplayPath(args.path);
  return path ? `edit ${path}` : undefined;
}
