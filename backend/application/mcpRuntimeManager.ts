import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfigRecord, McpServersSettingsRecord, McpToolSourceRecord } from '../../shared/protocol';
import { EXTENSION_PACKAGE_NAME, EXTENSION_VERSION } from '../../shared/extensionIdentity';
import type { ToolDefinition, ToolResultOut } from '../world/modules/tools/registry';
import { McpInvocationError, type McpMemoryConnectionRegistry, type McpToolAnnotations } from '../reliableKernel/mcpEffects';
import { createProxyFetch } from '../capabilities/proxyFetch';
import { normalizeProxySetting, proxyEnvironmentVariables } from './reliableKernel/proxyEnvironment';

interface McpConnection {
  config: McpServerConfigRecord;
  /** 连接建立时的有效代理；代理变更必须重建连接，不能复用旧 transport。 */
  proxy?: string;
  client: Client;
  transport: { close(): Promise<void> };
  tools: ToolDefinition[];
  annotations: Map<string, McpToolAnnotations>;
  status: McpToolSourceRecord;
}

export interface McpSettingsAuthority {
  loadGlobalSettings(section: 'mcpServers'): Promise<{ settings: unknown }>;
  /** 可选：解析全局代理设置（common.proxy）。缺省时 MCP 连接直连。 */
  resolveProxySetting?(): Promise<string | undefined>;
}

export class McpRuntimeManager implements McpMemoryConnectionRegistry {
  private readonly connections = new Map<string, McpConnection>();
  private readonly disabledSources = new Map<string, McpToolSourceRecord>();
  private refreshGeneration = 0;
  private activeRefresh: { generation: number; controller: AbortController; task: Promise<void> } | undefined;
  private onStateChange: (() => void) | undefined;
  private disposed = false;

  public constructor(private readonly storage: McpSettingsAuthority) {}

  public setStateChangeListener(listener: (() => void) | undefined): void {
    this.onStateChange = listener;
  }

