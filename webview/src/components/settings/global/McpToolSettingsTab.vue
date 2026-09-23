<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IconChevronDown, IconPlus, IconRefresh, IconPencil, IconTrash } from '@tabler/icons-vue';
import type { McpServerConfigRecord, McpServerTransportRecord, ToolDefinitionRecord, ToolPolicySourceConfigRecord } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import SettingsDropdown, { type SettingsDropdownOption } from './SettingsDropdown.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useToolPolicyStore } from '@webview/stores/useToolPolicyStore';
import { mcpSourceConfigFor, toolAllowedByPolicy } from '@shared/toolPolicyResolution';

const settings = useGlobalSettingsStore();
const clientState = useClientStateStore();
const toolPolicyStore = useToolPolicyStore();
const { loading, text: loadingText } = useSettingsLoadingText('MCP 工具', 'global');
const serverScroller = ref<HTMLElement | null>(null);
const renameServerId = ref('');
const deleteServerId = ref('');
const createPanelOpen = ref(false);
const expandedToolNames = ref<string[]>([]);
const expandedServerIds = ref<string[]>([]);

const transportOptions: SettingsDropdownOption[] = [
  { value: 'stdio', label: 'stdio', description: '启动本地命令并通过标准输入输出通信' },
  { value: 'http', label: 'HTTP', description: '通过 Streamable HTTP 接口连接 MCP 服务' }
];

const sourcesById = computed(() => new Map(clientState.mcpToolSources.map((source) => [source.id, source])));
const mcpTools = computed(() => clientState.toolDefinitions.filter((tool) => tool.source?.kind === 'mcp'));
const mcpToolsBySource = computed(() => {
  const map = new Map<string, ToolDefinitionRecord[]>();
  for (const tool of mcpTools.value) {
    const sourceId = tool.source?.sourceId;
    if (!sourceId) continue;
    const list = map.get(sourceId) ?? [];
    list.push(tool);
    map.set(sourceId, list);
  }
  for (const list of map.values()) list.sort((left, right) => left.name.localeCompare(right.name));
  return map;
});
const globalPolicy = computed(() => toolPolicyStore.effectivePolicyFor('global').policy);
const renameServer = computed(() => settings.mcpServers.servers.find((server) => server.id === renameServerId.value));
const deleteServer = computed(() => settings.mcpServers.servers.find((server) => server.id === deleteServerId.value));
const mcpBusy = computed(() => loading.value || settings.pendingSettingsSections.mcpServers === true || clientState.mcpToolSources.some((source) => source.status === 'connecting'));
const mcpBusyText = computed(() => settings.pendingSettingsSections.mcpServers ? settings.status || '正在处理 MCP 工具...' : loadingText.value);

onMounted(() => {
  settings.ensureMcpServers();
});

function duplicateNameError(name: string, excludeServerId?: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return '';
  const clash = settings.mcpServers.servers.some(
    (server) => server.id !== excludeServerId && server.name.trim().toLowerCase() === normalized
  );
  return clash ? '已存在同名 MCP 服务，请换一个名称。' : '';
}

function createServer(name: string): void {
  if (duplicateNameError(name)) return;
  createPanelOpen.value = false;
  settings.createMcpServer(name.trim() || '新 MCP 服务');
}

function renameServerConfirm(name: string): void {
  const server = renameServer.value;
  if (!server || duplicateNameError(name, server.id)) return;
  renameServerId.value = '';
  settings.updateMcpServer(server.id, { name: name.trim() || server.name });
}

function isServerExpanded(serverId: string): boolean {
  return expandedServerIds.value.includes(serverId);
}

function toggleServerExpanded(serverId: string): void {
  expandedServerIds.value = isServerExpanded(serverId)
    ? expandedServerIds.value.filter((id) => id !== serverId)
    : [...expandedServerIds.value, serverId];
}

function updateServer(server: McpServerConfigRecord, patch: Partial<McpServerConfigRecord>): void {
  settings.updateMcpServer(server.id, patch);
}

function testServer(server: McpServerConfigRecord): void {
  settings.testMcpServer(server.id);
}

