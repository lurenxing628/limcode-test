import { defineStore } from 'pinia';
import { createMessageId, type ConfigScopeKind, type PromptPlaceholderRecord, type SystemPromptRecord, type SystemPromptScopeLinkRecord } from '@shared/protocol';
import {
  DEFAULT_INTEGRATED_SYSTEM_PROMPT,
  DEFAULT_INTEGRATED_SYSTEM_PROMPT_ID,
  DEFAULT_INTEGRATED_SYSTEM_PROMPT_NAME
} from '@shared/defaultSystemPrompt';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';
import { useReliableKernelClientFeedStore } from './useReliableKernelClientFeedStore';

interface PendingSystemPromptSave {
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  operation: 'set' | 'clear';
  requestId: string;
  text?: string;
}

interface SystemPromptStoreState {
  status: string;
  pendingSaves: Record<string, PendingSystemPromptSave>;
  completedSaves: Record<string, string>;
}

export interface SystemPromptResolution {
  prompt?: SystemPromptRecord;
  link?: SystemPromptScopeLinkRecord;
  inheritedPrompts: SystemPromptRecord[];
  inheritedText: string;
  effectiveText: string;
}

function scopeIdFor(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined { return scopeKind === 'global' ? undefined : scopeId?.trim(); }
function scopeKey(scopeKind: ConfigScopeKind, scopeId?: string): string { return JSON.stringify([scopeKind, scopeIdFor(scopeKind, scopeId) ?? '']); }
function matches(link: SystemPromptScopeLinkRecord, scopeKind: ConfigScopeKind, scopeId?: string): boolean { return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId); }
function latest<T extends { createdAt: number; updatedAt: number; id: string }>(items: T[]): T | undefined { return [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]; }
function sortPlaceholders(items: PromptPlaceholderRecord[]): PromptPlaceholderRecord[] { return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)); }
function promptText(prompts: SystemPromptRecord[]): string { return prompts.map((prompt) => prompt.text.trim()).filter(Boolean).join('\n\n'); }
const builtInGlobalPrompt: SystemPromptRecord = {
  id: DEFAULT_INTEGRATED_SYSTEM_PROMPT_ID,
  name: DEFAULT_INTEGRATED_SYSTEM_PROMPT_NAME,
  text: DEFAULT_INTEGRATED_SYSTEM_PROMPT
};

