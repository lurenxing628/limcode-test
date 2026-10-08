import { TextDecoder } from 'node:util';
import Database from 'better-sqlite3';
import { RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import { requireCasObjectIdentity } from './casObjectAccess';
import { assertCurrentSchema } from './databaseSchema';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import {
  copyLocatedRuntimeDatabase, heldDatabaseFiles, openLocatedCasAccess, relocateRuntimeRoot, withLocatedRuntimeRootFence,
  type HeldDatabaseFiles, type LocatedCasAccess
} from './runtimeForeignHistory';
import { registerRuntimeHistoryView, type RuntimeHistoryViewRegistration } from './runtimeForeignHistoryViews';
import { assertRuntimeHostsOffline, withRuntimeDataRootAdmission } from './runtimeHostControl';
import { sameLocatedRuntimeRoot, type LocatedRuntimeRoot } from './runtimeLocatedRoot';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import {
  createLocatedRuntimeDatabaseSnapshot, type RuntimeDataSetDatabaseSnapshot
} from './runtimeStorageInspection';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';

export { locateLocalRuntimeDataSet, type LocatedRuntimeRoot } from './runtimeLocatedRoot';

export interface RuntimeHistoryConversation {
  id: string; title: string; status: string; createdAt: string; updatedAt: string;
}
export interface RuntimeHistoryConversationCursor { updatedAt: string; id: string }
export interface RuntimeHistoryMessage {
  id: string; revisionId: string; role: string; createdAt: string; updatedAt: string;
  messageSeq: string; text: string; hasMoreText: boolean; nextTextOffset?: number;
}
export interface RuntimeHistoryTextPage { text: string; hasMore: boolean; nextOffset?: number }
export interface RuntimeDataSetHistory {
  readonly root: LocatedRuntimeRoot;
  listConversations(input?: { limit?: number; after?: RuntimeHistoryConversationCursor }): Promise<{
    items: RuntimeHistoryConversation[]; next?: RuntimeHistoryConversationCursor;
  }>;
  readMessages(conversationId: string, input?: { limit?: number; after?: string }): Promise<{
    items: RuntimeHistoryMessage[]; next?: string;
  }>;
  readMessageText(conversationId: string, messageId: string, input: { offset: number; limit?: number }): Promise<RuntimeHistoryTextPage>;
  close(): Promise<void>;
}

const MAX_PAGE_ROWS = 100;
const TEXT_PAGE_CHARACTERS = 32768;
const MAX_MESSAGE_CONTENT_BYTES = 64n * 1024n * 1024n;

/**
 * Opens a command-scoped, read-only history snapshot, without RuntimeDatabase or a Host, of a
 * located root: an unselected local data set (locateLocalRuntimeDataSet) or a verified foreign
 * history root (runtimeForeignHistory). SQLite's readonly WAL connection can create source
 * -wal/-shm files. Copy SQLite and its WAL from the located paths under the root's fence (local:
 * admission + maintenance; foreign: its claim under this configuration root, verified again inside
 * it) with its Hosts offline, then open only that temporary copy, fenced by the recorded binding.
 * The copy counts only when the files kept their state while it was taken, and no file copied or
 * read is a file of a database this process may hold (copyLocatedRuntimeDatabase). Packed CAS uses
 * a later private copy, and loose bodies stay on-demand descriptor reads. A recorded path is never read. A
 * source stays registered as viewed (runtimeForeignHistoryViews, written under its claim in the
 * current configuration root) until the reader is closed, so 清理备份 keeps it meanwhile.
 */
export async function openRuntimeDataSetHistory(
  paths: { globalStoragePath: string },
  root: LocatedRuntimeRoot
): Promise<RuntimeDataSetHistory> {
  let opened: RuntimeDataSetHistory | undefined;
  const open = async (): Promise<RuntimeDataSetHistory> => {
    const held = await heldByThisProcess(paths, root);
    const current = await relocateRuntimeRoot(paths, root, held);
    if (!sameLocatedRuntimeRoot(current, root)) {
      throw new Error('Historical Runtime identity changed; close and reopen the history reader.');
    }
    // A local data set is upgraded in place first; a published-format foreign root only in its private copy.
    if (current.origin.kind === 'local' && current.recorded.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
      throw Object.assign(new Error('此旧历史库尚未完成自动备份升级，暂时不能读取。请查看自动升级失败原因；原数据未被重置。'), {
        code: 'runtime-history-offline-upgrade-required'
      });
    }
    return withLocatedRuntimeRootFence(paths, current, async () => {
      // A foreign root's Host records are read only as regular files (runtimeForeignHistory), never
      // through the local liveness reader: verified again here, under its claim.
      if (current.origin.kind === 'local') await assertRuntimeHostsOffline(current.located);
      else if (!sameLocatedRuntimeRoot(await relocateRuntimeRoot(paths, current, held), current)) {
        throw new Error('Historical Runtime identity changed; close and reopen the history reader.');
      }
      const view = await registerRuntimeHistoryView(paths.globalStoragePath, current.id);
      let snapshot: RuntimeDataSetDatabaseSnapshot | undefined;
      let cas: LocatedCasAccess | undefined;
      try {
        snapshot = await createLocatedRuntimeDatabaseSnapshot(current, { copy: (located) => copyLocatedRuntimeDatabase(located, held) });
        const { database } = snapshot;
        const binding = snapshot.binding as RootBinding;
        assertCurrentSchema(database, binding);
        assertRuntimePhysicalSchemaFingerprint(database, RUNTIME_DOMAIN_SCHEMAS, { label: 'Historical Runtime' });
        // Metadata first: the later append-only CAS copy contains every packed body it references.
        cas = await openLocatedCasAccess(current, held, () => heldByThisProcess(paths, current));
        return opened = new ReadonlyRuntimeDataSetHistory(paths, current, binding, database, snapshot, cas, held, view);
      } catch (error) {
        try { await cas?.close(); }
        finally {
          try { await snapshot?.close(); }
          finally { await view.release().catch(() => undefined); }
        }
        if (error instanceof Error) {
          error.message = `无法读取历史库：${error.message} 未执行任何迁移或重置。`;
        }
        throw error;
      }
    });
  };
  // A foreign root is no data set of this configuration root: nothing registers Hosts on it here.
  try {
    return await (root.origin.kind === 'local' ? withRuntimeDataRootAdmission(paths.globalStoragePath, open) : open());
  } catch (error) {
    // A claim can fail to release after creating the reader; its snapshot and view still belong to us.
    await opened?.close().catch((closeError) => console.warn('[LimCode] Failed to close a history reader after opening failed.', closeError));
    throw error;
  }
}

/**
 * Files of the databases this process may hold SQLite locks on, which the reader never opens. A local
 * data set is copied under its own maintenance claim, so only its own database is left out.
 */
function heldByThisProcess(paths: { globalStoragePath: string }, root: LocatedRuntimeRoot): Promise<HeldDatabaseFiles> {
  return heldDatabaseFiles(paths.globalStoragePath, root.origin.kind === 'local' ? { except: root.located.databasePath } : {});
}

class ReadonlyRuntimeDataSetHistory implements RuntimeDataSetHistory {
  private closed = false;
  private closing = false;
  private closeOperation?: Promise<void>;
  private readonly reads = new Set<Promise<unknown>>();
  private readonly textCache = new Map<string, string>();

  public constructor(
    private readonly paths: { globalStoragePath: string },
    public readonly root: LocatedRuntimeRoot,
    private readonly binding: RootBinding,
    private readonly database: Database.Database,
    private readonly snapshot: RuntimeDataSetDatabaseSnapshot,
    private readonly cas: LocatedCasAccess,
    private held: HeldDatabaseFiles,
    private readonly view: RuntimeHistoryViewRegistration
  ) {}

  public async listConversations(input: { limit?: number; after?: RuntimeHistoryConversationCursor } = {}) {
    return this.read(async () => {
      await this.validateSource();
      const limit = pageLimit(input.limit);
      if (input.after) {
        text(input.after.updatedAt, 'Conversation cursor updatedAt');
        text(input.after.id, 'Conversation cursor id');
      }
      const rows = this.database.prepare(`SELECT * FROM conversation
        ${input.after ? 'WHERE updated_at < @updatedAt OR (updated_at = @updatedAt AND id < @id)' : ''}
        ORDER BY updated_at DESC, id DESC LIMIT @limit`).all({
        ...(input.after ?? {}), limit: limit + 1
      }) as DomainRow[];
      const items: RuntimeHistoryConversation[] = rows.slice(0, limit).map((raw) => {
        const row = DOMAIN_REPOSITORIES.codec('Conversation').decode(raw);
        return { id: text(row.id), title: text(row.title, 'Conversation.title', true), status: text(row.status),
          createdAt: text(row.created_at), updatedAt: text(row.updated_at) };
      });
      const last = items[items.length - 1];
      return { items, ...(rows.length > limit && last ? { next: { updatedAt: last.updatedAt, id: last.id } } : {}) };
    });
  }

  public async readMessages(conversationId: string, input: { limit?: number; after?: string } = {}) {
    return this.read(async () => {
      await this.validateSource();
      this.requireConversation(conversationId);
      const limit = pageLimit(input.limit);
      if (input.after !== undefined && !/^(0|[1-9][0-9]*)$/.test(input.after)) {
        throw new TypeError('Message cursor must be a non-negative decimal sequence.');
      }
      const rows = this.database.prepare(`SELECT membership.* FROM message_part_of_conversation membership
        LEFT JOIN message ON message.id = membership.message_id
        WHERE membership.conversation_id = @conversationId AND message.deleted_at IS NULL
        ${input.after !== undefined ? 'AND membership.message_seq > @after' : ''}
        ORDER BY membership.message_seq ASC LIMIT @limit`).all({
        conversationId, ...(input.after !== undefined ? { after: BigInt(input.after) } : {}), limit: limit + 1
      }) as DomainRow[];
      const items: RuntimeHistoryMessage[] = [];
      for (const raw of rows.slice(0, limit)) {
        const membership = DOMAIN_REPOSITORIES.codec('MessagePartOfConversation').decode(raw);
        const { message, revision, metadata } = this.messageContent(conversationId, text(membership.message_id));
        const content = await this.readText(metadata);
        const page = textPage(content, 0, TEXT_PAGE_CHARACTERS);
        items.push({
          id: text(message.id), revisionId: text(revision.id), role: text(revision.role),
          createdAt: text(message.created_at), updatedAt: text(message.updated_at),
          messageSeq: sequence(membership.message_seq), text: page.text, hasMoreText: page.hasMore,
          ...(page.nextOffset !== undefined ? { nextTextOffset: page.nextOffset } : {})
        });
      }
      await this.validateSource();
      return { items, ...(rows.length > limit && items.length ? { next: items[items.length - 1].messageSeq } : {}) };
    });
  }

  public async readMessageText(conversationId: string, messageId: string, input: { offset: number; limit?: number }) {
    return this.read(async () => {
      await this.validateSource();
      const { metadata } = this.messageContent(conversationId, messageId);
      const page = textPage(await this.readText(metadata), input.offset, input.limit ?? TEXT_PAGE_CHARACTERS);
      await this.validateSource();
      return page;
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    if (this.closeOperation) return this.closeOperation;
    this.closing = true;
    this.closeOperation = (async () => {
      await Promise.allSettled(this.reads);
      this.textCache.clear();
      try { await this.cas.close(); }
      finally {
        try { await this.snapshot.close(); }
        finally { await this.view.release(); }
      }
      this.closed = true;
    })().catch((error) => { this.closeOperation = undefined; throw error; });
    return this.closeOperation;
  }

  private read<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing) throw new Error('Runtime history reader is closed.');
    const read = operation();
    this.reads.add(read);
    return read.finally(() => { this.reads.delete(read); });
  }

  private async validateSource(): Promise<void> {
    if (this.closed || this.closing) throw new Error('Runtime history reader is closed.');
    this.held = await heldByThisProcess(this.paths, this.root);
    const current = await relocateRuntimeRoot(this.paths, this.root, this.held);
    if (!sameLocatedRuntimeRoot(current, this.root)) {
      throw new Error('Historical Runtime identity changed; close and reopen the history reader.');
    }
  }

  private requireConversation(id: string): DomainRow {
    return this.requireRow('Conversation', 'conversation', text(id, 'conversationId'));
  }

  private requireRow(domain: string, table: string, id: string): DomainRow {
    // Table names are fixed private call-site constants; values always remain bound parameters.
    const raw = this.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as DomainRow | undefined;
    if (!raw) throw new Error(`Historical ${domain} ${id} is missing.`);
    return DOMAIN_REPOSITORIES.codec(domain).decode(raw);
  }

  private messageContent(conversationId: string, messageId: string) {
    this.requireConversation(conversationId);
    text(messageId, 'messageId');
    const membership = this.database.prepare(`SELECT * FROM message_part_of_conversation
      WHERE conversation_id = ? AND message_id = ?`).get(conversationId, messageId);
    if (!membership) throw new Error('Historical message does not belong to the requested conversation.');
    const message = this.requireRow('Message', 'message', messageId);
    if (message.deleted_at !== null) throw new Error('Historical message is deleted.');
    const current = this.database.prepare('SELECT * FROM message_current_revision_link WHERE message_id = ?').get(messageId) as DomainRow | undefined;
    if (!current) throw new Error(`Historical Message ${messageId} has no current revision link.`);
    const link = DOMAIN_REPOSITORIES.codec('MessageCurrentRevisionLink').decode(current);
    const revision = this.requireRow('MessageRevision', 'message_revision', text(link.revision_id));
    if (revision.message_id !== messageId) throw new Error('Historical current revision belongs to another message.');
    const metadata = this.requireRow('ContentObject', 'content_object', text(revision.content_object_id));
    return { message, revision, metadata };
  }

  private async readText(metadata: DomainRow): Promise<string> {
    const id = text(metadata.id);
    const cached = this.textCache.get(id);
    if (cached !== undefined) return cached;
    const object = requireCasObjectIdentity(metadata);
    if (typeof metadata.byte_length !== 'bigint' || metadata.byte_length < 0n || metadata.byte_length > MAX_MESSAGE_CONTENT_BYTES) {
      throw new Error(`Historical ContentObject ${id} exceeds the 64 MiB message read limit or has an invalid length.`);
    }
    const bytes = await this.cas.readBytes(object);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const decoded = decodeHistoryText(source, text(metadata.content_type));
    this.textCache.set(id, decoded);
    // Retain a single larger message for its continuation pages, with a hard 64 MiB source bound.
    while (this.textCache.size > 1 && (this.textCache.size > 8
      || [...this.textCache.values()].reduce((size, value) => size + value.length, 0) > 4 * 1024 * 1024)) {
      this.textCache.delete(this.textCache.keys().next().value!);
    }
    return decoded;
  }
}

/** Current canonical MessageContent parts, displayed as text only; never render stored HTML. */
function decodeHistoryText(source: string, contentType: string): string {
  if (contentType.split(';', 1)[0].trim().toLowerCase() === 'text/plain') return source;
  if (contentType === 'application/vnd.limcode.tool-model-result+json') {
    const parsed: unknown = JSON.parse(source);
    if (!isRecord(parsed) || !('detail' in parsed)) {
      throw new Error('Historical ToolModelResult does not match the current canonical codec.');
    }
    text(parsed.toolCallId, 'Historical ToolModelResult.toolCallId');
    return `\n[工具结果 ${text(parsed.status, 'Historical ToolModelResult.status')}]\n${JSON.stringify(parsed.detail)}\n`;
  }
  if (contentType !== 'application/vnd.limcode.message+json') {
    throw new Error(`Unsupported historical message content type: ${contentType}`);
  }
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed) || !['user', 'model'].includes(String(parsed.role)) || !Array.isArray(parsed.parts)) {
    throw new Error('Historical MessageContent does not match the current canonical codec.');
  }
  return parsed.parts.map((part: unknown) => {
    if (!isRecord(part)) throw new Error('Historical MessageContent part must be an object.');
    if (typeof part.text === 'string') return part.thought === true ? `\n[思考]\n${part.text}\n` : part.text;
    if (isRecord(part.functionCall)) return `\n[工具调用 ${text(part.functionCall.name)}]\n${JSON.stringify(part.functionCall.args)}\n`;
    if (isRecord(part.functionResponse)) return `\n[工具结果 ${text(part.functionResponse.name)}]\n${JSON.stringify(part.functionResponse.response)}\n`;
    if (isRecord(part.inlineData)) return `\n[附件 ${typeof part.inlineData.name === 'string' ? part.inlineData.name : text(part.inlineData.mimeType)}]\n`;
    if (isRecord(part.fileData)) return `\n[文件 ${text(part.fileData.uri)}]\n`;
    if (isRecord(part.providerContext)) return '\n[模型原生上下文，非文本内容]\n';
    throw new Error('Historical MessageContent contains an unsupported part.');
  }).join('');
}

function textPage(value: string, offset: number, limit: number): RuntimeHistoryTextPage {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) throw new RangeError('Historical text offset is invalid.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TEXT_PAGE_CHARACTERS) throw new RangeError('Historical text page limit is invalid.');
  let end = Math.min(value.length, offset + limit);
  if (end < value.length && end > offset && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
  // A one-character page cannot split a Unicode surrogate pair or make zero progress.
  if (end === offset && end < value.length) end = Math.min(value.length, end + 2);
  return { text: value.slice(offset, end), hasMore: end < value.length, ...(end < value.length ? { nextOffset: end } : {}) };
}
function pageLimit(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_ROWS) throw new RangeError('Historical page limit must be from 1 to 100.');
  return value;
}
function text(value: unknown, label = 'Historical row field', allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new TypeError(`${label} must be text.`);
  return value;
}
function sequence(value: unknown): string {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError('Historical message sequence is invalid.');
  return value.toString();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