  public refreshFromSettings(options: { discover: boolean } = { discover: true }): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('MCP Runtime manager is disposed.'));
    const generation = ++this.refreshGeneration;
    this.activeRefresh?.controller.abort(new Error('MCP settings refresh was superseded.'));
    const controller = new AbortController();
    const task = this.refreshNow(options, generation, controller.signal)
      .catch((error) => {
        if (!this.disposed && controller.signal.aborted && generation < this.refreshGeneration) {
          return this.activeRefresh?.task;
        }
        throw error;
      })
      .finally(() => {
        if (this.activeRefresh?.generation === generation) this.activeRefresh = undefined;
      });
    this.activeRefresh = { generation, controller, task };
    return task;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.activeRefresh?.controller.abort(new Error('MCP Runtime manager is disposing.'));
    await this.activeRefresh?.task.catch(() => undefined);
    await Promise.all([...this.connections.values()].map((connection) => closeConnection(connection)));
    this.connections.clear();
    this.disabledSources.clear();
  }

  /** Connected tools in source-id order, never in the order the servers happened to connect. */
  public runtimeTools(): ToolDefinition[] {
    return [...this.connections.values()]
      .sort((left, right) => compareSourceIds(left.config.id, right.config.id))
      .flatMap((connection) => connection.tools);
  }

  public async toolAnnotations(serverId: string, toolName: string): Promise<McpToolAnnotations> {
    const connection = this.connections.get(serverId);
    if (!connection) throw new McpInvocationError('not_dispatched', `MCP server is not connected: ${serverId}`);
    const annotations = connection.annotations.get(toolName);
    if (!annotations) throw new McpInvocationError('not_dispatched', `MCP tool is not available: ${serverId}/${toolName}`);
    return { ...annotations };
  }

  public async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const connection = this.connections.get(serverId);
    if (!connection || !connection.annotations.has(toolName)) {
      throw new McpInvocationError('not_dispatched', `MCP tool is not connected: ${serverId}/${toolName}`);
    }
    if (signal?.aborted) {
      throw new McpInvocationError('not_dispatched', `MCP tool was cancelled before dispatch: ${serverId}/${toolName}`);
    }
    try {
      return await connection.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        signal ? { signal } : undefined
      );
    } catch (error) {
      throw new McpInvocationError(
        'ambiguous_after_dispatch',
        `MCP call result cannot be proved after dispatch: ${messageFromError(error)}`
      );
    }
  }

  public sourceRecords(): McpToolSourceRecord[] {
    return [
      ...this.disabledSources.values(),
      ...[...this.connections.values()].map((connection) => connection.status)
    ].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id));
  }

  private async refreshNow(
    options: { discover: boolean },
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    const loaded = await this.storage.loadGlobalSettings('mcpServers');
    this.requireCurrentRefresh(generation, signal);
    // 每次刷新解析一次代理：设置变更后由 refreshFromSettings 重建连接，无需热改存量连接。
    const proxy = this.storage.resolveProxySetting
      ? normalizeProxySetting(await this.storage.resolveProxySetting())
      : undefined;
    this.requireCurrentRefresh(generation, signal);
    const settings = loaded.settings as McpServersSettingsRecord;
    const wanted = new Map(settings.servers.map((server) => [server.id, server]));
    const obsolete = [...this.connections].filter(([id, connection]) => {
      const next = wanted.get(id);
      return !next || !next.enabled || !sameConnectionConfig(connection.config, next) || connection.proxy !== proxy;
    });
    // Remove obsolete handles before the first await. A superseding generation must never observe
    // a connection which this generation has already committed to closing.
    for (const [id, connection] of obsolete) {
      if (this.connections.get(id) === connection) this.connections.delete(id);
    }
    if (obsolete.length > 0) this.notifyStateChange();
    await Promise.all(obsolete.map(([, connection]) => closeConnection(connection)));
    this.requireCurrentRefresh(generation, signal);

    this.disabledSources.clear();
    const connectable: McpServerConfigRecord[] = [];
    for (const server of settings.servers) {
      if (!server.enabled) {
        this.disabledSources.set(server.id, disabledSourceRecord(server));
        continue;
      }
      if (this.connections.has(server.id)) continue;
      if (!options.discover) {
        this.disabledSources.set(server.id, idleSourceRecord(server));
        continue;
      }
      const connecting = connectingSourceRecord(server);
      this.disabledSources.set(server.id, connecting);
      connectable.push(server);
    }
    this.notifyStateChange();
    await Promise.all(connectable.map(async (server) => {
      const connecting = connectingSourceRecord(server);
      try {
        const connection = await connectServer(server, signal, proxy);
        if (!this.isCurrentRefresh(generation, signal)) {
          await closeConnection(connection);
          return;
        }
        this.disabledSources.delete(server.id);
        this.connections.set(server.id, connection);
        this.notifyStateChange();
      } catch (error) {
        if (!this.isCurrentRefresh(generation, signal)) return;
        this.disabledSources.set(server.id, { ...connecting, status: 'error', lastError: messageFromError(error), updatedAt: Date.now() });
        this.notifyStateChange();
      }
    }));
    this.requireCurrentRefresh(generation, signal);
  }

  private isCurrentRefresh(generation: number, signal: AbortSignal): boolean {
    return !this.disposed && !signal.aborted && generation === this.refreshGeneration;
  }

  private requireCurrentRefresh(generation: number, signal: AbortSignal): void {
    if (this.isCurrentRefresh(generation, signal)) return;
    throw signal.reason instanceof Error ? signal.reason : new Error('MCP settings refresh was superseded.');
  }

  private notifyStateChange(): void {
    this.onStateChange?.();
  }
}

