import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
import { ToolArgumentError } from '../../../../../../shared/toolArgumentUtils';
import type { ToolDefinition } from '../../registry';
import { defineToolDefinitionModule } from '../types';

export const ANTIGRAVITY_TOOL_NAME = 'antigravity';
export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-4-neon-high';
export const ANTIGRAVITY_DEFAULT_TIMEOUT_MINUTES = 30;
export const ANTIGRAVITY_MAX_TIMEOUT_MINUTES = 120;
const PROMPT_MAX_CHARS = 200_000;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Static on purpose: the tool description is part of every request's cached prefix, so it must not
 * change with `agy models` network results. agy itself rejects an unknown slug at run time.
 */
const MODEL_GUIDE = [
  'gemini-4-neon-{low,medium,high,xhigh}: fast general coding (default gemini-4-neon-high)',
  'gemini-4-hydrogen-{low,medium,high,xhigh}: stronger reasoning for harder tasks',
  'gemini-4-carbon-{low,medium,high}, gemini-4-argon-{low,medium,high}: alternative Gemini 4 variants',
  'gemini-3.8-flash-{low,medium,high}: cheapest and quickest, for simple edits or lookups',
  'claude-opus-5-5-{low,medium,high}, claude-sonnet-5-5-{low,medium,high}: Claude models served through Antigravity',
  'gpt-oss-120b-medium'
];

export type AntigravityOperation = 'start' | 'send' | 'read' | 'stop';

export interface AntigravityToolArguments {
  operation: AntigravityOperation;
  prompt?: string;
  model?: string;
  agyConversationId?: string;
  cwd?: string;
  processId?: string;
  outputHandle?: string;
}

export const antigravityToolModule = defineToolDefinitionModule({
  id: ANTIGRAVITY_TOOL_NAME,
  create() {
    return antigravityTool;
  }
});

export const antigravityTool: ToolDefinition = {
  declaration: {
    name: ANTIGRAVITY_TOOL_NAME,
    description: [
      'Delegate a self-contained task to an Antigravity agent (the agy CLI) that works headlessly in the workspace with full permissions: it reads and writes files and runs commands without asking for approval.',
      'operation=start begins a new agy conversation; operation=send continues an earlier one by agyConversationId (follow-ups, fixes). Both run in the background and return a processRef at once. Progress streams to the background command panel, and the final answer arrives automatically as a background result when agy finishes, so do not poll. operation=read reads the output of a processRef only when you need to check progress; operation=stop terminates it.',
      'agy cannot ask questions. Give it the full context, constraints, files to touch and acceptance criteria in prompt. Afterwards review its changes yourself (git diff, tests) before relying on them.',
      `model is an agy model slug; omit it to use the configured default. Known slugs:\n- ${MODEL_GUIDE.join('\n- ')}`
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['start', 'send', 'read', 'stop'],
          description: 'Defaults to start. start/send need prompt; send also needs agyConversationId; read/stop need the process reference.'
        },
        prompt: {
          type: 'string',
          description: 'For start/send: the task or follow-up message for agy, with everything it needs to finish without asking.'
        },
        model: {
          type: 'string',
          description: 'For start/send: agy model slug. Omit to use the configured default.'
        },
        agyConversationId: {
          type: 'string',
          description: 'For send only: the agy conversation ID printed in an earlier antigravity result.'
        },
        cwd: {
          type: 'string',
          description: 'For start/send: working directory relative to the workspace root. Defaults to the workspace root.'
        },
        processId: {
          type: 'string',
          description: 'For read/stop only: the process reference returned by an earlier start/send result or background notification.'
        },
        outputHandle: {
          type: 'string',
          description: 'For read only: omit on the first read; pass the next cursor from the previous read to continue.'
        }
      }
    },
    metadata: {
      category: 'agent',
      scope: 'command',
      riskLevel: 'agent',
      readonly: false,
      defaultEnabled: false,
      requiresApproval: true,
      defaultAutoApproveExecution: true
    },
    configSchema: {
      fields: [
        {
          key: 'agyPath',
          label: 'agy 可执行文件路径',
          type: 'string',
          description: '留空时自动查找（Windows 默认 %LOCALAPPDATA%\\agy\\bin\\agy.exe，其他系统找 PATH 和 ~/.local/bin）。找不到 agy 时这个工具不会出现在模型的工具列表里。',
          placeholder: '例如：C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe'
        },
        {
          key: 'defaultModel',
          label: '默认模型',
          type: 'string',
          description: '主 Agent 没有指定模型时使用。',
          defaultValue: ANTIGRAVITY_DEFAULT_MODEL,
          placeholder: ANTIGRAVITY_DEFAULT_MODEL
        },
        {
          key: 'executionTimeoutMinutes',
          label: '单次运行超时（分钟）',
          type: 'number',
          description: `超过时间后结束 agy 进程，可在 1–${ANTIGRAVITY_MAX_TIMEOUT_MINUTES} 分钟之间设置。被结束的对话之后仍可用 send 继续。`,
          defaultValue: ANTIGRAVITY_DEFAULT_TIMEOUT_MINUTES
        }
      ]
    },
    defaultConfig: {
      agyPath: '',
      defaultModel: ANTIGRAVITY_DEFAULT_MODEL,
      executionTimeoutMinutes: ANTIGRAVITY_DEFAULT_TIMEOUT_MINUTES
    }
  },
  execution: 'runtime',
  scheduling: (rawArgs) => {
    const operation = isRecord(rawArgs) ? rawArgs.operation : undefined;
    return operation === 'read'
      ? { mode: 'parallel', reason: 'antigravity_read' }
      : { mode: 'serial', reason: 'antigravity_side_effect' };
  },
  summary: summarizeAntigravityToolCall,
  async execute() {
    // The reliable dispatcher runs agy as a background process; a direct executor has no process plane.
    return { ok: false, output: 'antigravity 必须由可靠运行内核执行。' };
  }
};

