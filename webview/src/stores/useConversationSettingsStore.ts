import { defineStore } from 'pinia';
import type {
  ConversationSettingsRecord,
  ConversationSettingsSnapshotPayload
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';

interface ConversationSettingsState {
  common: ConversationSettingsRecord;
  status: string;
  savedName: string;
  draftChangedRemotely: boolean;
  pendingReload?: { requestId: string; draftName: string };
  pendingSave?: { requestId: string; name: string };
}

function emptyCommon(conversationId = ''): ConversationSettingsRecord {
  return { conversationId, name: '' };
}

/** 对话级 common 设置；模型选择只有 ModelProfile 一个 authority。 */
export const useConversationSettingsStore = defineStore('conversationSettings', {
  state: (): ConversationSettingsState => ({
    common: emptyCommon(),
    status: '',
    savedName: '',
    draftChangedRemotely: false
  }),
  actions: {
    request(conversationId: string, discardDraft = false): void {
      // 进入对话时先占位 conversationId，避免快照未到时保存按钮不可用。
      if (this.common.conversationId !== conversationId) {
        this.common = emptyCommon(conversationId);
        this.savedName = '';
        this.draftChangedRemotely = false;
        this.pendingReload = undefined;
        this.pendingSave = undefined;
      }
      if (!conversationId) {
        this.status = '';
        return;
      }
      this.status = '正在读取对话设置...';
      const requestId = bridge.request(BridgeMessageType.ConversationSettingsGet, { conversationId, section: 'common' });
      if (discardDraft) this.pendingReload = { requestId, draftName: this.common.name };
    },
    save(): void {
      if (!this.common.conversationId) return;
      this.pendingReload = undefined;
      this.common.name = this.common.name.trim();
      this.status = '正在保存对话设置...';
      const requestId = bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
        section: 'common',
        settings: { conversationId: this.common.conversationId, name: this.common.name }
      });
      this.pendingSave = { requestId, name: this.common.name };
    },
    applySnapshot(payload: ConversationSettingsSnapshotPayload, correlationId?: string): void {
      const conversationId = this.common.conversationId;
      const settings = payload.settings as ConversationSettingsRecord;
      // 导航决定作用域；快照自身的两处会话身份必须一致，不能用错位正文覆盖当前表单。
      if (!conversationId || payload.conversationId !== conversationId
        || settings?.conversationId !== conversationId || payload.section !== 'common') return;
      const reload = this.pendingReload;
      const requestedDiscard = !!reload && reload.requestId === correlationId;
      const pending = this.pendingSave;
      const preserveSubmission = !!pending && (pending.requestId !== correlationId || this.common.name !== pending.name);
      const mayReplace = (this.common.name === this.savedName && !preserveSubmission) || this.common.name === settings.name
        || (requestedDiscard && this.common.name === reload.draftName);
      if (requestedDiscard) this.pendingReload = undefined;
      if (requestedDiscard || pending?.requestId === correlationId) this.pendingSave = undefined;
      this.draftChangedRemotely = !mayReplace && (this.draftChangedRemotely || settings.name !== this.savedName);
      this.savedName = settings.name;
      if (mayReplace) this.common = { conversationId, name: settings.name };
      this.status = mayReplace ? '对话设置已同步'
        : this.draftChangedRemotely ? '已保存内容有更新，当前草稿已保留' : '当前草稿尚未保存';
    },
    applyError(error: { message: string; conversationId?: string }): void {
      // 迟到错误只影响仍绑定该会话的视图。
      if (!this.common.conversationId || error.conversationId !== this.common.conversationId) return;
      this.status = error.message;
    }
  }
});
