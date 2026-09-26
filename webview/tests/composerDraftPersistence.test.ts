import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, nextTick, ref, shallowRef, watch } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { InlineDataPart, MessageRecord } from '../../shared/protocol';
import { useConversationUiStore } from '../src/stores/useConversationUiStore';
import {
  useComposerDraftPersistence, type PersistedComposerDraft
} from '../src/components/input/composerDraftPersistence';

const DEBOUNCE_MS = 30;

const part = (name: string, data = 'bWluZQ=='): InlineDataPart =>
  ({ inlineData: { mimeType: 'text/plain', name, data, sizeBytes: 4 } });

const editedMessage = {
  id: 'message-2', revisionId: 'revision-1', conversationId: 'conversation-1', role: 'user', status: 'done', seq: 2,
  createdAt: '2026-09-26T00:00:00.000Z',
  content: { parts: [{ text: '原来的问题' }, part('original.txt')] }
} as unknown as MessageRecord;

/**
 * Webview state (vscode.setState) survives a window reload; nothing else does. A reload tears the
 * Webview down without unmount hooks, so a composer never gets to flush: a save still waiting for
 * its debounce is lost, exactly as in VS Code.
 */
function webviewState() {
  let value: unknown;
  let generation = 0;
  return {
    read: () => value,
    write: (next: PersistedComposerDraft | undefined) => {
      value = next === undefined ? undefined : structuredClone(next);
    },
    /** Storage of one Webview lifetime; writes after its reload are dropped. */
    session() {
      const own = (generation += 1);
      return {
        read: () => value,
        write: (next: PersistedComposerDraft | undefined) => {
          if (own === generation) value = next === undefined ? undefined : structuredClone(next);
        }
      };
    },
    reloadWindow() { generation += 1; }
  };
}

