<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { IconMessages, IconRefresh, IconX } from '@tabler/icons-vue';
import type { CollaborationMessage, CollaborationMember, CollaborationConversationResultPayload } from '@shared/collaboration';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { useCollaborationStore } from '@webview/stores/useCollaborationStore';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import SettingsDropdown from '@webview/components/settings/global/SettingsDropdown.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import CollaborationBoardPanel from './CollaborationBoardPanel.vue';

const store = useCollaborationStore();
const reliable = useReliableConversation();
const conversationId = computed(() => reliable.conversationId.value ?? '');
const snapshot = computed(() => store.snapshots[conversationId.value]);
const members = computed(() => snapshot.value?.members ?? []);
const messages = computed(() => [...(snapshot.value?.messages ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
const open = ref(false);
const tab = ref<'messages' | 'members' | 'permissions' | 'board'>('messages');
const trigger = ref<HTMLButtonElement>();
const dialog = ref<HTMLElement>();
const scroller = ref<HTMLElement | null>(null);
const error = ref('');
const notice = ref('');
const busy = ref(false);
const refreshing = ref(false);
const target = ref('');
const draft = ref('');
const replyToMessageId = ref<string>();
const expandedMessage = ref('');
const permissionTarget = ref('');
const transcript = ref<CollaborationConversationResultPayload['target']>();
const currentIsChild = computed(() => !!members.value.find(member => member.conversationId === conversationId.value)?.childExecutionId);
const allowRead = ref(false);
const allowSend = ref(false);
const allowWake = ref(false);
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const recipientOptions = computed(() => members.value.filter(member => member.conversationId !== conversationId.value).map(member => ({
  value: member.conversationId, label: member.title || '未命名对话',
  description: member.relation === 'team' ? `团队成员 · ${memberState(member.status)}` : `已授权对话 · ${memberState(member.status)}`
})));
const selectedMember = computed(() => members.value.find(member => member.conversationId === target.value));
const selectedPermission = computed(() => snapshot.value?.permissions.find(permission => permission.targetConversationId === target.value));
const canSend = computed(() => !!target.value && (selectedMember.value?.relation === 'team' || selectedPermission.value?.allowSend === true));
const canWake = computed(() => !!target.value && (selectedMember.value?.relation === 'team' || selectedPermission.value?.allowWake === true));
const permissionOptions = computed(() => (currentIsChild.value ? [] : snapshot.value?.permissionCandidates ?? []).map(candidate => ({ value: candidate.conversationId, label: candidate.title || '未命名对话' })));
const statusRows = [
  { label: '已提交', value: '消息已持久保存，等待目标接收。纯消息不会启动空闲对话。' },
  { label: '已注入', value: '消息已进入目标模型上下文，尚未完成处理。' },
  { label: '已处理', value: '目标执行已确认处理这条消息。阅读消息不改变此状态。' }
];

function title(id: string): string {
  if (id === conversationId.value) return '当前对话';
  return members.value.find(member => member.conversationId === id)?.title
    || snapshot.value?.permissionCandidates.find(candidate => candidate.conversationId === id)?.title || '其他对话';
}
function memberState(status: string): string {
  return ({ active: '活动中', idle: '空闲', completed: '已完成', interrupted: '已中断', interrupting: '正在停止', closed: '已关闭', failed: '失败', pending: '等待中' } as Record<string, string>)[status] ?? status;
}
function canReadMember(member: CollaborationMember): boolean {
  return member.relation === 'team' || snapshot.value?.permissions.some(permission => permission.targetConversationId === member.conversationId && permission.allowRead) === true;
}
async function readConversation(targetConversationId: string, more = false): Promise<void> {
  await perform(async () => {
    const previous = transcript.value;
    const result = await store.readConversation(conversationId.value, targetConversationId, more ? previous?.olderMessageId ?? undefined : undefined);
    transcript.value = more && previous?.conversationId === targetConversationId
      ? { ...result, messages: [...result.messages, ...previous.messages] } : result;
  });
}
function stateLabel(message: CollaborationMessage): string {
  if (message.handled) return '已处理';
  if (message.deliveryState === 'failed') return '投递失败';
  return message.deliveryState === 'consumed' ? '已注入' : '已提交';
}
function detail(message: CollaborationMessage): string | undefined {
  return store.details[`${conversationId.value}:${message.messageId}`]?.text;
}
async function refresh(loadMore = false): Promise<void> {
  if (!conversationId.value || refreshing.value) return;
  refreshing.value = true;
  const id = conversationId.value;
  try { await store.refresh(id, loadMore ? snapshot.value?.olderCursor ?? undefined : undefined); }
  catch (failure) { if (id === conversationId.value) error.value = errorText(failure); }
  finally { refreshing.value = false; }
}
async function perform(operation: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try { await operation(); }
  catch (failure) { error.value = errorText(failure); }
  finally { busy.value = false; }
}
function errorText(failure: unknown): string { return failure instanceof Error ? failure.message : String(failure); }
async function send(mode: 'message' | 'followup'): Promise<void> {
  if (!draft.value.trim() || !canSend.value || (mode === 'followup' && !canWake.value)) return;
  await perform(async () => {
    await store.send({ conversationId: conversationId.value, targetConversationId: target.value, text: draft.value.trim(), mode,
      ...(replyToMessageId.value ? { replyToMessageId: replyToMessageId.value } : {}) });
    draft.value = '';
    replyToMessageId.value = undefined;
    notice.value = mode === 'message' ? '消息已提交；空闲目标不会因此启动。' : '继续任务已提交，将由目标执行器接收。';
    await refresh();
  });
}
async function expand(message: CollaborationMessage): Promise<void> {
  if (expandedMessage.value === message.messageId) { expandedMessage.value = ''; return; }
  expandedMessage.value = message.messageId;
  await perform(() => store.readMessage(conversationId.value, message.messageId));
}
function reply(message: CollaborationMessage): void {
  target.value = message.sourceConversationId === conversationId.value ? message.targetConversationId : message.sourceConversationId;
  replyToMessageId.value = message.messageId;
  tab.value = 'messages';
}
async function savePermission(): Promise<void> {
  if (!permissionTarget.value) return;
  await perform(async () => {
    await store.setPermission({ conversationId: conversationId.value, targetConversationId: permissionTarget.value,
      allowRead: allowRead.value, allowSend: allowSend.value, allowWake: allowSend.value && allowWake.value });
    await refresh();
    notice.value = '通信权限已保存。';
  });
}
function readPermission(): void {
  const permission = snapshot.value?.permissions.find(item => item.targetConversationId === permissionTarget.value);
  allowRead.value = permission?.allowRead ?? false;
  allowSend.value = permission?.allowSend ?? false;
  allowWake.value = permission?.allowWake ?? false;
}
function close(): void { open.value = false; void nextTick(() => trigger.value?.focus()); }
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); close(); }
  if (event.key !== 'Tab') return;
  const controls = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
  const first = controls[0]; const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
watch(tab, () => { error.value = ''; notice.value = ''; });
watch(snapshot, () => {
  if (!transcript.value) return;
  const member = members.value.find(item => item.conversationId === transcript.value?.conversationId);
  if (!member || !canReadMember(member)) transcript.value = undefined;
});
watch(permissionTarget, readPermission);
watch(allowSend, value => { if (!value) allowWake.value = false; });
watch(target, () => { replyToMessageId.value = undefined; }, { flush: 'sync' });
watch(conversationId, () => { open.value = false; target.value = ''; permissionTarget.value = ''; draft.value = ''; error.value = ''; notice.value = ''; expandedMessage.value = ''; transcript.value = undefined; });
watch(open, async value => {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  if (!value) return;
  await nextTick(); dialog.value?.focus();
  await refresh();
  if (open.value) refreshTimer = setInterval(() => { if (open.value && !busy.value && document.visibilityState === 'visible') void refresh(); }, 5_000);
});
onBeforeUnmount(() => { if (refreshTimer) clearInterval(refreshTimer); });
</script>

<template>
  <HoverTooltipPanel panel-title="对话协作" :rows="[{ label: '功能', value: '团队成员、消息、继续任务、通信权限与共享留言板' }]">
    <button ref="trigger" class="collaboration-trigger" type="button" :disabled="!conversationId" :aria-expanded="open" aria-haspopup="dialog" @click="open = true">
      <IconMessages :size="15" aria-hidden="true" /><span>协作</span>
    </button>
  </HoverTooltipPanel>
  <Teleport to="body">
    <div v-if="open" class="collaboration-backdrop" @click.self="close">
      <section ref="dialog" class="collaboration-dialog" role="dialog" aria-modal="true" aria-labelledby="collaboration-title" tabindex="-1" @keydown="keydown">
        <header><h2 id="collaboration-title">对话协作</h2><div class="actions"><button type="button" :disabled="refreshing" aria-label="刷新协作状态" @click="refresh()"><IconRefresh :size="16" /></button><button type="button" aria-label="关闭协作面板" @click="close"><IconX :size="17" /></button></div></header>
        <nav aria-label="协作功能"><button v-for="item in [{ id: 'messages', label: '消息' }, { id: 'members', label: '团队成员' }, { id: 'permissions', label: '通信权限' }, { id: 'board', label: '留言板' }]" :key="item.id" type="button" :aria-current="tab === item.id ? 'page' : undefined" @click="tab = item.id as typeof tab">{{ item.label }}</button></nav>
        <p v-if="error" class="feedback error" role="alert">{{ error }}</p><p v-if="notice" class="feedback" role="status">{{ notice }}</p>
        <div class="scroll-shell"><div ref="scroller" class="collaboration-content">
          <template v-if="tab === 'messages'">
            <label class="field-label">发送给</label><SettingsDropdown v-model="target" :options="recipientOptions" searchable placeholder="选择团队成员或已授权对话" />
            <p v-if="replyToMessageId" class="hint">正在回复选中的消息 <button type="button" class="text-button" @click="replyToMessageId = undefined">取消回复</button></p>
            <textarea v-model="draft" rows="4" aria-label="协作消息正文" placeholder="描述任务、分享进展或回复消息…" :disabled="busy" />
            <div class="send-actions"><button type="button" :disabled="busy || !canSend || !draft.trim()" @click="send('message')">仅发送消息</button><button type="button" :disabled="busy || !canWake || !draft.trim()" @click="send('followup')">发送并继续任务</button></div>
            <p class="hint">仅发送消息会在执行边界交给运行中的目标；“继续任务”还允许启动空闲目标。回复会保留原消息关联。</p>
            <div class="section-heading"><h3>通信记录</h3><HoverTooltipPanel panel-title="消息处理状态" :rows="statusRows"><button type="button" class="text-button">状态说明</button></HoverTooltipPanel></div>
            <p v-if="!messages.length" class="empty">暂无协作消息</p>
            <article v-for="message in messages" :key="message.messageId" class="message-card">
              <button type="button" class="message-heading" :aria-expanded="expandedMessage === message.messageId" @click="expand(message)"><span>{{ title(message.sourceConversationId) }} → {{ title(message.targetConversationId) }}</span><span class="message-state">{{ stateLabel(message) }}</span></button>
              <div class="message-meta">{{ message.mode === 'followup' ? '继续任务' : '消息' }} · {{ new Date(message.createdAt).toLocaleString() }}<span v-if="message.replyToMessageId"> · 回复</span></div>
              <template v-if="expandedMessage === message.messageId"><p class="message-text">{{ detail(message) ?? '正在读取正文…' }}</p><button type="button" :disabled="busy" @click="reply(message)">回复</button></template>
            </article>
            <button v-if="snapshot?.olderCursor" type="button" :disabled="refreshing" @click="refresh(true)">加载更多消息</button>
          </template>
          <template v-else-if="tab === 'members'">
            <p class="hint">同一根任务中的成员可以横向交流。创建子 Agent 的层数仍由用户设置控制，默认 1 层。</p>
            <p v-if="!members.length" class="empty">暂无可见成员</p>
            <article v-for="member in members" :key="member.conversationId" class="member-card"><div><strong>{{ title(member.conversationId) }}</strong><p class="hint">{{ member.relation === 'team' ? '团队成员' : '已授权对话' }} · {{ memberState(member.status) }}</p></div><div v-if="member.conversationId !== conversationId" class="actions"><button v-if="canReadMember(member)" type="button" :disabled="busy" @click="readConversation(member.conversationId)">查看对话</button><button type="button" @click="target = member.conversationId; tab = 'messages'">发消息</button></div></article>
            <section v-if="transcript" class="transcript"><div class="section-heading"><h3>{{ transcript.title || '未命名对话' }} · 对话内容</h3><button type="button" class="text-button" @click="transcript = undefined">收起</button></div><button v-if="transcript.hasMore && transcript.olderMessageId" type="button" :disabled="busy" @click="readConversation(transcript.conversationId, true)">读取更早消息</button><p v-if="!transcript.messages.length" class="empty">暂无对话内容</p><article v-for="message in transcript.messages" :key="message.messageId" class="message-card"><div class="message-meta">{{ message.role === 'user' ? '用户' : message.role === 'assistant' ? 'Agent' : message.role === 'tool' ? '工具' : message.role }} · {{ new Date(message.createdAt).toLocaleString() }}</div><p class="message-text">{{ message.text }}</p><p v-if="message.truncated" class="hint">此条内容较长，当前仅展示有界预览。</p></article></section>
          </template>
          <template v-else-if="tab === 'permissions'">
            <p class="hint">由你决定当前对话可以访问哪些普通对话。授权单向生效；对方要主动联系当前对话，需要在对方面板授权。模型不能修改这些权限。</p>
            <p v-if="currentIsChild" class="hint">当前是子 Agent 对话，普通对话权限由根任务面板管理。</p><label class="field-label">目标对话</label><SettingsDropdown v-model="permissionTarget" :options="permissionOptions" searchable placeholder="选择普通对话" />
            <div class="permission-options"><LcCheckbox v-model="allowRead" :disabled="!permissionTarget || busy">允许读取对话内容</LcCheckbox><LcCheckbox v-model="allowSend" :disabled="!permissionTarget || busy">允许发送消息</LcCheckbox><LcCheckbox v-model="allowWake" :disabled="!permissionTarget || !allowSend || busy">允许继续任务（启动空闲目标）</LcCheckbox></div>
            <p class="hint">开启任一权限后，目标会出现在当前对话的成员目录中。全部关闭即可撤销发现和通信权限。子 Agent 通过团队关系协作，不在这里绕过任务控制。</p>
            <button type="button" :disabled="!permissionTarget || busy" @click="savePermission">保存权限</button>
          </template>
          <CollaborationBoardPanel v-else :conversation-id="conversationId" />
        </div><AdvancedScrollbar :scroller="scroller" :refresh-key="`${tab}:${messages.length}:${expandedMessage}:${error}:${notice}`" variant="minimal" /></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.collaboration-trigger { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: 0; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 4px 6px; font-size: var(--font-size-xs); }
.collaboration-trigger:hover { color: var(--vscode-foreground); background: var(--lc-hover-bg, rgba(128,128,128,.12)); }
.collaboration-backdrop { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,.4); }
.collaboration-dialog { width: min(720px, 100%); max-height: min(760px, 90vh); min-height: 420px; display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 5px; box-shadow: 0 12px 40px rgba(0,0,0,.3); font-size: var(--font-size-sm); outline: none; }
header, .actions, .send-actions, .section-heading, .member-card { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
header { padding: 12px 16px; } h2 { margin: 0; font-size: 15px; } h3 { margin: 10px 0; font-size: 13px; }
nav { display: flex; gap: 4px; padding: 0 12px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
button { color: inherit; background: transparent; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); padding: 6px 9px; border-radius: 3px; cursor: pointer; font: inherit; }
button:hover, button[aria-current="page"] { background: rgba(128,128,128,.16); } button:focus-visible { outline: 1px solid var(--vscode-foreground); outline-offset: 2px; } button:disabled { opacity: .45; cursor: default; }
nav button, .actions button { border-color: transparent; } .actions button { display: flex; } .scroll-shell { position: relative; min-height: 0; flex: 1; display: flex; } .collaboration-content { padding: 16px; overflow: auto; flex: 1; scrollbar-width: none; } .collaboration-content::-webkit-scrollbar, textarea::-webkit-scrollbar { display: none; }
.field-label { display: block; margin-bottom: 6px; font-weight: 600; } textarea { display: block; width: 100%; box-sizing: border-box; resize: vertical; min-height: 78px; max-height: 220px; margin: 10px 0; border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 8px; color: inherit; background: var(--vscode-input-background); font: inherit; scrollbar-width: none; }
.send-actions { justify-content: flex-end; flex-wrap: wrap; }.hint, .message-meta { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); line-height: 1.6; }.empty { color: var(--vscode-descriptionForeground); padding: 20px 0; text-align: center; }.message-card { border: 1px solid var(--vscode-panel-border); padding: 10px; margin-bottom: 8px; border-radius: 3px; }.message-heading { display: flex; justify-content: space-between; text-align: left; width: 100%; border: 0; padding: 0; gap: 12px; }.message-state { white-space: nowrap; color: var(--vscode-descriptionForeground); }.message-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }.message-meta { margin-top: 6px; }.text-button { border: 0; padding: 2px 4px; font-size: var(--font-size-xs); }.feedback { margin: 8px 16px 0; color: var(--vscode-descriptionForeground); }.error { color: var(--vscode-errorForeground); }.member-card { border-bottom: 1px solid var(--vscode-panel-border); padding: 10px 0; }.member-card .hint { margin: 4px 0 0; }.permission-options { display: grid; gap: 14px; margin: 20px 0; }
@media(max-width: 480px) { .collaboration-backdrop { padding: 8px; }.collaboration-content { padding: 12px; }.message-heading { flex-wrap: wrap; } }
textarea:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-foreground); outline-offset: 1px; }
</style>
