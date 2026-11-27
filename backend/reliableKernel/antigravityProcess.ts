import {
  ANTIGRAVITY_RUNNER_FILE,
  encodeAntigravityRunnerRequest,
  type AntigravityRunnerRequest
} from './antigravityRunner';

/**
 * The background-process command for one antigravity turn: the extension's own Node runtime runs the
 * shipped runner, which reads its request from stdin. The prompt rides inside base64 there, so the
 * command needs no quoting of model-written text and stays far below argument-length limits.
 */
export function antigravityProcessCommand(
  request: AntigravityRunnerRequest,
  options: { platform?: NodeJS.Platform; nodeExecutable?: string; runnerFile?: string } = {}
): string {
  const platform = options.platform ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const runnerFile = options.runnerFile ?? ANTIGRAVITY_RUNNER_FILE;
  const payload = encodeAntigravityRunnerRequest(request);
  if (platform === 'win32') {
    const quote = (value: string) => `'${value.split("'").join("''")}'`;
    return `$env:ELECTRON_RUN_AS_NODE = '1'; '${payload}' | & ${quote(nodeExecutable)} ${quote(runnerFile)}`;
  }
  const quote = (value: string) => `'${value.split("'").join("'\\''")}'`;
  return `printf %s '${payload}' | ELECTRON_RUN_AS_NODE=1 ${quote(nodeExecutable)} ${quote(runnerFile)}`;
}