function updateTransportKind(server: McpServerConfigRecord, kind: string): void {
  const transport: McpServerTransportRecord = kind === 'http'
    ? { kind: 'http', url: server.transport.kind === 'http' ? server.transport.url : 'http://127.0.0.1:3000/mcp', headers: server.transport.kind === 'http' ? server.transport.headers ?? {} : {} }
    : { kind: 'stdio', command: server.transport.kind === 'stdio' ? server.transport.command : '', args: server.transport.kind === 'stdio' ? server.transport.args ?? [] : [], env: server.transport.kind === 'stdio' ? server.transport.env ?? {} : {} };
  updateServer(server, { transport });
}

function updateStdioField(server: McpServerConfigRecord, patch: Partial<Extract<McpServerTransportRecord, { kind: 'stdio' }>>): void {
  if (server.transport.kind !== 'stdio') return;
  updateServer(server, { transport: { ...server.transport, ...patch } });
}

function updateHttpField(server: McpServerConfigRecord, patch: Partial<Extract<McpServerTransportRecord, { kind: 'http' }>>): void {
  if (server.transport.kind !== 'http') return;
  updateServer(server, { transport: { ...server.transport, ...patch } });
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseKeyValueLines(value: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of splitLines(value)) {
    const index = line.indexOf('=');
    const key = (index >= 0 ? line.slice(0, index) : line).trim();
    const item = index >= 0 ? line.slice(index + 1).trim() : '';
    if (key) record[key] = item;
  }
  return record;
}

function keyValueText(value: Record<string, string> | undefined): string {
  return Object.entries(value ?? {}).map(([key, item]) => `${key}=${item}`).join('\n');
}

function deleteServerConfirm(): void {
  const server = deleteServer.value;
  deleteServerId.value = '';
  if (server) settings.deleteMcpServer(server.id);
}

function cloneSourceConfigs(): Record<string, ToolPolicySourceConfigRecord> {
  const result: Record<string, ToolPolicySourceConfigRecord> = {};
  for (const [sourceId, record] of Object.entries(globalPolicy.value?.sourceConfigs ?? {})) {
    result[sourceId] = {
      enabled: record.enabled === true,
      ...(record.disabledTools?.length ? { disabledTools: [...record.disabledTools] } : {})
    };
  }
  return result;
}

function isSourceGloballyEnabled(sourceId: string): boolean {
  return mcpSourceConfigFor(globalPolicy.value?.sourceConfigs, sourceId)?.enabled === true;
}

function isToolGloballyEnabled(tool: ToolDefinitionRecord): boolean {
  return !!globalPolicy.value && toolAllowedByPolicy(globalPolicy.value, tool);
}

function setToolGlobalEnabled(tool: ToolDefinitionRecord, enabled: boolean): void {
  const sourceId = tool.source?.sourceId;
  if (!sourceId) return;
  const next = cloneSourceConfigs();
  const sourceConfig = next[sourceId] ?? { enabled: true, disabledTools: [] };
  const disabled = new Set(sourceConfig.disabledTools ?? []);
  if (enabled) disabled.delete(tool.name);
  else disabled.add(tool.name);
  next[sourceId] = { enabled: sourceConfig.enabled !== false, ...(disabled.size > 0 ? { disabledTools: [...disabled] } : {}) };
  // Keep the saved global list state: without a saved list the source settings alone decide, and
  // writing the displayed default list here would create a global ceiling as a side effect.
  const saved = toolPolicyStore.localPolicyFor('global').policy;
  const allowedTools = saved?.allowedTools && !enabled
    ? saved.allowedTools.filter((name) => name !== tool.name)
    : saved?.allowedTools;
  toolPolicyStore.setPolicyForScope('global', undefined, allowedTools, saved?.name, saved?.toolConfigs, next);
}

function sourceForServer(serverId: string) {
  return sourcesById.value.get(serverId);
}

function toolsForServer(serverId: string): ToolDefinitionRecord[] {
  return mcpToolsBySource.value.get(serverId) ?? [];
}

function isServerConnected(serverId: string): boolean {
  return sourceForServer(serverId)?.status === 'connected';
}

function sourceStatus(server: McpServerConfigRecord): string {
  if (settings.pendingSettingsSections.mcpServers && server.enabled) return 'connecting';
  return sourceForServer(server.id)?.status ?? (server.enabled ? 'idle' : 'disabled');
}

function sourceStatusLabel(server: McpServerConfigRecord): string {
  switch (sourceStatus(server)) {
    case 'connected': return '已连接';
    case 'connecting': return '连接中';
    case 'error': return '连接失败';
    case 'disabled': return '已停用';
    default: return '等待连接';
  }
}

