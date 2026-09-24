import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import Database from 'better-sqlite3';
import { RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import { storageKeyForDigest } from './contentAddressedStore';
import { assertCurrentSchema } from './databaseSchema';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { assertRuntimeHostsOffline, withRuntimeDataRootAdmission, withRuntimeMaintenance } from './runtimeHostControl';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import {
  assertNoSymbolicPath, createRuntimeDataSetDatabaseSnapshot, requireCompleteRuntimeDataSet,
  type RuntimeDataSetDatabaseSnapshot
} from './runtimeStorageInspection';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import { resolveVscodeRuntimeDataSet, type VscodeRuntimeDataSetCandidate } from './vscodeRootAuthority';

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
  readonly candidate: VscodeRuntimeDataSetCandidate;
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
 * Opens a command-scoped, read-only history snapshot, without RuntimeDatabase or a Host.
 * SQLite's readonly WAL connection can create source -wal/-shm files. Copy SQLite and its WAL
 * under admission/offline fencing, then open only that temporary copy. CAS stays on-demand.
 */
export async function openRuntimeDataSetHistory(
  paths: { globalStoragePath: string },
  candidateId: string
): Promise<RuntimeDataSetHistory> {
  return withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
    const candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
    if (candidate.selected) throw new Error('Use the active conversation view for the selected Runtime data set.');
    const historical = await requireCompleteRuntimeDataSet(candidate);
    if (historical.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
      throw Object.assign(new Error('此历史库仍使用旧 Runtime 格式。请在“历史与存储管理”中选择该库并重载窗口，完成备份和离线升级后再读取；原数据保持不变。'), {
        code: 'runtime-history-offline-upgrade-required'
      });
    }
    const binding = historical as RootBinding;
    return withRuntimeMaintenance(binding.paths, async () => {
      await assertRuntimeHostsOffline(binding.paths);
      let snapshot: RuntimeDataSetDatabaseSnapshot | undefined;
      try {
        snapshot = await createRuntimeDataSetDatabaseSnapshot(candidate, binding);
        const { database } = snapshot;
        assertCurrentSchema(database, binding);
        assertRuntimePhysicalSchemaFingerprint(database, RUNTIME_DOMAIN_SCHEMAS, { label: 'Historical Runtime' });
        return new ReadonlyRuntimeDataSetHistory(paths, candidate, binding, database, snapshot);
      } catch (error) {
        await snapshot?.close();
        if (error instanceof Error) {
          error.message = `无法读取历史库：${error.message} 未执行任何迁移或重置。`;
        }
        throw error;
      }
    });
  });
}

class ReadonlyRuntimeDataSetHistory implements RuntimeDataSetHistory {
  private closed = false;
  private readonly textCache = new Map<string, string>();

  public constructor(
    private readonly paths: { globalStoragePath: string },
    public readonly candidate: VscodeRuntimeDataSetCandidate,
    private readonly binding: RootBinding,
    private readonly database: Database.Database,
    private readonly snapshot: RuntimeDataSetDatabaseSnapshot
  ) {}

  public async listConversations(input: { limit?: number; after?: RuntimeHistoryConversationCursor } = {}) {
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
  }

  public async readMessages(conversationId: string, input: { limit?: number; after?: string } = {}) {
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
  }

  public async readMessageText(conversationId: string, messageId: string, input: { offset: number; limit?: number }) {
    await this.validateSource();
    const { metadata } = this.messageContent(conversationId, messageId);
    const page = textPage(await this.readText(metadata), input.offset, input.limit ?? TEXT_PAGE_CHARACTERS);
    await this.validateSource();
    return page;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.textCache.clear();
    await this.snapshot.close();
  }

  private async validateSource(): Promise<void> {
    if (this.closed) throw new Error('Runtime history reader is closed.');
    const candidate = await resolveVscodeRuntimeDataSet(this.paths, this.candidate.id);
    if (candidate.selected) throw new Error('Historical Runtime was selected for active use; reopen its active conversation view.');
    const current = await requireCompleteRuntimeDataSet(candidate);
    if (JSON.stringify(current) !== JSON.stringify(this.binding)) {
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
    const digest = text(metadata.sha256);
    const key = storageKeyForDigest(digest);
    if (metadata.storage_key !== key) throw new Error(`Historical ContentObject ${id} storage key does not match its digest.`);
    if (typeof metadata.byte_length !== 'bigint' || metadata.byte_length < 0n || metadata.byte_length > MAX_MESSAGE_CONTENT_BYTES) {
      throw new Error(`Historical ContentObject ${id} exceeds the 64 MiB message read limit or has an invalid length.`);
    }
    const filePath = path.join(this.binding.paths.casRootPath, ...key.split('/'));
    await assertNoSymbolicPath(this.candidate.configurationRootPath, filePath);
    const stat = await fs.lstat(filePath, { bigint: true });
    if (!stat.isFile() || stat.size !== metadata.byte_length) throw new Error(`Historical ContentObject ${id} byte length mismatch.`);
    const bytes = await fs.readFile(filePath);
    if (BigInt(bytes.length) !== metadata.byte_length || createHash('sha256').update(bytes).digest('hex') !== digest) {
      throw new Error(`Historical ContentObject ${id} digest or byte length mismatch.`);
    }
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
