import type { PromptPlaceholderRecord, RuntimeContextRecord } from './protocol';

/** Read-only defaults. User records, including an explicit empty template, take precedence. */
export const DEFAULT_RUNTIME_CONTEXT_TEMPLATE = `[Runtime Background]\n\nInitial time: {{$runtime.timestamp}}\nInitial date: {{$runtime.date}}\nPlatform: {{$platform.os}}\n\nInitial workspace:\n{{$workspace.name}}\n{{$workspace.uri}}\n{{$workEnvironment.currentSection}}`;
export const DEFAULT_RUNTIME_CONTEXT: Readonly<RuntimeContextRecord> = {
  id: 'builtin:runtime-context:global',
  name: '全局运行时上下文',
  template: DEFAULT_RUNTIME_CONTEXT_TEMPLATE
};

export const SYSTEM_PROMPT_PLACEHOLDERS: readonly PromptPlaceholderRecord[] = [
  { id: 'system:agent.name', token: '{{$agent.name}}', label: 'Agent 名称', description: '当前 Run 执行 Agent 的名称。', target: 'systemPrompt', order: 10 },
  { id: 'system:agent.description', token: '{{$agent.description}}', label: 'Agent 描述', description: '当前 Run 执行 Agent 的描述。', target: 'systemPrompt', order: 20 },
  { id: 'system:workflow.name', token: '{{$workflow.name}}', label: 'Workflow 名称', description: '当前 Run 选中的工作流名称；未选择工作流时为空。', target: 'systemPrompt', order: 30 },
  { id: 'system:workflow.description', token: '{{$workflow.description}}', label: 'Workflow 描述', description: '当前 Run 选中工作流的描述；未选择工作流时为空。', target: 'systemPrompt', order: 40 }
];

export const RUNTIME_CONTEXT_PLACEHOLDERS: readonly PromptPlaceholderRecord[] = [
  { id: 'runtime:runtime.timestamp', token: '{{$runtime.timestamp}}', label: '初始时间戳', description: '生成运行时快照时的 ISO 时间。', target: 'runtimeContext', order: 10 },
  { id: 'runtime:runtime.date', token: '{{$runtime.date}}', label: '初始日期', description: '生成运行时快照时的本地日期。', target: 'runtimeContext', order: 20 },
  { id: 'runtime:platform.os', token: '{{$platform.os}}', label: '平台', description: '当前扩展宿主的 process.platform。', target: 'runtimeContext', order: 30 },
  { id: 'runtime:workEnvironment.current', token: '{{$workEnvironment.current}}', label: '初始工作环境', description: '生成快照时对话可访问的工作环境；工作环境停用时仍会列出已允许的本地环境。', target: 'runtimeContext', order: 40 },
  { id: 'runtime:workEnvironment.currentSection', token: '{{$workEnvironment.currentSection}}', label: '初始工作环境段落', description: '输出 Initial work environment 段落；工作环境停用时仍会列出已允许的本地环境。', target: 'runtimeContext', order: 45 },
  { id: 'runtime:workspace.name', token: '{{$workspace.name}}', label: '工作区名称', description: '当前对话绑定的项目/工作区名称。', target: 'runtimeContext', order: 50 },
  { id: 'runtime:workspace.uri', token: '{{$workspace.uri}}', label: '工作区 URI', description: '当前对话绑定的项目/工作区 URI。', target: 'runtimeContext', order: 60 }
];

export const PROMPT_PLACEHOLDERS: readonly PromptPlaceholderRecord[] = [
  ...SYSTEM_PROMPT_PLACEHOLDERS,
  ...RUNTIME_CONTEXT_PLACEHOLDERS
];
