import { TRANSFER_TOOL_NAME } from '../../../../../../shared/protocol';
import type { WorkEnvironmentTransferArgs } from '../../../../../capabilities/types';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig } from '../filePathPolicy';

export const transferFilesToolModule = defineToolDefinitionModule({
  id: TRANSFER_TOOL_NAME,
  create() {
    return transferFilesTool;
  }
});

export const transferFilesTool: ToolDefinition = {
  declaration: {
    name: TRANSFER_TOOL_NAME,
    description: [
      'Transfer files or directories between work environments. Supports local workspace ↔ remote server, remote server ↔ remote server, and local ↔ local.',
      'fromEnvironment / toEnvironment each take the W# reference of a work environment listed in this description, or current for the currently active work environment. Work environment names and any other values are rejected.',
      'fromPath / toPath accept relative and absolute paths; relative paths are resolved against the root/workdir of fromEnvironment / toEnvironment respectively.',
      'A path ending with / or \\ denotes a directory; when type=auto, the kind is inferred from the stat result of the source path.',
      'overwrite defaults to false, so the transfer fails if the target exists; files are written via a temp file + verification + rename.',
      'The tool policy allows paths outside the project by default; when disabled, both the source and target paths must resolve inside their respective work environment roots.'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        transfers: {
          type: 'array',
          description: 'Array of transfer tasks. Must be an array, even when transferring a single file.',
          items: {
            type: 'object',
            properties: {
              fromEnvironment: { type: 'string', description: 'Source work environment: its W# reference from the listed work environments, or current for the currently active work environment.' },
              fromPath: { type: 'string', description: 'Source path, relative or absolute. Relative paths are resolved against the root/workdir of fromEnvironment; directories should end with / or \\.' },
              toEnvironment: { type: 'string', description: 'Target work environment: its W# reference from the listed work environments, or current for the currently active work environment.' },
              toPath: { type: 'string', description: 'Target path, relative or absolute. Relative paths are resolved against the root/workdir of toEnvironment; a directory path refers to the target directory itself.' },
              type: { type: 'string', enum: ['auto', 'file', 'directory'], description: 'Transfer type, defaults to auto.' },
              overwrite: { type: 'boolean', description: 'Whether to overwrite when the target exists, defaults to false.' },
              createDirs: { type: 'boolean', description: 'Whether to automatically create the target parent directory / target directory, defaults to true.' }
            },
            required: ['fromEnvironment', 'fromPath', 'toEnvironment', 'toPath']
          }
        },
        verify: { type: 'string', enum: ['none', 'size'], description: 'Verification mode. none = no verification; size = compare source/target file sizes (default).' }
      },
      required: ['transfers']
    },
    metadata: {
      category: 'filesystem',
      scope: 'file',
      riskLevel: 'write',
      readonly: false,
      defaultEnabled: false,
      requiresApproval: true,
      checkpoint: { before: true, after: true }
    },
    configSchema: { fields: [allowOutsideProjectPathsField(true)] },
    defaultConfig: allowOutsideProjectPathsDefaultConfig(true)
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'file_transfer_side_effect'),
  summary: summarizeTransferFilesToolCall,
  async execute(rawArgs, deps, ctx) {
    const args = (rawArgs ?? {}) as WorkEnvironmentTransferArgs;
    const result = await deps.workEnvironment.transferFiles(args, {
      onEvent(event) {
        ctx?.emit({
          kind: event.kind,
          ...(event.delta !== undefined ? { delta: event.delta } : {}),
          ...(event.payload !== undefined ? { payload: event.payload, progress: event.payload } : {})
        });
      }
    }, {
      activeWorkEnvironment: ctx?.workEnvironment,
      availableWorkEnvironments: ctx?.workEnvironments,
      allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, true),
      signal: ctx?.signal
    });
    return { ok: result.failCount === 0, output: result };
  }
};

function summarizeTransferFilesToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as WorkEnvironmentTransferArgs;
  const transfers = Array.isArray(args.transfers) ? args.transfers : [];
  const first = transfers[0];
  if (!first) return '传输文件';
  const from = [first.fromEnvironment, first.fromPath].filter(Boolean).join(':');
  const to = [first.toEnvironment, first.toPath].filter(Boolean).join(':');
  const suffix = transfers.length > 1 ? ` +${transfers.length - 1}` : '';
  return `${from} → ${to}${suffix}`;
}