export function validateAntigravityToolArguments(raw: unknown): AntigravityToolArguments {
  if (!isRecord(raw)) throw new ToolArgumentError('antigravity 参数必须是对象。');
  const operationText = optionalText(raw.operation) ?? 'start';
  if (!['start', 'send', 'read', 'stop'].includes(operationText)) {
    throw new ToolArgumentError('operation 只能是 start、send、read 或 stop。');
  }
  const operation = operationText as AntigravityOperation;
  if (operation === 'read' || operation === 'stop') {
    const processId = optionalText(raw.processId);
    if (!processId) throw new ToolArgumentError(`operation=${operation} 需要 processId。`);
    const outputHandle = operation === 'read' ? optionalText(raw.outputHandle) : undefined;
    return { operation, processId, ...(outputHandle ? { outputHandle } : {}) };
  }
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) throw new ToolArgumentError(`operation=${operation} 需要非空的 prompt。`);
  if (prompt.length > PROMPT_MAX_CHARS) throw new ToolArgumentError(`prompt 不能超过 ${PROMPT_MAX_CHARS} 个字符。`);
  const model = optionalText(raw.model);
  if (model !== undefined && !MODEL_PATTERN.test(model)) throw new ToolArgumentError('model 必须是 agy 的模型名，例如 gemini-4-neon-high。');
  const agyConversationId = optionalText(raw.agyConversationId);
  if (operation === 'send' && !agyConversationId) throw new ToolArgumentError('operation=send 需要 agyConversationId。');
  if (operation === 'start' && agyConversationId) {
    throw new ToolArgumentError('operation=start 会开新对话，不要传 agyConversationId；要继续已有对话请用 operation=send。');
  }
  if (agyConversationId !== undefined && !CONVERSATION_ID_PATTERN.test(agyConversationId)) {
    throw new ToolArgumentError('agyConversationId 格式无效，请原样复制之前结果里的对话 ID。');
  }
  const cwd = optionalText(raw.cwd);
  return {
    operation,
    prompt,
    ...(model ? { model } : {}),
    ...(agyConversationId ? { agyConversationId } : {}),
    ...(cwd ? { cwd } : {})
  };
}

/** The configured agy path, or the CLI's default install locations; undefined when none exists. */
export function resolveAgyExecutable(config: ToolConfigRecord | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = typeof config?.agyPath === 'string' ? config.agyPath.trim() : '';
  if (configured) return isFile(configured) ? configured : undefined;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(localAppData, 'agy', 'bin', 'agy.exe'));
  } else {
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'agy'));
  }
  const executable = process.platform === 'win32' ? 'agy.exe' : 'agy';
  for (const directory of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (directory.trim()) candidates.push(path.join(directory.trim(), executable));
  }
  return candidates.find(isFile);
}

export function antigravityDefaultModel(config: ToolConfigRecord | undefined): string {
  const configured = typeof config?.defaultModel === 'string' ? config.defaultModel.trim() : '';
  return configured && MODEL_PATTERN.test(configured) ? configured : ANTIGRAVITY_DEFAULT_MODEL;
}

export function antigravityExecutionTimeoutMs(config: ToolConfigRecord | undefined): number {
  const minutes = typeof config?.executionTimeoutMinutes === 'number' && Number.isFinite(config.executionTimeoutMinutes)
    ? Math.round(config.executionTimeoutMinutes)
    : ANTIGRAVITY_DEFAULT_TIMEOUT_MINUTES;
  return Math.min(ANTIGRAVITY_MAX_TIMEOUT_MINUTES, Math.max(1, minutes)) * 60_000;
}

function summarizeAntigravityToolCall(rawArgs: unknown): string | undefined {
  if (!isRecord(rawArgs)) return undefined;
  const operation = optionalText(rawArgs.operation) ?? 'start';
  if (operation === 'read') return '读取 Antigravity 进度';
  if (operation === 'stop') return '停止 Antigravity';
  const prompt = optionalText(rawArgs.prompt);
  const model = optionalText(rawArgs.model);
  const head = prompt ? prompt.replace(/\s+/g, ' ').slice(0, 120) : '';
  return [operation === 'send' ? '继续 Antigravity 对话' : 'Antigravity', model, head].filter(Boolean).join(' · ');
}

function isFile(candidate: string): boolean {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