function sourceStatusClass(server: McpServerConfigRecord): string {
  const status = sourceStatus(server);
  if (status === 'connected') return 'connected';
  if (status === 'connecting') return 'connecting';
  if (status === 'error') return 'error';
  return 'idle';
}

function isToolExpanded(toolName: string): boolean {
  return expandedToolNames.value.includes(toolName);
}

function toggleToolExpanded(toolName: string): void {
  expandedToolNames.value = isToolExpanded(toolName)
    ? expandedToolNames.value.filter((name) => name !== toolName)
    : [...expandedToolNames.value, toolName];
}

function toolParametersText(tool: ToolDefinitionRecord): string {
  try {
    return JSON.stringify(tool.parameters, null, 2);
  } catch {
    return String(tool.parameters);
  }
}
</script>

<template>
  <section class="global-settings-tab-section" aria-label="MCP 工具注册">
    <header class="global-settings-section-header">
      <div>
        <h2>
          MCP 工具
          <SettingsLoadingInline :show="mcpBusy" :text="mcpBusyText" />
        </h2>
        <p>添加 MCP 服务、检查连接状态，并设置发现的工具是否加入全局默认工具权限。</p>
      </div>
    </header>

    <section class="mcp-panel">
      <header class="mcp-panel-header">
        <div>
          <h3>服务注册</h3>
          <p>填写配置后点击尝试获取工具；已启用的服务会在启动后自动尝试恢复连接。</p>
        </div>
        <button type="button" class="mcp-icon-button mcp-add-button" title="新增 MCP 服务" @click="createPanelOpen = true">
          <IconPlus stroke="2" size="32" />
        </button>
      </header>

      <div class="mcp-scroll-shell">
        <div ref="serverScroller" class="mcp-server-scroll">
          <p v-if="settings.mcpServers.servers.length === 0" class="mcp-empty">暂无 MCP 服务。</p>
          <article v-for="server in settings.mcpServers.servers" :key="server.id" class="mcp-server-item">
            <div class="mcp-server-top">
              <LcCheckbox
                class="mcp-server-enabled"
                :model-value="server.enabled"
                @update:model-value="updateServer(server, { enabled: $event })"
              >
                <span>
                  <span class="mcp-server-title-line">
                    <strong>{{ server.name }}</strong>
                    <span class="mcp-status-dot" :class="sourceStatusClass(server)" aria-hidden="true"></span>
                  </span>
                  <small>{{ sourceStatusLabel(server) }} · {{ sourcesById.get(server.id)?.toolCount ?? 0 }} 个工具</small>
                </span>
              </LcCheckbox>
              <div class="mcp-server-actions">
                <button type="button" title="尝试获取工具" @click="testServer(server)"><IconRefresh stroke="2" size="26" /></button>
                <button type="button" title="重命名" @click="renameServerId = server.id"><IconPencil stroke="2" size="26" /></button>
                <button type="button" title="删除" @click="deleteServerId = server.id"><IconTrash stroke="2" size="26" /></button>
                <button
                  type="button"
                  class="mcp-server-expand"
                  :class="{ expanded: isServerExpanded(server.id) }"
                  :aria-expanded="isServerExpanded(server.id)"
                  :title="isServerExpanded(server.id) ? '收起配置' : '展开配置'"
                  @click="toggleServerExpanded(server.id)"
                >
                  <IconChevronDown stroke="2" size="26" />
                </button>
              </div>
            </div>
            <p v-if="sourcesById.get(server.id)?.lastError" class="mcp-error">{{ sourcesById.get(server.id)?.lastError }}</p>

            <template v-if="isServerExpanded(server.id)">
            <div class="mcp-config-grid">
              <label class="mcp-field">
                <span>传输</span>
                <SettingsDropdown
                  :model-value="server.transport.kind"
                  :options="transportOptions"
                  title="MCP 传输类型"
                  @update:model-value="updateTransportKind(server, $event)"
                />
              </label>

              <template v-if="server.transport.kind === 'stdio'">
                <label class="mcp-field">
                  <span>命令</span>
                  <input :value="server.transport.command" type="text" placeholder="node" @change="updateStdioField(server, { command: ($event.target as HTMLInputElement).value })" />
                </label>
                <label class="mcp-field">
                  <span>工作目录</span>
                  <input :value="server.transport.cwd ?? ''" type="text" placeholder="可选" @change="updateStdioField(server, { cwd: ($event.target as HTMLInputElement).value })" />
                </label>
                <label class="mcp-field wide">
                  <span>参数</span>
                  <textarea :value="(server.transport.args ?? []).join('\n')" rows="3" placeholder="每行一个参数" @change="updateStdioField(server, { args: splitLines(($event.target as HTMLTextAreaElement).value) })"></textarea>
                </label>
                <label class="mcp-field wide">
                  <span>环境变量</span>
                  <textarea :value="keyValueText(server.transport.env)" rows="3" placeholder="KEY=value，每行一个" @change="updateStdioField(server, { env: parseKeyValueLines(($event.target as HTMLTextAreaElement).value) })"></textarea>
                </label>
              </template>

              <template v-else>
                <label class="mcp-field wide">
                  <span>URL</span>
                  <input :value="server.transport.url" type="text" placeholder="https://example.com/mcp" @change="updateHttpField(server, { url: ($event.target as HTMLInputElement).value })" />
                </label>
                <label class="mcp-field wide">
                  <span>请求头</span>
                  <textarea :value="keyValueText(server.transport.headers)" rows="3" placeholder="Authorization=Bearer ..." @change="updateHttpField(server, { headers: parseKeyValueLines(($event.target as HTMLTextAreaElement).value) })"></textarea>
                </label>
              </template>
            </div>

            <section v-if="isServerConnected(server.id)" class="mcp-server-tools">
              <header class="mcp-server-tools-header">
                <span>工具列表</span>
                <small>{{ toolsForServer(server.id).length }} 个工具，开关写入全局默认工具策略。</small>
              </header>
              <p v-if="toolsForServer(server.id).length === 0" class="mcp-empty">连接成功，但没有发现工具。</p>
              <article v-for="tool in toolsForServer(server.id)" :key="tool.name" class="mcp-tool-item">
                <div class="mcp-tool-row">
                  <LcCheckbox
                    class="mcp-tool-enable"
                    :model-value="isToolGloballyEnabled(tool)"
                    @update:model-value="setToolGlobalEnabled(tool, $event)"
                  >
                    <span>
                      <strong>{{ tool.source?.originalToolName ?? tool.name }}</strong>
                      <small>{{ tool.description || '无描述' }}</small>
                    </span>
                  </LcCheckbox>
                  <button
                    type="button"
                    class="mcp-tool-expand"
                    :class="{ expanded: isToolExpanded(tool.name) }"
                    :aria-expanded="isToolExpanded(tool.name)"
                    @click="toggleToolExpanded(tool.name)"
                  >
                    <IconChevronDown stroke="2" size="24" />
                  </button>
                </div>
                <div v-if="isToolExpanded(tool.name)" class="mcp-tool-detail">
                  <dl>
                    <div>
                      <dt>标准名称</dt>
                      <dd>{{ tool.name }}</dd>
                    </div>
                    <div>
                      <dt>原始工具名</dt>
                      <dd>{{ tool.source?.originalToolName ?? tool.name }}</dd>
                    </div>
                    <div>
                      <dt>执行类型</dt>
                      <dd>{{ tool.execution === 'agentRun' ? '由 Agent 执行' : '由系统执行' }}</dd>
                    </div>
                  </dl>
                  <section>
                    <h4>描述</h4>
                    <p>{{ tool.description || '无描述' }}</p>
                  </section>
                  <section>
                    <h4>参数定义</h4>
                    <pre>{{ toolParametersText(tool) }}</pre>
                  </section>
                </div>
              </article>
            </section>
            </template>
          </article>
        </div>
        <AdvancedScrollbar :scroller="serverScroller" variant="minimal" />
      </div>
    </section>

    <InputPanel
      :open="createPanelOpen"
      title="新增 MCP 服务"
      label="名称"
      initial-value="新 MCP 服务"
      :validate="(name) => duplicateNameError(name)"
      @confirm="createServer"
      @cancel="createPanelOpen = false"
    />
    <InputPanel
      :open="!!renameServer"
      title="重命名 MCP 服务"
      label="名称"
      :initial-value="renameServer?.name ?? ''"
      :validate="(name) => duplicateNameError(name, renameServer?.id)"
      @confirm="renameServerConfirm"
      @cancel="renameServerId = ''"
    />
    <ConfirmPanel
      :open="!!deleteServer"
      title="删除 MCP 服务"
      :description="`确定删除 ${deleteServer?.name ?? '该服务'}？`"
      confirm-label="删除"
      @confirm="deleteServerConfirm"
      @cancel="deleteServerId = ''"
    />
  </section>