/** One window lifetime of the composer: the parts of Composer.vue the persistence works with. */
function composer(state: ReturnType<typeof webviewState>, options: {
  conversationId?: string;
  messages?: MessageRecord[];
  attachmentLimitBytes?: number;
  /** Already in the composer when the persistence starts (e.g. a restored failed send). */
  typed?: string;
  pendingInputTexts?: string[];
} = {}) {
  setActivePinia(createPinia());
  const ui = useConversationUiStore();
  if (options.typed) ui.setComposerDraft(options.typed);
  const attachments = ref<Record<'chat' | 'edit', InlineDataPart[]>>({ chat: [], edit: [] });
  const conversationId = ref<string | undefined>(options.conversationId);
  const messages = shallowRef<MessageRecord[]>(options.messages ?? []);
  const omitted: number[] = [];
  let discarded = 0;
  const scope = effectScope();
  scope.run(() => {
    useComposerDraftPersistence({
      ui,
      attachments,
      conversationId: () => conversationId.value,
      findMessage: (id) => messages.value.find((message) => message.id === id),
      storage: state.session(),
      pendingInputTexts: () => options.pendingInputTexts ?? [],
      debounceMs: DEBOUNCE_MS,
      attachmentLimitBytes: options.attachmentLimitBytes,
      onAttachmentsOmitted: (count) => omitted.push(count),
      onEditDiscarded: () => { discarded += 1; }
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
  });
  return {
    ui, attachments, conversationId, messages, omitted,
    discarded: () => discarded,
    /** The window reloads: no dispose, no flush. */
    reload: () => { state.reloadWindow(); scope.stop(); }
  };
}

async function settle(ms = 5): Promise<void> {
  for (let i = 0; i < 4; i += 1) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Longer than the save debounce: what the user typed is on disk. */
const saved = () => settle(DEBOUNCE_MS * 3);

test('unsent chat text and attachments survive a window reload, also in a new chat without a conversation yet', async () => {
  const state = webviewState();
  const before = composer(state);
  before.ui.setComposerDraft('还没发出去的问题');
  before.attachments.value = { ...before.attachments.value, chat: [part('notes.txt')] };
  await saved();
  assert.deepEqual((state.read() as PersistedComposerDraft).chat, { draft: '还没发出去的问题', attachments: [part('notes.txt')] });
  before.reload();

  const after = composer(state, { conversationId: 'conversation-1' });
  await settle();
  assert.equal(after.ui.chatDraft, '还没发出去的问题');
  assert.deepEqual(after.attachments.value.chat, [part('notes.txt')]);
  after.reload();
});

test('a sent (cleared) draft is written at once: a reload right after does not bring it back', async () => {
  const state = webviewState();
  const before = composer(state, { conversationId: 'conversation-1' });
  before.ui.setComposerDraft('已经发出去的问题');
  before.attachments.value = { ...before.attachments.value, chat: [part('sent.txt')] };
  await saved();
  // The Turn input was acknowledged: the composer clears; the window reloads immediately.
  before.attachments.value = { ...before.attachments.value, chat: [] };
  before.ui.clearChatDraft();
  await nextTick();
  before.reload();

  const after = composer(state, { conversationId: 'conversation-1' });
  await settle();
  assert.equal(after.ui.chatDraft, '');
  assert.deepEqual(after.attachments.value.chat, []);
  after.reload();
});

test('a draft that is a Turn input still being sent is not restored (the reload sends it again) and is dropped', async () => {
  const state = webviewState();
  state.write({ chat: { draft: '已经提交、还没确认的问题', attachments: [] }, savedAt: 1 });
  const after = composer(state, { conversationId: 'conversation-1', pendingInputTexts: ['已经提交、还没确认的问题'] });
  await settle();
  assert.equal(after.ui.chatDraft, '');
  assert.equal(state.read(), undefined, 'not restored by a later reload either');
  after.reload();

  state.write({ chat: { draft: '另一句草稿', attachments: [] }, savedAt: 1 });
  const other = composer(state, { pendingInputTexts: ['已经提交、还没确认的问题'] });
  await settle();
  assert.equal(other.ui.chatDraft, '另一句草稿');
  other.reload();
});

test('restores into an empty composer only, and only once', async () => {
  const state = webviewState();
  state.write({ chat: { draft: '旧草稿', attachments: [] }, savedAt: 1 });
  const typed = composer(state, { typed: '已经在输入框里的' });
  await settle();
  assert.equal(typed.ui.chatDraft, '已经在输入框里的');
  typed.ui.setComposerDraft('已经在输入框里的！');
  await saved();
  typed.reload();
  assert.equal((state.read() as PersistedComposerDraft).chat.draft, '已经在输入框里的！');

  const again = composer(state);
  await settle();
  again.ui.clearChatDraft();
  again.conversationId.value = 'conversation-1';
  await settle();
  assert.equal(again.ui.chatDraft, '', 'a cleared draft is not put back');
  again.reload();
});

test('an open message edit comes back once its conversation is shown and the message (same revision) loads', async () => {
  const state = webviewState();
  const before = composer(state, { conversationId: 'conversation-1', messages: [editedMessage] });
  before.ui.setComposerDraft('聊天框里的草稿');
  before.ui.startEditMessage(editedMessage, 2);
  await settle();
  before.ui.setComposerDraft('改过的问题');
  before.attachments.value = { ...before.attachments.value, edit: [part('replacement.txt')] };
  await saved();
  const stored = state.read() as PersistedComposerDraft;
  assert.deepEqual(stored.edit, {
    kind: 'message', conversationId: 'conversation-1', messageId: 'message-2', revisionId: 'revision-1', deleteCount: 2,
    draft: '改过的问题', attachments: [part('replacement.txt')]
  });
  assert.equal(stored.chat.draft, '聊天框里的草稿');
  before.reload();

  // The reloaded Webview gets its conversation and then its messages a little later.
  const after = composer(state);
  after.ui.setComposerDraft('聊天框里的草稿（重载后又改了）');
  await saved();
  assert.equal((state.read() as PersistedComposerDraft).edit?.draft, '改过的问题', 'a save before the edit came back keeps it');
  after.conversationId.value = 'conversation-1';
  await settle();
  assert.equal(after.ui.composerMode, 'chat', 'waits for the message');
  after.messages.value = [editedMessage];
  await settle();
  assert.equal(after.ui.composerMode, 'edit');
  assert.equal(after.ui.editingMessage?.message.revisionId, 'revision-1');
  assert.equal(after.ui.editingMessage?.deleteCount, 2);
  assert.equal(after.ui.composerDraft, '改过的问题');
  assert.deepEqual(after.attachments.value.edit, [part('replacement.txt')], 'not reset to the original attachments');
  assert.equal(after.discarded(), 0);
  after.reload();
});

test('an edit of a message changed meanwhile (another revision) is not restored, and the user is told', async () => {
  const state = webviewState();
  const before = composer(state, { conversationId: 'conversation-1', messages: [editedMessage] });
  before.ui.startEditMessage(editedMessage, 2);
  await settle();
  before.ui.setComposerDraft('基于修订 1 改写的问题');
  await saved();
  before.reload();

  const changed = { ...editedMessage, revisionId: 'revision-2', content: { parts: [{ text: '另一个窗口改过的问题' }] } } as unknown as MessageRecord;
  const after = composer(state, { conversationId: 'conversation-1', messages: [changed] });
  await settle();
  assert.equal(after.ui.composerMode, 'chat', 'the new revision is never edited with the old text');
  assert.equal(after.discarded(), 1);
  after.reload();
});

test('closing an edit is written at once: a reload right after does not reopen it', async () => {
  const state = webviewState();
  const before = composer(state, { conversationId: 'conversation-1', messages: [editedMessage] });
  before.ui.startEditMessage(editedMessage, 2);
  await settle();
  before.ui.setComposerDraft('改到一半');
  await saved();
  assert.ok((state.read() as PersistedComposerDraft).edit);
  before.ui.cancelEditMode();
  await nextTick();
  before.reload();

  const after = composer(state, { conversationId: 'conversation-1', messages: [editedMessage] });
  await settle();
  assert.equal(after.ui.composerMode, 'chat');
  after.reload();
});

test('a saved edit is given up when another conversation is shown first; the chat draft still comes back', async () => {
  const state = webviewState();
  state.write({
    chat: { draft: '聊天框里的草稿', attachments: [] },
    edit: { kind: 'message', conversationId: 'conversation-1', messageId: 'message-2', revisionId: 'revision-1', deleteCount: 2, draft: '改过的问题', attachments: [] },
    savedAt: 1
  });
  const after = composer(state, { conversationId: 'conversation-2', messages: [editedMessage] });
  await settle();
  assert.equal(after.ui.chatDraft, '聊天框里的草稿');
  assert.equal(after.ui.composerMode, 'chat');
  after.conversationId.value = 'conversation-1';
  await settle();
  assert.equal(after.ui.composerMode, 'chat');
  after.ui.setComposerDraft('聊天框里的草稿！');
  await saved();
  assert.equal((state.read() as PersistedComposerDraft).edit, undefined);
  after.reload();
});

test('an edit of a queued turn intent comes back as well', async () => {
  const state = webviewState();
  const before = composer(state, { conversationId: 'conversation-1' });
  before.ui.startEditTurnIntent({ intentId: 'intent-1', rowVersion: 3 }, '排队中的问题');
  await settle();
  before.ui.setComposerDraft('排队中的问题（改）');
  await saved();
  before.reload();

  const after = composer(state, { conversationId: 'conversation-1' });
  await settle();
  assert.equal(after.ui.composerMode, 'edit');
  assert.deepEqual(after.ui.editingTurnIntent, { intentId: 'intent-1', rowVersion: 3 });
  assert.equal(after.ui.composerDraft, '排队中的问题（改）');
  after.reload();
});

test('attachments too large for Webview state are dropped, the text is kept and the user is told', async () => {
  const state = webviewState();
  const before = composer(state, { conversationId: 'conversation-1', attachmentLimitBytes: 10 });
  before.ui.setComposerDraft('带大附件的问题');
  before.attachments.value = { ...before.attachments.value, chat: [part('small.txt', 'c21hbGw='), part('large.bin', 'x'.repeat(64))] };
  await saved();
  const stored = state.read() as PersistedComposerDraft;
  assert.deepEqual(stored.chat.attachments.map((item) => item.inlineData.name), ['small.txt']);
  assert.equal(stored.omittedAttachments, 1);
  before.reload();

  const after = composer(state, { conversationId: 'conversation-1' });
  await settle();
  assert.equal(after.ui.chatDraft, '带大附件的问题');
  assert.deepEqual(after.attachments.value.chat.map((item) => item.inlineData.name), ['small.txt']);
  assert.deepEqual(after.omitted, [1]);
  after.reload();
});

test('malformed state is ignored', async () => {
  const state = webviewState();
  state.write({ chat: { draft: 42 } } as unknown as PersistedComposerDraft);
  const after = composer(state, { conversationId: 'conversation-1' });
  await settle();
  assert.equal(after.ui.chatDraft, '');
  after.reload();
});
