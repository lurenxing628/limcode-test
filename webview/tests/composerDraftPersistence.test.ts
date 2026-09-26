import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, nextTick, ref, shallowRef, watch } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { InlineDataPart, MessageRecord } from '../../shared/protocol';
import { useConversationUiStore } from '../src/stores/useConversationUiStore';
import {
  useComposerDraftPersistence, type PersistedComposerDraft
} from '../src/components/input/composerDraftPersistence';

const part = (name: string, data = 'bWluZQ=='): InlineDataPart =>
  ({ inlineData: { mimeType: 'text/plain', name, data, sizeBytes: 4 } });

const editedMessage = {
  id: 'message-2', conversationId: 'conversation-1', role: 'user', status: 'done', seq: 2,
  createdAt: '2026-09-26T00:00:00.000Z',
  content: { parts: [{ text: '原来的问题' }, part('original.txt')] }
} as unknown as MessageRecord;

/** Webview state survives the reload; everything else (Pinia, the composer) starts over. */
function webviewState() {
  let value: unknown;
  const writes: unknown[] = [];
  return {
    writes,
    storage: {
      read: () => value,
      write: (next: PersistedComposerDraft | undefined) => {
        value = next === undefined ? undefined : structuredClone(next);
        writes.push(value);
      }
    }
  };
}

