import type {
  CommandCapability,
  CommandOutputLimits,
  CommandRunArgs,
  CommandRunObserver,
  CommandRunResult,
  WorkEnvironmentCapabilityOptions
} from '../capabilities/types';
import { defaultToolNames } from '../../shared/toolPolicyResolution';
import { createBuiltinToolDefinitions } from '../world/modules/tools/definitions';

/**
 * Declaration-only command capability for this host platform. The reliable kernel runs processes
 * through ProcessControlPlane, so every execution entry here refuses.
 */
export function commandDeclarationCapability(): CommandCapability {
  const toolName: 'shell' | 'bash' = process.platform === 'win32' ? 'shell' : 'bash';
  const unavailable = (): never => {
    throw new Error(`${toolName} execution must use reliable ProcessControlPlane.`);
  };
  return {
    toolName,
    executable: undefined,
    description: `${toolName === 'shell' ? 'Run a non-interactive PowerShell command' : 'Run a non-interactive Bash/Shell command'} in the project workspace. Returns stdout, stderr, and exitCode. Foreground wait moves a still-running process to the reliable detached wrapper; running results carry exitCode=null.`,
    run(_args: CommandRunArgs, _observer?: CommandRunObserver, _options?: WorkEnvironmentCapabilityOptions, _limits?: CommandOutputLimits): Promise<CommandRunResult> {
      return Promise.reject(unavailable());
    },
    backgroundForeground: unavailable,
    readOutput: unavailable,
    kill: unavailable,
    quiesce() {},
    dispose() {}
  } as CommandCapability;
}

let builtinDefaults: readonly string[] | undefined;

/**
 * The default tool set over this host's builtin catalog, the same catalog the ToolHost offers and
 * the settings page lists. MCP tools never belong to it, so the builtin catalog decides it alone.
 */
export function builtinDefaultToolNames(): readonly string[] {
  builtinDefaults ??= Object.freeze(defaultToolNames(
    createBuiltinToolDefinitions({ command: commandDeclarationCapability() }).map((definition) => definition.declaration)
  ));
  return builtinDefaults;
}
