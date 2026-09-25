import assert from 'node:assert/strict';
import test from 'node:test';
import { computed, effectScope, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { InlineDataPart, MessageRecord } from '../../shared/protocol';
import { useConversationUiStore } from '../src/stores/useConversationUiStore';
import { useChatDraftPrefill } from '../src/components/input/chatDraftPrefill';

const steeringMessage = {
  id: 'steer', conversationId: 'conversation', role: 'user', status: 'done', seq: 3, createdAt: '2026-09-25T00:00:00.000Z',
  steeringInput: true,
  content: { parts: [
    { text: '请改为先写测试' },
    { inlineData: { mimeType: 'image/png', name: 'plan.png', attachmentId: 'attachment-1', sha256: 'a'.repeat(64), storage: 'managed', status: 'available', sizeBytes: 12 } }
  ] }
} as unknown as MessageRecord;

function composer() {
  setActivePinia(createPinia());
  const ui = useConversationUiStore();
  const attachments = ref<InlineDataPart[]>([]);
  const scope = effectScope();
  const prefill = scope.run(() => useChatDraftPrefill(ui, computed({
    get: () => attachments.value,
    set: (value) => { attachments.value = value; }
  })))!;
  return { ui, attachments, prefill, stop: () => scope.stop() };
}

test('an empty chat composer takes the steering message text and its attachments at once', async () => {
  const { ui, attachments, prefill, stop } = composer();
  try {
    ui.prefillChatDraft(steeringMessage);
    await nextTick();
    assert.equal(ui.chatDraft, '请改为先写测试');
    assert.deepEqual(attachments.value.map((part) => part.inlineData.attachmentId), ['attachment-1'],
      'attachments come back like the edit and failure restore flows');
    assert.equal(prefill.pending.value, undefined);
    assert.equal(ui.chatDraftPrefill, undefined, 'the request is consumed once');
  } finally { stop(); }
});

test('a non-empty draft is replaced only after the user confirms', async () => {
  const { ui, attachments, prefill, stop } = composer();
  try {
    ui.setComposerDraft('我还没发出去的草稿');
    const own = { inlineData: { mimeType: 'text/plain', name: 'mine.txt', data: 'bWluZQ==', sizeBytes: 4 } };
    attachments.value = [own];
    ui.prefillChatDraft(steeringMessage);
    await nextTick();
    assert.equal(ui.chatDraft, '我还没发出去的草稿', 'the draft is never overwritten silently');
    assert.deepEqual(attachments.value, [own]);
    assert.ok(prefill.pending.value);
    assert.match(prefill.confirmDescription.value, /尚未发送的文字和附件/);

    prefill.cancel();
    assert.equal(prefill.pending.value, undefined);
    assert.equal(ui.chatDraft, '我还没发出去的草稿');

    ui.prefillChatDraft(steeringMessage);
    await nextTick();
    prefill.confirm();
    assert.equal(ui.chatDraft, '请改为先写测试');
    assert.deepEqual(attachments.value.map((part) => part.inlineData.name), ['plan.png']);
  } finally { stop(); }
});

test('an open edit is only left after confirmation', async () => {
  const { ui, prefill, stop } = composer();
  try {
    const edited = { ...steeringMessage, id: 'edited', steeringInput: false, content: { parts: [{ text: '旧消息' }] } } as MessageRecord;
    ui.startEditMessage(edited, 1);
    ui.prefillChatDraft(steeringMessage);
    await nextTick();
    assert.equal(ui.isEditing, true, 'the edit is not cancelled silently');
    assert.equal(ui.composerDraft, '旧消息');
    assert.match(prefill.confirmDescription.value, /正在编辑的消息会被放弃/);
    prefill.confirm();
    assert.equal(ui.isEditing, false);
    assert.equal(ui.chatDraft, '请改为先写测试');
  } finally { stop(); }
});