async function connectServer(config: McpServerConfigRecord, signal: AbortSignal, proxy?: string): Promise<McpConnection> {
  validateConnectableConfig(config);
  const { Client, getDefaultEnvironment, StdioClientTransport, StreamableHTTPClientTransport } = await loadMcpSdkRuntime();
  const client = new Client(
    { name: EXTENSION_PACKAGE_NAME, version: EXTENSION_VERSION },
    { capabilities: {} }
  );
  const transport = config.transport.kind === 'stdio'
    ? new StdioClientTransport({
        command: config.transport.command,
        args: config.transport.args,
        // SDK 默认环境是白名单（不含代理变量）；显式注入，用户配置的 env 仍可覆盖。
        env: { ...getDefaultEnvironment(), ...proxyEnvironmentVariables(proxy), ...(config.transport.env ?? {}) },
        cwd: config.transport.cwd,
        stderr: 'pipe'
      })
    : new StreamableHTTPClientTransport(new URL(config.transport.url), {
        requestInit: config.transport.headers ? { headers: config.transport.headers } : undefined,
        // HTTP MCP 的 standalone SSE 是长驻流，不能套用 LLM 请求的 60s idle / 15min overall deadline；
        // 连接生命周期由 MCP SDK 的 AbortSignal 管理，代理层只保留 CONNECT 建连超时。
        ...(proxy ? { fetch: createProxyFetch(proxy, { bodyIdleTimeoutMs: null, overallTimeoutMs: null }) } : {})
      });
  try {
    await client.connect(transport, { signal });
    const listed = await client.listTools(undefined, { signal });
    const tools = listed.tools.map((tool) => mcpToolDeclaration(config, tool));
    const annotations = new Map(listed.tools.map((tool) => [tool.name, {
      ...(tool.annotations?.readOnlyHint === undefined ? {} : { readOnlyHint: tool.annotations.readOnlyHint }),
      ...(tool.annotations?.destructiveHint === undefined ? {} : { destructiveHint: tool.annotations.destructiveHint })
    }]));
    return {
      config,
      ...(proxy ? { proxy } : {}),
      client,
      transport,
      tools,
      annotations,
      status: {
        id: config.id,
        name: config.name,
        transportKind: config.transport.kind,
        enabled: true,
        status: 'connected',
        toolCount: tools.length,
        updatedAt: Date.now()
      }
    };
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

interface McpSdkRuntime {
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  getDefaultEnvironment: typeof import('@modelcontextprotocol/sdk/client/stdio.js').getDefaultEnvironment;
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;
  StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport;
}

let mcpSdkRuntimePromise: Promise<McpSdkRuntime> | undefined;

/**
 * VS Code 1.130 的 Node 24 Extension Host 会用抛错 getter 暴露错误读取全局 `navigator` 的依赖。
 * Zod 4 的对象 JIT 能力探测会读取该全局；在加载会立即构造 Zod schema 的 MCP SDK 前，显式关闭
 * JIT，既避免动态代码生成，也使 SDK 在 Node Extension Host 中保持确定性。SDK 必须保持懒加载，
 * 否则静态 import 会先于这里的配置执行。
 */
function loadMcpSdkRuntime(): Promise<McpSdkRuntime> {
  mcpSdkRuntimePromise ??= (async () => {
    const zod = await import('zod/v4');
    zod.config({ jitless: true });
    const [clientModule, stdioModule, streamableHttpModule] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    ]);
    return {
      Client: clientModule.Client,
      getDefaultEnvironment: stdioModule.getDefaultEnvironment,
      StdioClientTransport: stdioModule.StdioClientTransport,
      StreamableHTTPClientTransport: streamableHttpModule.StreamableHTTPClientTransport
    };
  })();
  return mcpSdkRuntimePromise;
}

function validateConnectableConfig(config: McpServerConfigRecord): void {
  if (config.transport.kind === 'stdio') {
    if (!config.transport.command.trim()) throw new Error('stdio MCP 服务缺少启动命令。');
    return;
  }
  const rawUrl = config.transport.url.trim();
  if (!rawUrl) throw new Error('HTTP MCP 服务缺少 URL。');
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL 必须使用 http 或 https。');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`HTTP MCP 服务 URL 无效：${detail}`);
  }
}

function mcpToolDeclaration(source: McpServerConfigRecord, tool: Tool): ToolDefinition {
  return {
    execution: 'runtime',
    declaration: {
      name: mcpToolDisplayName(source, tool.name),
      description: tool.description ?? `MCP 工具 ${tool.name}`,
      parameters: tool.inputSchema,
      source: {
        kind: 'mcp',
        sourceId: source.id,
        sourceName: source.name,
        originalToolName: tool.name
      },
      metadata: {
        category: 'general',
        scope: 'general',
        riskLevel: tool.annotations?.readOnlyHint ? 'read' : tool.annotations?.destructiveHint ? 'write' : 'command',
        readonly: tool.annotations?.readOnlyHint === true,
        defaultEnabled: false,
        defaultAutoApproveExecution: false,
        defaultAutoSubmitResult: true,
        defaultAutoApplyChange: false
      }
    },
    async execute(): Promise<ToolResultOut> {
      throw new Error('MCP execution must use the reliable McpEffect control plane.');
    }
  };
}