</template>

<style scoped>
.mcp-panel {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.mcp-panel-header,
.mcp-server-top {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: flex-start;
}

.mcp-panel-header h3 {
  margin: 0;
  font-size: var(--font-size-md);
}

.mcp-panel-header p,
.mcp-empty,
.mcp-error,
.mcp-server-enabled small,
.mcp-tool-enable small,
.mcp-server-tools-header small {
  margin: var(--space-1) 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.45;
}

.mcp-error {
  color: var(--vscode-errorForeground);
}

.mcp-icon-button,
.mcp-server-actions button {
  width: 40px;
  height: 40px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-foreground);
  background: transparent;
}

.mcp-icon-button:hover,
.mcp-icon-button:focus-visible,
.mcp-server-actions button:hover,
.mcp-server-actions button:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.mcp-icon-button svg,
.mcp-server-actions svg {
  width: 26px;
  height: 26px;
}

.mcp-add-button {
  width: 44px;
  height: 44px;
}

.mcp-add-button svg {
  width: 32px;
  height: 32px;
}

.mcp-scroll-shell {
  position: relative;
  min-height: 80px;
}

.mcp-server-scroll {
  max-height: 620px;
  overflow-y: auto;
  scrollbar-width: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.mcp-server-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.mcp-server-item {
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  background: var(--vscode-editor-background);
}

.mcp-server-enabled,
.mcp-tool-enable {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: flex-start;
}

.mcp-server-enabled span,
.mcp-tool-enable span {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcp-server-title-line {
  display: inline-flex !important;
  flex-direction: row !important;
  align-items: center;
  gap: var(--space-2);
}

.mcp-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vscode-descriptionForeground);
}

