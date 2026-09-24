import type { Component } from 'vue';
import { IconArchive, IconBook, IconFileText, IconImageGeneration, IconMessage, IconPlugConnected, IconRobot, IconServer, IconSettings2, IconSettingsAi, IconTool } from '@tabler/icons-vue';
import ChannelSettingsTab from './ChannelSettingsTab.vue';
import CheckpointSettingsTab from './CheckpointSettingsTab.vue';
import AppearanceSettingsTab from './AppearanceSettingsTab.vue';
import OtherSettingsTab from './OtherSettingsTab.vue';
import SystemPromptSettingsTab from './SystemPromptSettingsTab.vue';
import ToolSettingsTab from './ToolSettingsTab.vue';
import AgentCollaborationSettingsTab from './AgentCollaborationSettingsTab.vue';
import McpToolSettingsTab from './McpToolSettingsTab.vue';
import SkillSettingsTab from './SkillSettingsTab.vue';
import RulesSettingsTab from './RulesSettingsTab.vue';
import WorkEnvironmentSettingsTab from './WorkEnvironmentSettingsTab.vue';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { CHECKPOINT_FEATURE_ENABLED } from '@shared/featureFlags';

export type GlobalSettingsTabKey = 'channels' | 'prompts' | 'agent-collaboration' | 'tools' | 'mcp-tools' | 'skills' | 'rules' | 'checkpoints' | 'work-environments' | 'appearance' | 'other';

export interface GlobalSettingsTabDefinition {
  key: GlobalSettingsTabKey;
  label: string;
  description: string;
  icon: Component;
  component: Component;
  loading?: () => boolean;
  loadingText?: () => string;
}

function isMcpTabLoading(): boolean {
  const settings = useGlobalSettingsStore();
  const clientState = useClientStateStore();
  return clientState.settingsClientStateLoading
    || settings.loadingSettingsSections.mcpServers === true
    || settings.pendingSettingsSections.mcpServers === true
    || clientState.mcpToolSources.some((source) => source.status === 'connecting');
}

function mcpTabLoadingText(): string {
  const settings = useGlobalSettingsStore();
  const clientState = useClientStateStore();
  if (settings.pendingSettingsSections.mcpServers) return settings.status || '正在处理 MCP 工具...';
  if (clientState.mcpToolSources.some((source) => source.status === 'connecting')) return '正在连接 MCP...';
  return '正在加载 MCP...';
}

export const GLOBAL_SETTINGS_TABS: readonly GlobalSettingsTabDefinition[] = [
  {
    key: 'channels',
    label: '渠道',
    description: '模型渠道与 API 连接',
    icon: IconSettingsAi,
    component: ChannelSettingsTab
  },
  {
    key: 'prompts',
    label: '提示词',
    description: '系统提示词与初始上下文',
    icon: IconMessage,
    component: SystemPromptSettingsTab
  },
  {
    key: 'agent-collaboration',
    label: 'Agent 协作',
    description: '子 Agent 深度与团队预算',
    icon: IconRobot,
    component: AgentCollaborationSettingsTab
  },
  {
    key: 'tools',
    label: '工具',
    description: '工具注册与默认策略',
    icon: IconTool,
    component: ToolSettingsTab
  },
  {
    key: 'mcp-tools',
    label: 'MCP',
    description: 'MCP 服务注册与工具开关',
    icon: IconPlugConnected,
    component: McpToolSettingsTab,
    loading: isMcpTabLoading,
    loadingText: mcpTabLoadingText
  },
  {
    key: 'skills',
    label: '技能',
    description: '技能发现与默认策略',
    icon: IconBook,
    component: SkillSettingsTab
  },
  {
    key: 'rules',
    label: '规则',
    description: 'AGENTS.md / CLAUDE.md 规则注入',
    icon: IconFileText,
    component: RulesSettingsTab
  },
  ...(CHECKPOINT_FEATURE_ENABLED
    ? [{
        key: 'checkpoints' as const,
        label: '存档点',
        description: '内部 Git 存档策略',
        icon: IconArchive,
        component: CheckpointSettingsTab
      }]
    : []),
  {
    key: 'work-environments',
    label: '工作环境',
    description: '本地、服务器及后续扩展环境',
    icon: IconServer,
    component: WorkEnvironmentSettingsTab
  },
  {
    key: 'appearance',
    label: '外观',
    description: '自定义流式状态文字与动效',
    icon: IconImageGeneration,
    component: AppearanceSettingsTab
  },
  {
    key: 'other',
    label: '其他',
    description: '未归类全局配置',
    icon: IconSettings2,
    component: OtherSettingsTab
  }
];

export const DEFAULT_GLOBAL_SETTINGS_TAB: GlobalSettingsTabKey = 'channels';