/** One window lifetime of the composer: the parts of Composer.vue the persistence works with. */
function composer(state: ReturnType<typeof webviewState>, options: {
  conversationId?: string;
  messages?: MessageRecord[];
  attachmentLimitBytes?: number;
  /** Already in the composer when the persistence starts (e.g. a restored failed send). */
  typed?: string;
} = {}) {
  setActivePinia(createPinia());
  const ui = useConversationUiStore();
  if (options.typed) ui.setComposerDraft(options.typed);
  const attachments = ref<Record<'chat' | 'edit', InlineDataPart[]>>({ chat: [], edit: [] });
  const conversationId = ref<string | undefined>(options.conversationId);
  const messages = shallowRef<MessageRecord[]>(options.messages ?? []);
  const omitted: number[] = [];
  const scope = effectScope();
  const persistence = scope.run(() => {
    const created = useComposerDraftPersistence({
      ui,
      attachments,
      conversationId: () => conversationId.value,
      findMessage: (id) => messages.value.find((message) => message.id === id),
      storage: state.storage,
      debounceMs: 0,
      attachmentLimitBytes: options.attachmentLimitBytes,
      onAttachmentsOmitted: (count) => omitted.push(count)
    });
    // Composer.vue: starting an edit resets the edit attachments from the message.
    watch(() => ui.composerHighlightKey, () => {
      if (!ui.isEditing) return;
      attachments.value = {
        ...attachments.value,
        edit: (ui.editingMessage?.message.content.parts ?? []).flatMap((item) =>
          'inlineData' in item ? [structuredClone(item as InlineDataPart)] : [])
      };
    });
    return created;
  })!;
  return {
    ui, attachments, conversationId, messages, omitted, persistence,
    close: () => { persistence.dispose(); scope.stop(); }
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test('unsent chat text and attachments survive a window reload, also in a new chat without a conversation yet', async () => {
  const state = webviewState();
  const before = composer(state);
  before.ui.setComposerDraft('还没发出去的问题');
  before.attachments.value = { ...before.attachments.value, chat: [part('notes.txt')] };
  await settle();
  const saved = state.storage.read() as PersistedComposerDraft;
  assert.deepEqual(saved.chat, { draft: '还没发出去的问题', attachments: [part('notes.txt')] });
  before.close();

  const after = composer(state, { conversationId: 'conversation-1' });
  await settle();
  assert.equal(after.ui.chatDraft, '还没发出去的问题');
  assert.deepEqual(after.attachments.value.chat, [part('notes.txt')]);
  after.close();
});

test('restores into an empty composer only, and only once', async () => {
  const state = webviewState();
  state.storage.write({ chat: { draft: '旧草稿', attachments: [] }, savedAt: 1 });
  const typed = composer(state, { typed: '已经在输入框里的' });
  await settle();
  assert.equal(typed.ui.chatDraft, '已经在输入框里的');
  typed.close();
  assert.equal((state.storage.read() as PersistedComposerDraft).chat.draft, '已经在输入框里的');

  const again = composer(state);
  again.ui.clearChatDraft();
  again.conversationId.value = 'conversation-1';
  await settle();
  assert.equal(again.ui.chatDraft, '', 'a cleared draft is not put back');
  again.close();
});

test('an open message edit comes back once its conversation is shown and the message loads', async () => {
  const state = webviewState();
  const before = composer(state, { conversationId: 'conversation-1', messages: [editedMessage] });
  before.ui.setComposerDraft('聊天框里的草稿');
  before.ui.startEditMessage(editedMessage, 2);
  await settle();
  before.ui.setComposerDraft('改过的问题');
  before.attachments.value = { ...before.attachments.value, edit: [part('replacement.txt')] };
  await settle();
  const saved = state.storage.read() as PersistedComposerDraft;
  assert.deepEqual(saved.edit, {
    kind: 'message', conversationId: 'conversation-1', messageId: 'message-2', deleteCount: 2,
    draft: '改过的问题', attachments: [part('replacement.txt')]
  });
  assert.equal(saved.chat.draft, '聊天框里的草稿');
  before.close();

  // The reloaded Webview gets its conversation and then its messages a little later.
  const after = composer(state);
  after.ui.setComposerDraft('聊天框里的草稿（重载后又改了）');
  await settle();
  assert.deepEqual((state.storage.read() as PersistedComposerDraft).edit?.draft, '改过的问题',
    'a save before the edit came back keeps it');
  after.conversationId.value = 'conversation-1';
  await settle();
  assert.equal(after.ui.composerMode, 'chat', 'waits for the message');
  after.messages.value = [editedMessage];
  await settle();
  assert.equal(after.ui.composerMode, 'edit');
  assert.equal(after.ui.editingMessage?.message.id, 'message-2');
  assert.equal(after.ui.editingMessage?.deleteCount, 2);
  assert.equal(after.ui.composerDraft, '改过的问题');
  assert.deepEqual(after.attachments.value.edit, [part('replacement.txt')], 'not reset to the original attachments');
  after.close();
});

test('a saved edit is given up when another conversation is shown first; the chat draft still comes back', async () => {
  const state = webviewState();
  state.storage.write({
    chat: { draft: '聊天框里的草稿', attachments: [] },
    edit: { kind: 'message', conversationId: 'conversation-1', messageId: 'message-2', deleteCount: 2, draft: '改过的问题', attachments: [] },
    savedAt: 1
  });
  const after = composer(state, { conversationId: 'conversation-2', messages: [editedMessage] });
  await settle();
  assert.equal(after.ui.chatDraft, '聊天框里的草稿');
  assert.equal(after.ui.composerMode, 'chat');
  after.conversationId.value = 'conversation-1';
  await settle();
  assert.equal(after.ui.composerMode, 'chat');
  after.close();
  assert.equal((state.storage.read() as PersistedComposerDraft).edit, undefined);
});

test('an edit of a queued turn intent comes back as well', async () => {
  const state = webviewState();
  const before = composer(state, { conversationId: 'conversation-1' });
  before.ui.startEditTurnIntent({ intentId: 'intent-1', rowVersion: 3 }, '排队中的问题');
  await settle();
  before.ui.setComposerDraft('排队中的问题（改）');
  await settle();
  before.close();

  const after = composer(state, { conversationId: 'conversation-1' });
  await settle();
  assert.equal(after.ui.composerMode, 'edit');
  assert.deepEqual(after.ui.editingTurnIntent, { intentId: 'intent-1', rowVersion: 3 });
  assert.equal(after.ui.composerDraft, '排队中的问题（改）');
  after.close();
});

test('attachments too large for Webview state are dropped, the text is kept and the user is told', async () => {
  const state = webviewState();
  const before = composer(state, { conversationId: 'conversation-1', attachmentLimitBytes: 10 });
  before.ui.setComposerDraft('带大附件的问题');
  before.attachments.value = { ...before.attachments.value, chat: [part('small.txt', 'c21hbGw='), part('large.bin', 'x'.repeat(64))] };
  await settle();
  const saved = state.storage.read() as PersistedComposerDraft;
  assert.deepEqual(saved.chat.attachments.map((item) => item.inlineData.name), ['small.txt']);
  assert.equal(saved.omittedAttachments, 1);
  before.close();

  const after = composer(state, { conversationId: 'conversation-1' });
  await settle();
  assert.equal(after.ui.chatDraft, '带大附件的问题');
  assert.deepEqual(after.attachments.value.chat.map((item) => item.inlineData.name), ['small.txt']);
  assert.deepEqual(after.omitted, [1]);
  after.close();
});

test('a sent (emptied) composer clears the saved draft, and malformed state is ignored', async () => {
  const state = webviewState();
  const before = composer(state, { conversationId: 'conversation-1' });
  before.ui.setComposerDraft('要发送的问题');
  await settle();
  assert.ok(state.storage.read());
  before.ui.clearChatDraft();
  await settle();
  assert.equal(state.storage.read(), undefined);
  before.close();

  state.storage.write({ chat: { draft: 42 } } as unknown as PersistedComposerDraft);
  const after = composer(state, { conversationId: 'conversation-1' });
  await settle();
  assert.equal(after.ui.chatDraft, '');
  after.close();
});
