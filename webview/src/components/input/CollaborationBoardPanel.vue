<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CollaborationBoardChannel, CollaborationBoardPost } from '@shared/collaboration';
import { useCollaborationStore } from '@webview/stores/useCollaborationStore';
import SettingsDropdown from '@webview/components/settings/global/SettingsDropdown.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';

const props = defineProps<{ conversationId: string }>();
const store = useCollaborationStore();
const channels = ref<CollaborationBoardChannel[]>([]);
const channelId = ref('');
const channelsCursor = ref<string>();
const posts = ref<CollaborationBoardPost[]>([]);
const postsCursor = ref<string>();
const threadId = ref('');
const threadSubscribed = ref(false);
const rootPost = ref<CollaborationBoardPost>();
const replies = ref<CollaborationBoardPost[]>([]);
const repliesCursor = ref<string>();
const bodies = ref<Record<string, { text: string; nextOffsetChars?: number }>>({});
const query = ref('');
const draft = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);
const creatingChannel = ref(false);
const channelOptions = computed(() => channels.value.map(channel => ({ value: channel.id, label: channel.name })));
const selectedChannel = computed(() => channels.value.find(channel => channel.id === channelId.value));
const visiblePosts = computed(() => threadId.value ? [...(rootPost.value ? [rootPost.value] : []), ...replies.value] : posts.value);
function errorText(failure: unknown): string { return failure instanceof Error ? failure.message : String(failure); }
async function act(operation: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await operation(); } catch (failure) { error.value = errorText(failure); }
  finally { busy.value = false; }
}
async function loadChannels(more = false): Promise<void> {
  const result = await store.board({ conversationId: props.conversationId, operation: 'list_channels', limit: 50,
    ...(more && channelsCursor.value ? { cursor: channelsCursor.value } : {}) });
  channels.value = more ? [...channels.value, ...(result.channels ?? [])] : result.channels ?? [];
  channelsCursor.value = result.nextCursor;
  if (!channels.value.some(channel => channel.id === channelId.value)) channelId.value = channels.value[0]?.id ?? '';
}
async function loadPosts(more = false): Promise<void> {
  if (!channelId.value) { posts.value = []; return; }
  const result = await store.board({ conversationId: props.conversationId,
    operation: query.value.trim() ? 'search' : 'list_threads', channelId: channelId.value, limit: 30,
    ...(query.value.trim() ? { query: query.value.trim() } : {}),
    ...(more && postsCursor.value ? { cursor: postsCursor.value } : {}) });
  posts.value = more ? [...posts.value, ...(result.posts ?? [])] : result.posts ?? [];
  postsCursor.value = result.nextCursor;
}
async function loadThread(more = false): Promise<void> {
  const result = await store.board({ conversationId: props.conversationId, operation: 'read_thread', threadId: threadId.value, limit: 30,
    ...(more && repliesCursor.value ? { cursor: repliesCursor.value } : {}) });
  rootPost.value = result.root; replies.value = more ? [...replies.value, ...(result.replies ?? [])] : result.replies ?? [];
  repliesCursor.value = result.nextCursor; threadSubscribed.value = result.subscribed === true;
}
async function selectThread(post: CollaborationBoardPost): Promise<void> {
  await act(async () => {
    threadId.value = post.threadId;
    await loadThread();
    if (rootPost.value) await readPost(rootPost.value);
  });
}
async function readPost(post: CollaborationBoardPost, more = false): Promise<void> {
  const offset = more ? bodies.value[post.id]?.nextOffsetChars : undefined;
  const result = await store.board({ conversationId: props.conversationId, operation: 'read_post', postId: post.id, limitChars: 8000,
    ...(offset !== undefined ? { offsetChars: offset } : {}) });
  bodies.value = { ...bodies.value, [post.id]: { text: (more ? bodies.value[post.id]?.text ?? '' : '') + (result.text ?? ''), nextOffsetChars: result.nextOffsetChars } };
}
async function createChannel(name: string): Promise<void> {
  creatingChannel.value = false;
  await act(async () => {
    const result = await store.board({ conversationId: props.conversationId, operation: 'create_channel', name: name.trim(), subscribe: true });
    await loadChannels();
    channelId.value = result.channel?.id ?? channelId.value;
    await loadPosts();
  });
}
async function subscribe(value: boolean, toThread = false): Promise<void> {
  await act(async () => {
    const result = await store.board({ conversationId: props.conversationId, operation: value ? 'subscribe' : 'unsubscribe',
      ...(toThread ? { threadId: threadId.value } : { channelId: channelId.value }) });
    if (toThread) threadSubscribed.value = result.subscribed === true;
    else channels.value = channels.value.map(channel => channel.id === channelId.value ? { ...channel, subscribed: result.subscribed === true } : channel);
  });
}
async function publish(): Promise<void> {
  if (!draft.value.trim() || !channelId.value) return;
  await act(async () => {
    await store.board({ conversationId: props.conversationId, operation: 'post', text: draft.value.trim(),
      ...(threadId.value ? { threadId: threadId.value } : { channelId: channelId.value }) });
    draft.value = '';
    notice.value = '留言已发布。运行中的订阅成员会收到通知，空闲成员不会被启动。';
    if (threadId.value) await loadThread(); else await loadPosts();
  });
}
async function refresh(): Promise<void> { await act(async () => { await loadChannels(); if (threadId.value) await loadThread(); else await loadPosts(); }); }
watch(channelId, () => { threadId.value = ''; rootPost.value = undefined; replies.value = []; posts.value = []; postsCursor.value = undefined; query.value = ''; if (!busy.value) void act(() => loadPosts()); });
watch(() => props.conversationId, () => { channels.value = []; channelId.value = ''; bodies.value = {}; draft.value = ''; void refresh(); }, { immediate: true });
</script>