/** OpenAI and Gemini refuse function names longer than this. */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;

/**
 * AI 可见的工具名：`服务名_原始工具名`。服务名做 slug 保证字符合法，原始工具名保持原样以便和
 * MCP 服务自身文档一致。服务名 slug 后为空（例如全是中文）时改用 `mcp-<服务 id 的 8 位哈希>`，
 * 前缀短而稳定，不同服务也不会落到同一个前缀；普通 ASCII 服务名的工具名保持不变。超过 64 个字符
 * 的名字截短并接上整名的哈希（{@link capMcpToolName}）。仍然重名时由 {@link dedupeMcpToolNames}
 * 按来源 id 的固定顺序消歧。
 */
function mcpToolDisplayName(source: McpServerConfigRecord, toolName: string): string {
  return capMcpToolName(`${slug(source.name) || `mcp-${shortHash(source.id)}`}_${toolName}`);
}

/** A name within {@link MCP_TOOL_NAME_MAX_LENGTH}: longer ones keep their start and end with `_<8-character hash of the whole name>`. */
function capMcpToolName(name: string): string {
  if (name.length <= MCP_TOOL_NAME_MAX_LENGTH) return name;
  const hash = shortHash(name);
  return `${name.slice(0, MCP_TOOL_NAME_MAX_LENGTH - hash.length - 1)}_${hash}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * 消歧一批工具定义的名字：遇到与 `reserved`（含内置工具名）或彼此重名时追加 `_2`、`_3`…（仍不超过 64 个字符）
 * 按来源 id 排序后再分配后缀（同一来源内保持服务列出的顺序），所以名字与服务连上的先后无关；
 * 但另一个服务断开、停用或被删除时，显示名仍可能换到别的服务的工具上。因此保存的设置都按
 * sourceId + originalToolName 识别工具（见 shared/toolPolicyResolution 的 mcpToolIdentity 与
 * toolConfigKey），这里只调整 AI 可见的 `declaration.name`。
 */
export function dedupeMcpToolNames(tools: ToolDefinition[], reserved: Iterable<string> = []): ToolDefinition[] {
  const used = new Set(reserved);
  const ordered = tools
    .map((tool, index) => ({ tool, index }))
    .sort((left, right) => compareSourceIds(sourceIdOf(left.tool), sourceIdOf(right.tool)) || left.index - right.index)
    .map(({ tool }) => tool);
  return ordered.map((tool) => {
    const base = tool.declaration.name;
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) name = capMcpToolName(`${base}_${suffix}`);
    used.add(name);
    return name === base ? tool : { ...tool, declaration: { ...tool.declaration, name } };
  });
}

function disabledSourceRecord(config: McpServerConfigRecord): McpToolSourceRecord {
  return {
    id: config.id,
    name: config.name,
    transportKind: config.transport.kind,
    enabled: false,
    status: 'disabled',
    toolCount: 0,
    updatedAt: config.updatedAt
  };
}

function idleSourceRecord(config: McpServerConfigRecord): McpToolSourceRecord {
  return {
    id: config.id,
    name: config.name,
    transportKind: config.transport.kind,
    enabled: true,
    status: 'idle',
    toolCount: 0,
    updatedAt: config.updatedAt
  };
}

function connectingSourceRecord(config: McpServerConfigRecord): McpToolSourceRecord {
  return {
    id: config.id,
    name: config.name,
    transportKind: config.transport.kind,
    enabled: true,
    status: 'connecting',
    toolCount: 0,
    updatedAt: Date.now()
  };
}

function sameConnectionConfig(left: McpServerConfigRecord, right: McpServerConfigRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function closeConnection(connection: McpConnection): Promise<void> {
  try {
    await connection.transport.close();
  } catch (error) {
    console.warn(`[LimCode] Failed to close MCP server ${connection.config.id}:`, error);
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function sourceIdOf(tool: ToolDefinition): string {
  const sourceId = tool.declaration.source?.kind === 'mcp' ? tool.declaration.source.sourceId : undefined;
  return typeof sourceId === 'string' ? sourceId : '';
}

/** Code-unit order, so the naming order is the same on every machine and locale. */
function compareSourceIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
