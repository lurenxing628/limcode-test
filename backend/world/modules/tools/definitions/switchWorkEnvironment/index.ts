import { SWITCH_WORK_ENVIRONMENT_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';

export const switchWorkEnvironmentToolModule = defineToolDefinitionModule({
  id: SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
  create() {
    return switchWorkEnvironmentTool;
  }
});

export const switchWorkEnvironmentTool: ToolDefinition = {
  declaration: {
    name: SWITCH_WORK_ENVIRONMENT_TOOL_NAME,
    description: `Validate the work environment frozen for the current reliable Turn. The work environment determines the root directory that tools like read, edit, write, and shell/bash use when resolving relative paths and the default cwd.

Reliable Turn authority is immutable: passing the already-active work environment id succeeds as an idempotent no-op, while requesting a different id is rejected. Select a different conversation work environment before starting the next Turn.`,
    parameters: {
      type: 'object',
      properties: {
        workEnvironmentId: {
          type: 'string',
          description: 'Target work environment id. Use one of the work environment ids listed in the tool definition.'
        }
      },
      required: ['workEnvironmentId']
    },
    metadata: {
      category: 'general',
      scope: 'workEnvironment',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: false,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'work_environment_switch'),
  summary: summarizeSwitchWorkEnvironmentToolCall,
  async execute() {
    // 生产 dispatcher 只校验 Turn 已冻结的工作环境；直接 executor 不执行切换。
    return { ok: false, output: 'switch_work_environment 必须由可靠工具规划器处理。' };
  }
};

function summarizeSwitchWorkEnvironmentToolCall(rawArgs: unknown): string | undefined {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as { workEnvironmentId?: unknown }
    : undefined;
  const target = typeof args?.workEnvironmentId === 'string' && args.workEnvironmentId.trim()
    ? args.workEnvironmentId.trim()
      : undefined;
  return target ? `切换工作环境 · ${target}` : '切换工作环境';
}
