import type { CommandCapability, FsCapability, SkillCatalogCapability, WorkEnvironmentRuntimeCapability } from '../../../capabilities/types';
import type {
  ToolCallEventKind,
  ToolConfigRecord,
  ToolConfigSchemaRecord,
  ToolDefinitionMetadataRecord,
  ToolDefinitionRecord,
  ToolDefinitionSourceRecord,
  ToolExecutionKind,
  InlineDataPart,
  LlmInvocationSettingsSnapshotRecord,
  WorkEnvironmentRecord
} from '../../../../shared/protocol';
import type { ToolSchedulingResolver } from './schedulingContract';

export interface ToolAttachmentCapability {
  /** Returns a metadata-only managed reference. Provider preparation resolves bytes on demand. */
  reference(attachmentId: string): Promise<InlineDataPart>;
  /** Resolves immutable bytes only when a tool must inspect the attachment body itself. */
  resolve?(attachmentId: string): Promise<InlineDataPart>;
}

export interface ToolDeps {
  fs: FsCapability;
  command: CommandCapability;
  workEnvironment: WorkEnvironmentRuntimeCapability;
  skills: SkillCatalogCapability;
  attachments?: ToolAttachmentCapability;
}

export interface ToolBackgroundProcessHandoff {
  id: string;
  processId: string;
  status: 'running';
}

export interface ToolResultOut {
  ok: boolean;
  output: unknown;
  parts?: InlineDataPart[];
  status?: 'success' | 'warning' | 'awaiting_change_apply';
  /** Tool Attempt 完成前已持久化并移交给 ProcessManager 的独立进程引用。 */
  backgroundProcesses?: ToolBackgroundProcessHandoff[];
}

export interface ToolRuntimeEvent {
  kind: Extract<ToolCallEventKind, 'stdout' | 'stderr' | 'progress'>;
  delta?: string;
  progress?: unknown;
  payload?: unknown;
}

export interface ToolExecutionContext {
  toolCallId: string;
  runId?: string;
  conversationId?: string;
  attemptId?: string;
  generation?: number;
  config?: ToolConfigRecord;
  settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
  workEnvironment?: WorkEnvironmentRecord;
  workEnvironments?: WorkEnvironmentRecord[];
  accessibleWorkEnvironments?: WorkEnvironmentRecord[];
  /** Attachment byte budget captured by the runtime host for this tool execution. */
  attachmentMaxBytes?: number;
  /** Directories of the skills this Turn may use; read serves their bundled files (see localReadOnlyRoots). */
  skillDirectories?: readonly string[];
  /** 用户中断时触发；工具可将其透传给底层调用（如 MCP callTool、fetch）以尽力真中断。 */
  signal?: AbortSignal;
  emit(event: ToolRuntimeEvent): void;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: unknown;
  source?: ToolDefinitionSourceRecord;
  metadata?: ToolDefinitionMetadataRecord;
  configSchema?: ToolConfigSchemaRecord;
  defaultConfig?: ToolConfigRecord;
}

export interface ToolCallSummaryContext {
  toolName: string;
  argsJson: string;
  progress?: unknown;
  result?: unknown;
}

/**
 * 工具调用收起条摘要。由工具定义根据调用参数及当前运行状态临时生成，前端只展示投影结果。
 */
export type ToolCallSummaryResolver = (args: unknown, context: ToolCallSummaryContext) => string | undefined;

export interface RuntimeToolDefinition {
  declaration: ToolDeclaration;
  execution: 'runtime';
  scheduling?: ToolSchedulingResolver;
  summary?: ToolCallSummaryResolver;
  execute(args: unknown, deps: ToolDeps, ctx?: ToolExecutionContext): Promise<ToolResultOut>;
}

export interface AgentRunToolDefinition {
  declaration: ToolDeclaration;
  execution: 'agentRun';
  scheduling?: ToolSchedulingResolver;
  summary?: ToolCallSummaryResolver;
}

export type ToolDefinition = RuntimeToolDefinition | AgentRunToolDefinition;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  public register(def: ToolDefinition): this {
    this.tools.set(def.declaration.name, def);
    return this;
  }

  public registerMany(definitions: readonly ToolDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  public get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  public schemas(): ToolDeclaration[] {
    return this.list().map((tool) => tool.declaration);
  }

  public records(): ToolDefinitionRecord[] {
    return this.list().map((tool) => toolDefinitionRecord(tool));
  }
}

export function toolDefinitionRecord(tool: ToolDefinition): ToolDefinitionRecord {
  return {
    id: tool.declaration.name,
    name: tool.declaration.name,
    description: tool.declaration.description,
    parameters: tool.declaration.parameters,
    execution: tool.execution as ToolExecutionKind,
    ...(tool.declaration.source ? { source: tool.declaration.source } : {}),
    ...(tool.declaration.metadata ? { metadata: tool.declaration.metadata } : {}),
    ...(tool.declaration.configSchema ? { configSchema: tool.declaration.configSchema } : {}),
    ...(tool.declaration.defaultConfig ? { defaultConfig: tool.declaration.defaultConfig } : {})
  };
}
