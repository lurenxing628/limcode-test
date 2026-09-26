import { nextTick, watch, type Ref, type WatchStopHandle } from 'vue';
import type { InlineDataPart, MessageRecord } from '@shared/protocol';
import { toStructuredClonePlainData } from '@shared/plainData';

/** Webview state key: survives a window reload (the panel serializer restores the same state). */
export const PERSISTED_COMPOSER_DRAFT_KEY = 'limcode.composerDraft';
/** Inline attachment bytes kept in Webview state; larger unsent files are dropped, the text is kept. */
export const PERSISTED_COMPOSER_ATTACHMENT_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 250;
/** An edit whose message never loads again (deleted meanwhile) is given up after this. */
const EDIT_RESTORE_TIMEOUT_MS = 30_000;

type EditSnapshot =
  | { kind: 'message'; conversationId: string; messageId: string; deleteCount: number; draft: string; attachments: InlineDataPart[] }
  | { kind: 'turnIntent'; conversationId: string; intentId: string; rowVersion: number; draft: string; attachments: InlineDataPart[] };

export interface PersistedComposerDraft {
  /** The chat draft is not tied to a conversation (the composer keeps it across switches). */
  chat: { draft: string; attachments: InlineDataPart[] };
  /** An open edit belongs to its conversation and comes back only there. */
  edit?: EditSnapshot;
  /** Unsent attachments over the limit that could not be kept. */
  omittedAttachments?: number;
  savedAt: number;
}

/** The parts of the conversation UI store the composer draft persistence needs. */
export interface ComposerDraftHost {
  readonly composerMode: 'chat' | 'edit';
  readonly chatDraft: string;
  readonly composerDraft: string;
  readonly editingMessage: { message: MessageRecord; deleteCount: number } | undefined;
  readonly editingTurnIntent: { intentId: string; rowVersion: number } | undefined;
  replaceChatDraft(text: string): void;
  startEditMessage(message: MessageRecord, deleteCount: number): void;
  startEditTurnIntent(intent: { intentId: string; rowVersion: number }, messageText: string): void;
  setComposerDraft(value: string): void;
}

export interface ComposerDraftStorage {
  read(): unknown;
  write(value: PersistedComposerDraft | undefined): void;
}

export interface ComposerDraftPersistenceOptions {
  ui: ComposerDraftHost;
  attachments: Ref<Record<'chat' | 'edit', InlineDataPart[]>>;
  conversationId(): string | undefined;
  findMessage(messageId: string): MessageRecord | undefined;
  storage: ComposerDraftStorage;
  debounceMs?: number;
  attachmentLimitBytes?: number;
  onAttachmentsOmitted?(count: number): void;
}

/**
 * Keeps the unsent composer (chat draft, its attachments and an open edit) in the Webview's own
 * persisted state, so a window reload (for example when another window needs the data directory
 * for a moment) does not lose what the user typed. The chat draft comes back when the composer is
 * created, unless something is already there; an open edit comes back once its conversation is
 * shown (and its message loaded) and is given up when another conversation is shown first.
 */
