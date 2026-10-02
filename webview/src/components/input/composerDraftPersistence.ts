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

export interface SubmittedComposerDraft {
  commandId: string;
  conversationId: string;
}

type EditSnapshot =
  | {
    kind: 'message'; conversationId: string; messageId: string;
    /** The revision the edit started from; a message changed meanwhile is not edited again. */
    revisionId?: string;
    deleteCount: number; draft: string; attachments: InlineDataPart[];
  }
  | { kind: 'turnIntent'; conversationId: string; intentId: string; rowVersion: number; draft: string; attachments: InlineDataPart[] };

export interface PersistedComposerDraft {
  /** The chat draft is not tied to a conversation (the composer keeps it across switches). */
  chat: { draft: string; attachments: InlineDataPart[]; submitted?: SubmittedComposerDraft };
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
  /** Exact commands already owned by the reliable input lifecycle; never replayed here. */
  pendingInputCommands?(): readonly SubmittedComposerDraft[];
  /** Present only while the chat draft is the unchanged draft of this submission. */
  submittedChatDraft?(): SubmittedComposerDraft | undefined;
  debounceMs?: number;
  attachmentLimitBytes?: number;
  onAttachmentsOmitted?(count: number): void;
  /** The edited message changed after the edit started (another window): the edit was not restored. */
  onEditDiscarded?(): void;
  /**
   * Subscribes to the host's request to save at once (the window is about to reload); returns the
   * unsubscribe. Such a request, and the page going away (pagehide), write immediately.
   */
  onSaveRequest?(listener: () => void): () => void;
  /** Where pagehide is listened for; the Webview's window by default. */
  pageEvents?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Keeps the unsent composer (chat draft, its attachments and an open edit) in the Webview's own
 * persisted state, so a window reload (for example when another window needs the data directory
 * for a moment) does not lose what the user typed. The chat draft comes back when the composer is
 * created, unless something is already there or it is a Turn input still being sent; an open edit
 * comes back once its conversation is shown and its message loaded, and is given up when another
 * conversation is shown first or the message changed meanwhile. Clearing and giving up an edit are
 * written at once, and so is everything when the host asks (before a reload) or the page goes away.
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
  const giveUpTimer = pendingEdit ? setTimeout(dropPendingEdit, EDIT_RESTORE_TIMEOUT_MS) : undefined;

  // What the last write contained: clearing it (a send, a closed edit) is written at once.
  let written = { chat: saved !== undefined && hasChatContent(saved.chat), edit: false };
  let inFlight = false;

  if (saved) {
    const submitted = saved.chat.submitted;
    // Text equality is not ownership: a newer draft can have identical text but different files,
    // or be an explicit replacement. Older saved drafts without this marker are kept intact.
    inFlight = !!submitted
      && (options.pendingInputCommands?.() ?? []).some((command) =>
        command.commandId === submitted.commandId && command.conversationId === submitted.conversationId);
    if (!inFlight && ui.composerMode === 'chat' && !ui.chatDraft.trim() && attachments.value.chat.length === 0) {
      if (saved.chat.draft) ui.replaceChatDraft(saved.chat.draft);
      if (saved.chat.attachments.length) attachments.value = { ...attachments.value, chat: clone(saved.chat.attachments) };
    }
    if (saved.omittedAttachments) options.onAttachmentsOmitted?.(saved.omittedAttachments);
  }

  const stopRestore = watch(() => options.conversationId(), (conversationId) => {
    const edit = pendingEdit;
    if (!edit || !conversationId) return;
    if (conversationId !== edit.conversationId || ui.composerMode === 'edit') {
      dropPendingEdit();
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
      if (ui.composerMode === 'edit' || options.conversationId() !== edit.conversationId) {
        dropPendingEdit();
        return;
      }
      if (message.revisionId !== edit.revisionId) {
        // Editing the new revision with the old text would silently overwrite that change.
        dropPendingEdit();
        options.onEditDiscarded?.();
        return;
      }
      settlePendingEdit();
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
    options.submittedChatDraft?.(),
    attachments.value
  ], schedule, { deep: true });
  // Already sent before the reload (it is sent again): drop it from the saved draft right away.
  if (inFlight) flush();
  // The debounce must not cost the last keystrokes when the window reloads or the page goes away.
  const saveNow = (): void => flush();
  const stopSaveRequests = options.onSaveRequest?.(saveNow);
  const pageEvents = options.pageEvents ?? (typeof window === 'undefined' ? undefined : window);
  pageEvents?.addEventListener('pagehide', saveNow);

  function applyEdit(edit: EditSnapshot): void {
    const same = edit.kind === 'message'
      ? ui.editingMessage?.message.id === edit.messageId
      : ui.editingTurnIntent?.intentId === edit.intentId;
    if (ui.composerMode !== 'edit' || !same) return;
    ui.setComposerDraft(edit.draft);
    attachments.value = { ...attachments.value, edit: clone(edit.attachments) };
  }

  /**
   * The saved edit cannot be restored any more: written at once, so a reload before the next save
   * neither brings it back nor tells the user about it again.
   */
  function dropPendingEdit(): void {
    if (!pendingEdit) return;
    settlePendingEdit();
    flush();
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
    const chatCleared = written.chat && !ui.chatDraft && attachments.value.chat.length === 0;
    const editClosed = written.edit && ui.composerMode !== 'edit';
    // A reload right after a send (or a closed edit) must not bring the old text back.
    if (chatCleared || editClosed) {
      flush();
      return;
    }
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const next = snapshot();
    storage.write(next);
    written = { chat: next !== undefined && hasChatContent(next.chat), edit: ui.composerMode === 'edit' && next?.edit !== undefined };
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
    const submitted = options.submittedChatDraft?.();
    const chat = {
      draft: ui.chatDraft, attachments: keep(attachments.value.chat),
      ...(submitted ? { submitted } : {})
    };
    const conversationId = options.conversationId();
    let edit: EditSnapshot | undefined;
    if (ui.composerMode === 'edit' && conversationId && ui.editingMessage) {
      const { id: messageId, revisionId } = ui.editingMessage.message;
      edit = {
        kind: 'message', conversationId, messageId, ...(revisionId !== undefined ? { revisionId } : {}),
        deleteCount: ui.editingMessage.deleteCount, draft: ui.composerDraft, attachments: keep(attachments.value.edit)
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
      stopSaveRequests?.();
      pageEvents?.removeEventListener('pagehide', saveNow);
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
    && ((edit.kind === 'message' && typeof edit.messageId === 'string' && Number.isSafeInteger(edit.deleteCount)
      && (edit.revisionId === undefined || typeof edit.revisionId === 'string'))
      || (edit.kind === 'turnIntent' && typeof edit.intentId === 'string' && Number.isSafeInteger(edit.rowVersion)))
  );
  if (!validEdit) return undefined;
  return record as PersistedComposerDraft;
}

function hasChatContent(chat: PersistedComposerDraft['chat']): boolean {
  return chat.draft !== '' || chat.attachments.length > 0;
}

function isInlineDataPart(part: unknown): part is InlineDataPart {
  const inline = (part as InlineDataPart | undefined)?.inlineData;
  return !!inline && typeof inline === 'object' && typeof inline.mimeType === 'string';
}

function clone(parts: readonly InlineDataPart[]): InlineDataPart[] {
  return parts.map((part) => ({ ...part, inlineData: { ...part.inlineData } }));
}
