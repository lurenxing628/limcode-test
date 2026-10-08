import { defineStore } from 'pinia';
import {
  BridgeMessageType,
  createMessageId,
  type ConfigScopeKind,
  type PromptPlaceholderRecord,
  type RuntimeContextRecord,
  type RuntimeContextScopeLinkRecord
} from '@shared/protocol';
import { bridge } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

interface PendingRuntimeContextSave {
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  operation: 'set' | 'clear';
  requestId: string;
  template?: string;
}

interface RuntimeContextStoreState {
  status: string;
  pendingSaves: Record<string, PendingRuntimeContextSave>;
  completedSaves: Record<string, string>;
}

function scopeIdFor(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined { return scopeKind === 'global' ? undefined : scopeId?.trim(); }
function scopeKey(scopeKind: ConfigScopeKind, scopeId?: string): string { return JSON.stringify([scopeKind, scopeIdFor(scopeKind, scopeId) ?? '']); }
function matches(link: RuntimeContextScopeLinkRecord, scopeKind: ConfigScopeKind, scopeId?: string): boolean { return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId); }
function latest<T extends { createdAt: number; updatedAt: number; id: string }>(items: T[]): T | undefined { return [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]; }
function sortPlaceholders(items: PromptPlaceholderRecord[]): PromptPlaceholderRecord[] { return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)); }

export const useRuntimeContextStore = defineStore('runtimeContext', {
  state: (): RuntimeContextStoreState => ({ status: '', pendingSaves: {}, completedSaves: {} }),
  getters: {
    runtimePlaceholders(): PromptPlaceholderRecord[] {
      return sortPlaceholders(useClientStateStore().promptPlaceholders.filter((item) => item.target === 'runtimeContext'));
    }
  },
  actions: {
    localContextFor(scopeKind: ConfigScopeKind, scopeId?: string): { runtimeContext?: RuntimeContextRecord; link?: RuntimeContextScopeLinkRecord } {
      const clientState = useClientStateStore();
      const link = latest(clientState.runtimeContextScopeLinks.filter((item) => matches(item, scopeKind, scopeId)));
      const runtimeContext = clientState.runtimeContexts.find((item) => item.id === link?.runtimeContextId);
      return { ...(runtimeContext ? { runtimeContext } : {}), ...(link ? { link } : {}) };
    },
    completedSaveFor(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined { return this.completedSaves[scopeKey(scopeKind, scopeId)]; },
    setContextForScope(scopeKind: ConfigScopeKind, scopeId: string | undefined, template: string, name?: string): string | undefined {
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      if (scopeKind !== 'global' && !normalizedScopeId) {
        this.status = '缺少初始上下文配置范围，无法保存。';
        return;
      }

      const normalizedTemplate = template.trim();
      const requestId = createMessageId();
      this.pendingSaves[scopeKey(scopeKind, normalizedScopeId)] = {
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        template: normalizedTemplate,
        operation: 'set', requestId
      };
      bridge.request(BridgeMessageType.RuntimeContextScopeSet, {
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        template: normalizedTemplate,
        ...(name?.trim() ? { name: name.trim() } : {})
      }, { requestId });
      this.status = '正在保存运行时模板...';
      return requestId;
    },
    clearContextScope(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined {
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      if (scopeKind !== 'global' && !normalizedScopeId) { this.status = '缺少初始上下文配置范围，无法恢复继承。'; return; }
      const requestId = createMessageId();
      this.pendingSaves[scopeKey(scopeKind, normalizedScopeId)] = { scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}), operation: 'clear', requestId };
      this.status = scopeKind === 'global' ? '正在恢复默认模板...' : '正在恢复继承...';
      bridge.request(BridgeMessageType.RuntimeContextScopeClear, { scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}) }, { requestId });
      return requestId;
    },
    reconcilePendingSave(correlationId?: string): void {
      if (!correlationId) return;
      for (const [key, pending] of Object.entries(this.pendingSaves)) {
        if (pending.requestId !== correlationId) continue;
        const local = this.localContextFor(pending.scopeKind, pending.scopeId);
        if (pending.operation === 'clear' ? !!local.link : !local.runtimeContext || !local.link || local.runtimeContext.template.trim() !== pending.template) return;
        delete this.pendingSaves[key]; this.completedSaves[key] = correlationId;
        this.status = pending.operation === 'clear' ? pending.scopeKind === 'global' ? '已恢复默认模板' : '已恢复继承' : '运行时模板已同步';
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