export function useComposerDraftPersistence(options: ComposerDraftPersistenceOptions): { flush(): void; dispose(): void } {
  const { ui, attachments, storage } = options;
  const limitBytes = options.attachmentLimitBytes ?? PERSISTED_COMPOSER_ATTACHMENT_LIMIT_BYTES;
  const saved = parsePersisted(storage.read());
  // Saved again as it was until it is restored or given up, so an early save cannot drop it.
  let pendingEdit = saved?.edit;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let messageWait: WatchStopHandle | undefined;
  let waitingForMessage = false;
  const giveUpTimer = pendingEdit ? setTimeout(settlePendingEdit, EDIT_RESTORE_TIMEOUT_MS) : undefined;

  if (saved) {
    if (ui.composerMode === 'chat' && !ui.chatDraft.trim() && attachments.value.chat.length === 0) {
      if (saved.chat.draft) ui.replaceChatDraft(saved.chat.draft);
      if (saved.chat.attachments.length) attachments.value = { ...attachments.value, chat: clone(saved.chat.attachments) };
    }
    if (saved.omittedAttachments) options.onAttachmentsOmitted?.(saved.omittedAttachments);
  }

  const stopRestore = watch(() => options.conversationId(), (conversationId) => {
    const edit = pendingEdit;
    if (!edit || !conversationId) return;
    if (conversationId !== edit.conversationId || ui.composerMode === 'edit') {
      settlePendingEdit();
      return;
    }
    if (waitingForMessage) return;
    if (edit.kind === 'turnIntent') {
      settlePendingEdit();
      ui.startEditTurnIntent({ intentId: edit.intentId, rowVersion: edit.rowVersion }, edit.draft);
      void nextTick(() => applyEdit(edit));
      return;
    }
    // Messages arrive with the conversation projection; wait for the edited one (bounded).
    waitingForMessage = true;
    messageWait = watch(() => options.findMessage(edit.messageId), (message) => {
      if (!message || pendingEdit !== edit) return;
      settlePendingEdit();
      if (ui.composerMode === 'edit' || options.conversationId() !== edit.conversationId) return;
      ui.startEditMessage(message, edit.deleteCount);
      // The composer resets edit attachments from the message on its next flush; apply afterwards.
      void nextTick(() => nextTick(() => applyEdit(edit)));
    }, { immediate: true });
    // Already loaded: the immediate callback settled before the stop handle existed.
    if (pendingEdit !== edit) settlePendingEdit();
  }, { immediate: true });

  const stopSave = watch(() => [
    options.conversationId(),
    ui.composerMode,
    ui.chatDraft,
    ui.composerDraft,
    ui.editingMessage?.message.id,
    ui.editingMessage?.deleteCount,
    ui.editingTurnIntent?.intentId,
    ui.editingTurnIntent?.rowVersion,
    attachments.value
  ], schedule, { deep: true });

  function applyEdit(edit: EditSnapshot): void {
    const same = edit.kind === 'message'
      ? ui.editingMessage?.message.id === edit.messageId
      : ui.editingTurnIntent?.intentId === edit.intentId;
    if (ui.composerMode !== 'edit' || !same) return;
    ui.setComposerDraft(edit.draft);
    attachments.value = { ...attachments.value, edit: clone(edit.attachments) };
  }

  /** The saved edit was restored, or cannot be any more: stop carrying it along. */
  function settlePendingEdit(): void {
    pendingEdit = undefined;
    waitingForMessage = false;
    messageWait?.();
    messageWait = undefined;
    if (giveUpTimer !== undefined) clearTimeout(giveUpTimer);
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    storage.write(snapshot());
  }

  function snapshot(): PersistedComposerDraft | undefined {
    let budget = limitBytes;
    let omitted = 0;
    const keep = (parts: readonly InlineDataPart[]): InlineDataPart[] => parts.flatMap((part) => {
      const size = part.inlineData.data?.length ?? 0;
      if (size > budget) {
        omitted += 1;
        return [];
      }
      budget -= size;
      return [part];
    });
    const chat = { draft: ui.chatDraft, attachments: keep(attachments.value.chat) };
    const conversationId = options.conversationId();
    let edit: EditSnapshot | undefined;
    if (ui.composerMode === 'edit' && conversationId && ui.editingMessage) {
      edit = {
        kind: 'message', conversationId, messageId: ui.editingMessage.message.id, deleteCount: ui.editingMessage.deleteCount,
        draft: ui.composerDraft, attachments: keep(attachments.value.edit)
      };
    } else if (ui.composerMode === 'edit' && conversationId && ui.editingTurnIntent) {
      edit = {
        kind: 'turnIntent', conversationId, intentId: ui.editingTurnIntent.intentId, rowVersion: ui.editingTurnIntent.rowVersion,
        draft: ui.composerDraft, attachments: keep(attachments.value.edit)
      };
    } else if (pendingEdit) {
      edit = { ...pendingEdit, attachments: keep(pendingEdit.attachments) };
    }
    if (!chat.draft && chat.attachments.length === 0 && !edit && omitted === 0) return undefined;
    return toStructuredClonePlainData({
      chat,
      ...(edit ? { edit } : {}),
      ...(omitted ? { omittedAttachments: omitted } : {}),
      savedAt: Date.now()
    }, 'composer draft') as unknown as PersistedComposerDraft;
  }

  return {
    flush,
    dispose() {
      flush();
      stopRestore();
      stopSave();
      settlePendingEdit();
    }
  };
}

function parsePersisted(value: unknown): PersistedComposerDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<PersistedComposerDraft>;
  if (!record.chat || typeof record.chat.draft !== 'string'
    || !Array.isArray(record.chat.attachments) || !record.chat.attachments.every(isInlineDataPart)) return undefined;
  const edit = record.edit;
  const validEdit = edit === undefined || (
    typeof edit === 'object' && typeof edit.conversationId === 'string' && typeof edit.draft === 'string'
    && Array.isArray(edit.attachments) && edit.attachments.every(isInlineDataPart)
    && ((edit.kind === 'message' && typeof edit.messageId === 'string' && Number.isSafeInteger(edit.deleteCount))
      || (edit.kind === 'turnIntent' && typeof edit.intentId === 'string' && Number.isSafeInteger(edit.rowVersion)))
  );
  if (!validEdit) return undefined;
  return record as PersistedComposerDraft;
}

function isInlineDataPart(part: unknown): part is InlineDataPart {
  const inline = (part as InlineDataPart | undefined)?.inlineData;
  return !!inline && typeof inline === 'object' && typeof inline.mimeType === 'string';
}

function clone(parts: readonly InlineDataPart[]): InlineDataPart[] {
  return parts.map((part) => ({ ...part, inlineData: { ...part.inlineData } }));
}