<template>
  <div class="board">
    <p class="hint">留言板由同一根任务的团队共享。订阅只通知正在运行的成员，不会启动空闲 Agent。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="notice" class="hint" role="status">{{ notice }}</p>
    <div class="toolbar"><div class="channel-dropdown"><SettingsDropdown v-model="channelId" :options="channelOptions" placeholder="选择频道" :disabled="busy" /></div><button type="button" :disabled="busy" @click="creatingChannel = true">新建频道</button><button type="button" :disabled="busy" @click="refresh">刷新</button></div>
    <button v-if="channelsCursor" type="button" :disabled="busy" @click="act(() => loadChannels(true))">更多频道</button>
    <div v-if="selectedChannel" class="subscription"><LcCheckbox :model-value="selectedChannel.subscribed" :disabled="busy" @update:model-value="subscribe($event)">订阅此频道</LcCheckbox></div>
    <template v-if="channelId">
      <div v-if="threadId" class="toolbar"><button type="button" :disabled="busy" @click="threadId = ''; rootPost = undefined">返回频道</button><LcCheckbox :model-value="threadSubscribed" :disabled="busy" @update:model-value="subscribe($event, true)">订阅此讨论</LcCheckbox></div>
      <form v-else class="toolbar search" @submit.prevent="act(() => loadPosts())"><input v-model="query" aria-label="搜索频道留言" placeholder="搜索此频道的留言…" /><button type="submit" :disabled="busy">搜索</button></form>
      <p v-if="!visiblePosts.length" class="hint empty">{{ busy ? '正在加载…' : '暂无留言' }}</p>
      <article v-for="post in visiblePosts" :key="post.id" class="post">
        <div class="post-meta">{{ post.authorConversationId === conversationId ? '当前对话' : (store.snapshots[conversationId]?.members.find(member => member.conversationId === post.authorConversationId)?.title || '团队成员') }} · {{ post.authorKind === 'user' ? '用户' : 'Agent' }} · {{ new Date(post.createdAt).toLocaleString() }}</div>
        <p class="post-text">{{ bodies[post.id]?.text ?? post.preview }}</p>
        <div class="toolbar"><button v-if="!threadId" type="button" :disabled="busy" @click="selectThread(post)">查看讨论 / 回复</button><button v-if="!bodies[post.id]" type="button" :disabled="busy" @click="act(() => readPost(post))">读取全文</button><button v-else-if="bodies[post.id].nextOffsetChars !== undefined" type="button" :disabled="busy" @click="act(() => readPost(post, true))">继续读取</button></div>
      </article>
      <button v-if="threadId ? repliesCursor : postsCursor" type="button" :disabled="busy" @click="act(() => threadId ? loadThread(true) : loadPosts(true))">加载更多</button>
      <textarea v-model="draft" rows="3" :aria-label="threadId ? '回复正文' : '新讨论正文'" :placeholder="threadId ? '回复此讨论…' : '发起新讨论…'" :disabled="busy" />
      <div class="publish"><button type="button" :disabled="busy || !draft.trim()" @click="publish">{{ threadId ? '发布回复' : '发布讨论' }}</button></div>
    </template>
    <InputPanel :open="creatingChannel" title="新建团队频道" label="频道名称" placeholder="例如：实现讨论" confirm-label="创建并订阅" :validate="value => value.length > 80 ? '频道名称最多 80 个字符' : ''" @confirm="createChannel" @cancel="creatingChannel = false" />
  </div>
</template>

<style scoped>
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }.channel-dropdown { flex: 1; min-width: 130px; }.subscription { margin: 14px 0; }.hint, .post-meta { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); line-height: 1.6; }.empty { padding: 20px; text-align: center; }.error { color: var(--vscode-errorForeground); }.post { border: 1px solid var(--vscode-panel-border); padding: 10px; margin: 10px 0; border-radius: 3px; }.post-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }.post-meta { margin-bottom: 5px; }button { color: inherit; background: transparent; border: 1px solid var(--vscode-panel-border); padding: 6px 9px; border-radius: 3px; cursor: pointer; font: inherit; }button:hover { background: rgba(128,128,128,.16); }button:focus-visible { outline: 1px solid var(--vscode-foreground); outline-offset: 2px; }button:disabled { opacity: .45; cursor: default; }input, textarea { color: inherit; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 8px; font: inherit; box-sizing: border-box; }.search input { flex: 1; min-width: 130px; }textarea { width: 100%; margin-top: 14px; resize: vertical; min-height: 78px; max-height: 220px; scrollbar-width: none; }textarea::-webkit-scrollbar { display: none; }.publish { display: flex; justify-content: flex-end; margin-top: 8px; }
textarea:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-foreground); outline-offset: 1px; }
</style>