.mcp-status-dot.connected {
  background: #2f9e44;
}

.mcp-status-dot.connecting {
  background: #d6a100;
}

.mcp-status-dot.error {
  background: #d13438;
}

.mcp-server-actions {
  display: flex;
  gap: var(--space-1);
}

.mcp-server-expand svg {
  transition: transform 0.16s ease;
}

.mcp-server-expand.expanded svg {
  transform: rotate(180deg);
}

.mcp-config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.mcp-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.mcp-field.wide {
  grid-column: 1 / -1;
}

.mcp-field input,
.mcp-field textarea {
  width: 100%;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
}

.mcp-field textarea {
  resize: vertical;
  min-height: 72px;
  font-family: var(--vscode-editor-font-family, monospace);
}

.mcp-server-tools {
  border-top: 1px solid var(--vscode-panel-border);
  padding-top: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.mcp-server-tools-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcp-server-tools-header span {
  font-weight: 650;
}

.mcp-tool-item {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: color-mix(in srgb, var(--vscode-editor-background) 98%, var(--vscode-foreground) 2%);
}

.mcp-tool-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 38px;
  align-items: stretch;
}

.mcp-tool-enable {
  padding: var(--space-2);
  min-width: 0;
}

.mcp-tool-enable strong,
.mcp-tool-enable small {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-tool-row:hover {
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.mcp-tool-expand {
  border: 0;
  border-left: 1px solid var(--vscode-panel-border);
  border-radius: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.mcp-tool-expand:hover,
.mcp-tool-expand:focus-visible {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  outline: none;
}

.mcp-tool-expand svg {
  width: 24px;
  height: 24px;
  transition: transform 0.16s ease;
}

.mcp-tool-expand.expanded svg {
  transform: rotate(180deg);
}

.mcp-tool-detail {
  border-top: 1px solid var(--vscode-panel-border);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  background: var(--vscode-editor-background);
}

.mcp-tool-detail dl {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
}

.mcp-tool-detail dt {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.mcp-tool-detail dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--font-size-xs);
}

.mcp-tool-detail h4 {
  margin: 0 0 var(--space-1);
  font-size: var(--font-size-sm);
}

.mcp-tool-detail p {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  line-height: 1.45;
}

.mcp-tool-detail pre {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  color: var(--vscode-editor-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 720px) {
  .mcp-config-grid,
  .mcp-tool-detail dl {
    grid-template-columns: 1fr;
  }
}
</style>