export const useSystemPromptStore = defineStore('systemPrompt', {
  state: (): SystemPromptStoreState => ({ status: '', pendingSaves: {}, completedSaves: {} }),
  getters: {
    systemPlaceholders(): PromptPlaceholderRecord[] {
      return sortPlaceholders(useClientStateStore().promptPlaceholders.filter((item) => item.target === 'systemPrompt'));
    }
  },
  actions: {
    localPromptFor(scopeKind: ConfigScopeKind, scopeId?: string): { prompt?: SystemPromptRecord; link?: SystemPromptScopeLinkRecord } {
      const clientState = useClientStateStore();
      const link = latest(clientState.systemPromptScopeLinks.filter((item) => matches(item, scopeKind, scopeId)));
      const prompt = clientState.systemPrompts.find((item) => item.id === link?.systemPromptId);
      return { ...(prompt ? { prompt } : {}), ...(link ? { link } : {}) };
    },
    promptResolutionFor(scopeKind: ConfigScopeKind, scopeId?: string): SystemPromptResolution {
      const local = this.localPromptFor(scopeKind, scopeId);
      const inheritedPrompts = this.inheritedPromptsFor(scopeKind, scopeId);
      const inheritedText = promptText(inheritedPrompts);
      const effectiveText = promptText([...inheritedPrompts, ...(local.prompt ? [local.prompt] : [])]);
      return {
        ...(local.prompt ? { prompt: local.prompt } : {}),
        ...(local.link ? { link: local.link } : {}),
        inheritedPrompts,
        inheritedText,
        effectiveText
      };
    },
    inheritedPromptsFor(scopeKind: ConfigScopeKind, scopeId?: string): SystemPromptRecord[] {
      const clientState = useClientStateStore();
      const prompts: SystemPromptRecord[] = [];
      const pushLocal = (kind: ConfigScopeKind, id?: string): void => {
        const prompt = this.localPromptFor(kind, id).prompt;
        if (prompt?.text.trim()) prompts.push(prompt);
      };
      const pushGlobal = (): void => {
        const global = this.localPromptFor('global').prompt;
        if (global) {
          if (global.text.trim()) prompts.push(global);
        } else prompts.push(builtInGlobalPrompt);
      };

      switch (scopeKind) {
        case 'global':
          return this.localPromptFor('global').prompt ? [] : [builtInGlobalPrompt];
        case 'agent':
        case 'workflow':
          pushGlobal();
          return prompts;
        case 'conversation': {
          pushGlobal();
          const conversationId = scopeIdFor(scopeKind, scopeId);
          if (!conversationId) return prompts;
          const agentId = activeAgentIdForConversation(conversationId);
          if (agentId) pushLocal('agent', agentId);
          const workflowId = activeWorkflowIdForConversation(conversationId);
          if (workflowId) pushLocal('workflow', workflowId);
          return prompts;
        }
        case 'run': {
          pushGlobal();
          const runId = scopeIdFor(scopeKind, scopeId);
          if (!runId) return prompts;
          const target = clientState.agentRunTargetLinks.find((link) => link.runId === runId && link.role === 'executor');
          if (target?.agentId) pushLocal('agent', target.agentId);
          const runWorkflowId = clientState.runWorkflowLinks.find((link) => link.runId === runId && link.role === 'active')?.workflowId;
          if (runWorkflowId) pushLocal('workflow', runWorkflowId);
          if (target?.conversationId) pushLocal('conversation', target.conversationId);
          return prompts;
        }
      }
    },
    completedSaveFor(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined { return this.completedSaves[scopeKey(scopeKind, scopeId)]; },
    setPromptForScope(scopeKind: ConfigScopeKind, scopeId: string | undefined, text: string, name?: string): string | undefined {
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      if (scopeKind !== 'global' && !normalizedScopeId) {
        this.status = '缺少系统提示词配置范围，无法保存。';
        return;
      }

      const normalizedText = text.trim();
      if (!normalizedText) {
        if (scopeKind === 'global') {
          return this.clearPromptScope(scopeKind, normalizedScopeId);
        }
        this.status = '提示词内容为空；若要继承上级配置，请点击“恢复继承”。';
        return;
      }

      const requestId = createMessageId();
      this.pendingSaves[scopeKey(scopeKind, normalizedScopeId)] = { scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}), operation: 'set', text: normalizedText, requestId };
      bridge.request(BridgeMessageType.SystemPromptScopeSet, {
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        text: normalizedText,
        ...(name?.trim() ? { name: name.trim() } : {})
      }, { requestId });
      this.status = '正在保存 Prompt...';
      return requestId;
    },
    clearPromptScope(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined {
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      if (scopeKind !== 'global' && !normalizedScopeId) { this.status = '缺少系统提示词配置范围，无法恢复继承。'; return; }
      const requestId = createMessageId();
      this.pendingSaves[scopeKey(scopeKind, normalizedScopeId)] = { scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}), operation: 'clear', requestId };
      this.status = scopeKind === 'global' ? '正在恢复默认 Prompt...' : '正在恢复继承...';
      bridge.request(BridgeMessageType.SystemPromptScopeClear, { scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}) }, { requestId });
      return requestId;
    },
    reconcilePendingSave(correlationId?: string): void {
      if (!correlationId) return;
      for (const [key, pending] of Object.entries(this.pendingSaves)) {
        if (pending.requestId !== correlationId) continue;
        const local = this.localPromptFor(pending.scopeKind, pending.scopeId);
        if (pending.operation === 'clear' ? !!local.link : !local.prompt || !local.link || local.prompt.text.trim() !== pending.text) return;
        delete this.pendingSaves[key];
        this.completedSaves[key] = correlationId;
        this.status = pending.operation === 'clear' ? pending.scopeKind === 'global' ? '已恢复默认 Prompt' : '已恢复继承' : 'Prompt 已同步';
        return;
      }
    },
    rejectPendingSave(correlationId: string | undefined, message: string): void {
      for (const [key, pending] of Object.entries(this.pendingSaves)) {
        if (pending.requestId !== correlationId) continue;
        delete this.pendingSaves[key]; this.status = message; return;
      }
    },
    resetPendingSaveForReconnect(): void {
      if (Object.keys(this.pendingSaves).length) this.status = '连接已更换，保存结果未确定；本地草稿已保留，请核对当前配置。';
      this.pendingSaves = {}; this.completedSaves = {};
    }
  }
});

function activeAgentIdForConversation(conversationId: string): string | undefined {
  const feed = useReliableKernelClientFeedStore();
  const links = Object.values(feed.records.AgentConversationLink ?? {});
  const link = links.find((candidate) =>
    plainText(candidate.conversation_id) === conversationId && plainText(candidate.role) === 'default'
  ) ?? links.find((candidate) => plainText(candidate.conversation_id) === conversationId);
  return plainText(link?.agent_id);
}

function activeWorkflowIdForConversation(conversationId: string): string | undefined {
  const clientState = useClientStateStore();
  const selection = latest(clientState.conversationWorkflowSelections.filter((item) => item.conversationId === conversationId && item.role === 'active'));
  return selection?.scopeKind === 'workflow' ? selection.workflowId : undefined;
}

function plainText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
