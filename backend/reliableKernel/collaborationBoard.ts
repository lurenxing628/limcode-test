import { createHash } from 'node:crypto';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { readCollaborationScope } from './collaborationScope';
import { DOMAIN_REPOSITORIES, savepoint, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

const PREFIX = 'CollaborationBoard';
const MAX_CHANNELS = 128;
const MAX_SCAN = 100;
const MAX_TEXT_CHARS = 100_000;
const READ_OPERATIONS = new Set(['list_channels', 'list_threads', 'read_thread', 'read_post', 'search']);
const OPERATIONS = new Set([...READ_OPERATIONS, 'create_channel', 'subscribe', 'unsubscribe', 'post']);
type Source = { kind: 'tool' | 'user'; conversationId: string; key: string; turnId?: string; toolCallId?: string };
export interface CollaborationBoardNotice {
  postId: string;
  channelId: string;
  threadId: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceTurnId?: string;
  sourceToolCallId?: string;
  sourceKind: 'tool' | 'user';
}
export interface CollaborationBoardNotificationResult {
  status: 'delivered' | 'skipped_idle' | 'failed';
  reason?: string;
}
export interface CollaborationBoardOptions {
  now?: () => string;
  /** Must atomically deliver to an existing running turn; never enqueue an idle backlog or start a turn. */
  notify?: (notice: CollaborationBoardNotice) => Promise<CollaborationBoardNotificationResult>;
}
export type CollaborationBoardArguments = {
  operation: string;
  channelId?: string;
  threadId?: string;
  postId?: string;
  name?: string;
  text?: string;
  query?: string;
  subscribe?: boolean;
  limit?: number;
  cursor?: string;
  offsetChars?: number;
  limitChars?: number;
  notifyConversationIds?: string[];
};
type BoardScope = Awaited<ReturnType<typeof readCollaborationScope>>;
type SourceAuthority = { scope: BoardScope; steps: RepositoryTransactionStep[] };

/** Persistent shared discussion. Posts are untrusted peer data, never user authorization. */
export class CollaborationBoard {
  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly options: CollaborationBoardOptions = {}
  ) {}

  public execute(source: { conversationId: string; turnId: string; toolCallId: string }, args: CollaborationBoardArguments): Promise<Record<string, unknown>> {
    return this.run({ kind: 'tool', conversationId: source.conversationId, turnId: source.turnId, toolCallId: source.toolCallId, key: source.toolCallId }, args);
  }

  /** Host/UI entry point: its own command identity, without inventing a model ToolCall. */
  public executeUser(source: { conversationId: string; commandId: string }, args: CollaborationBoardArguments): Promise<Record<string, unknown>> {
    return this.run({ kind: 'user', conversationId: source.conversationId, key: source.commandId }, args);
  }

  private async run(source: Source, args: CollaborationBoardArguments, contentionRetries = 0): Promise<Record<string, unknown>> {
    required(source.conversationId, 'conversationId'); required(source.key, 'source key');
    if (!args || !OPERATIONS.has(args.operation)) throw new Error('Unknown agent_board operation.');
    validateArguments(args);
    const authority = await this.authorize(source);
    if (READ_OPERATIONS.has(args.operation)) return { operation: args.operation, ...await this.read(source, args, authority.scope) };
    const digest = hash(canonical({ source, args }));
    const receiptId = identity('receipt', source.kind, source.key);
    const prior = await this.get('CommandReceipt', receiptId);
    if (prior) return this.replay(prior, digest);
    const now = this.options.now?.() ?? new Date().toISOString();
    const steps: RepositoryTransactionStep[] = [...authority.steps];
    let result: Record<string, unknown>;
    let notify: CollaborationBoardNotice[] = [];
    if (args.operation === 'create_channel') {
      const name = required(args.name, 'name').normalize('NFKC').toLowerCase();
      if (Array.from(name).length > 80) throw new Error('Channel name is limited to 80 characters.');
      if (args.subscribe !== undefined && typeof args.subscribe !== 'boolean') throw new TypeError('subscribe must be boolean.');
      const channelId = identity('channel', authority.scope.rootConversationId, name);
      const existing = await this.get('Channel', channelId);
      if (!existing) {
        const scopeLinks = await this.rows('ChannelScopeLink', { root_conversation_id: authority.scope.rootConversationId }, MAX_CHANNELS + 1);
        if (scopeLinks.length >= MAX_CHANNELS) throw new Error(`A board supports at most ${MAX_CHANNELS} channels.`);
        // Fence the observed channel set so concurrent creation cannot exceed the board bound.
        steps.push(repo('ChannelScopeLink').assertExactIds(
          { root_conversation_id: authority.scope.rootConversationId }, scopeLinks.map(link => String(link.id))));
      }
      const channel = existing ?? { id: channelId, name, created_at: now };
      if (existing) await this.channel(authority.scope, channelId);
      else steps.push(savepoint('board_channel', [
        repo('Channel').insert(channel),
        repo('ChannelScopeLink').insert({ id: identity('scope', channelId), channel_id: channelId, root_conversation_id: authority.scope.rootConversationId, created_at: now })
      ], { kind: 'rollback-and-continue-on-unique', constraints: [{ domain: `${PREFIX}Channel`, columns: ['id'] }] }),
      repo('Channel').assert(channelId, { name }),
      repo('ChannelScopeLink').assert(identity('scope', channelId), { channel_id: channelId, root_conversation_id: authority.scope.rootConversationId }));
      const subscribed = args.subscribe !== false;
      if (subscribed) await this.subscription(steps, source.conversationId, { channelId }, true, now);
      result = { channel: channelRecord(channel), subscribed };
    } else if (args.operation === 'subscribe' || args.operation === 'unsubscribe') {
      const target = await this.subscriptionTarget(authority.scope, args);
      const subscribed = args.operation === 'subscribe';
      await this.subscription(steps, source.conversationId, target, subscribed, now);
      result = { ...target, subscribed };
    } else {
      const text = required(args.text, 'text', false);
      const characterCount = Array.from(text).length;
      if (characterCount > MAX_TEXT_CHARS) throw new Error(`Post text is limited to ${MAX_TEXT_CHARS} characters.`);
      const target = await this.subscriptionTarget(authority.scope, args);
      const root = target.threadId ? await this.post(authority.scope, target.threadId) : undefined;
      const channelId = target.channelId ?? required(root?.channelId, 'thread channel');
      const postId = identity('post', source.kind, source.key);
      const threadId = target.threadId ?? postId;
      const explicit = args.notifyConversationIds ?? [];
      if (!Array.isArray(explicit) || explicit.length > 256 || explicit.some(id => typeof id !== 'string')) throw new Error('notifyConversationIds must be at most 256 conversation ids.');
      const members = new Set(authority.scope.members.map(member => member.conversationId));
      for (const id of explicit) if (!members.has(id)) throw new Error('Board notification target is outside this task tree.');
      const content = await this.contentStore.prepare(this.database, text, 'text/plain');
      steps.push(...preparedContentObjectSteps([content], 'board_post'),
        repo('Post').insert({ id: postId, content_object_id: content.metadata.id, character_count: BigInt(characterCount), created_at: now }),
        repo('PostChannelLink').insert({ id: orderedIdentity('post_channel', now, postId), post_id: postId, channel_id: channelId, created_at: now }),
        repo('PostSourceLink').insert({ id: identity('post_source', postId), post_id: postId, source_kind: source.kind, source_key: source.key, conversation_id: source.conversationId, source_turn_id: source.turnId ?? null, source_tool_call_id: source.toolCallId ?? null, created_at: now }));
      if (target.threadId) steps.push(repo('ReplyLink').insert({ id: orderedIdentity('reply', now, postId), post_id: postId, thread_id: threadId, created_at: now }));
      await this.subscription(steps, source.conversationId, { threadId }, true, now);
      const subscribers = await this.rows('SubscriptionLink', target.threadId ? { thread_id: threadId, active: 1n } : { channel_id: channelId, active: 1n }, 257);
      if (subscribers.length > 256) throw new Error('Board subscriber bound exceeded.');
      const targets = new Set([...explicit, ...subscribers.map(row => String(row.conversation_id))]);
      targets.delete(source.conversationId);
      notify = [...targets].filter(id => members.has(id)).map(targetConversationId => ({
        postId, threadId, channelId, sourceConversationId: source.conversationId, targetConversationId,
        sourceKind: source.kind, ...(source.turnId ? { sourceTurnId: source.turnId } : {}), ...(source.toolCallId ? { sourceToolCallId: source.toolCallId } : {})
      }));
      result = { postId, threadId, channelId };
    }
    const savedResult = await this.contentStore.prepare(this.database, JSON.stringify(result), 'application/json');
    steps.push(...preparedContentObjectSteps([savedResult], 'board_result'), repo('CommandReceipt').insert({
      id: receiptId, source_kind: source.kind, source_key: source.key, conversation_id: source.conversationId, source_tool_call_id: source.toolCallId ?? null,
      operation: args.operation, request_digest: digest, result_object_id: savedResult.metadata.id, created_at: now
    }));
    try { await this.database.transaction(steps); }
    catch (error) {
      const concurrent = await this.get('CommandReceipt', receiptId);
      if (concurrent) return this.replay(concurrent, digest);
      if (args.operation === 'create_channel' && contentionRetries < 2 && error instanceof Error
        && (error as Error & { code?: string }).code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED'
        && error.message === 'CollaborationBoardChannelScopeLinkRepository transaction assertExactIds failed.') {
        return this.run(source, args, contentionRetries + 1);
      }
      throw error;
    }
    if (args.operation === 'post') {
      const notifications = [];
      for (const notice of notify) notifications.push({ targetConversationId: notice.targetConversationId, ...await this.deliverNotice(notice) });
      return { ...result, notifications, deduplicated: false };
    }
    return { ...await this.materializeResult(result), deduplicated: false };
  }

  private async authorize(source: Source): Promise<SourceAuthority> {
    const conversation = await this.rawGet('Conversation', source.conversationId);
    if (!conversation || conversation.status === 'deleted') throw new Error('Board conversation is unavailable.');
    const scope = await readCollaborationScope(this.database, source.conversationId);
    const steps = [...scope.authoritySteps, DOMAIN_REPOSITORIES.domain('Conversation').assert(source.conversationId, { status: conversation.status })];
    if (source.kind === 'tool') {
      const turnId = required(source.turnId, 'turnId');
      const toolCallId = required(source.toolCallId, 'toolCallId');
      const [turn, call] = await Promise.all([this.rawGet('Turn', turnId), this.rawGet('ToolCall', toolCallId)]);
      if (!turn || turn.conversation_id !== source.conversationId || turn.status !== 'active') throw new Error('Board source Turn is not active in this conversation.');
      if (!call || call.turn_id !== turnId || call.tool_name !== 'agent_board') throw new Error('Board source ToolCall identity does not match.');
      steps.push(DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { conversation_id: source.conversationId, status: 'active' }),
        DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: turnId }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { turn_id: turnId, tool_name: 'agent_board' }));
    }
    return { scope, steps };
  }

  private async read(source: Source, args: CollaborationBoardArguments, scope: BoardScope): Promise<Record<string, unknown>> {
    const limit = Math.min(integer(args.limit, 20, 1, 100, 'limit'), 20);
    if (args.operation === 'read_post') {
      const post = await this.post(scope, required(args.postId, 'postId'));
      const text = Array.from(await this.content(String(post.row.content_object_id)));
      const offsetChars = integer(args.offsetChars, 0, 0, MAX_TEXT_CHARS, 'offsetChars');
      const limitChars = integer(args.limitChars, 12000, 1, 20000, 'limitChars');
      const end = Math.min(text.length, offsetChars + limitChars);
      return { post: await this.postRecord(post), text: text.slice(offsetChars, end).join(''), offsetChars,
        characterCount: text.length, ...(end < text.length ? { nextOffsetChars: end } : {}) };
    }
    const query = typeof args.query === 'string' ? args.query.toLocaleLowerCase() : '';
    if (query.length > 256) throw new Error('Board search query is limited to 256 characters.');
    const queryKey = hash(canonical({ root: scope.rootConversationId, operation: args.operation, channelId: args.channelId, threadId: args.threadId, query }));
    const cursor = parseCursor(args.cursor, queryKey);
    if (args.operation === 'list_channels') {
      const channels = (await this.channels(scope)).filter(row => String(row.name).includes(query));
      const start = cursor.position;
      const slice = channels.slice(start, start + limit);
      const output = [];
      for (const row of slice) {
        const subscription = await this.get('SubscriptionLink', identity('subscription', source.conversationId, 'channel', String(row.id)));
        output.push({ ...channelRecord(row), subscribed: subscription?.active === 1n });
      }
      return { channels: output, rereadCursor: args.cursor ?? encodeCursor(queryKey, 0), ...(start + slice.length < channels.length ? { nextCursor: encodeCursor(queryKey, start + slice.length) } : {}) };
    }
    if (args.operation === 'read_thread') {
      const root = await this.post(scope, required(args.threadId, 'threadId'));
      if (root.threadId !== root.row.id) throw new Error('threadId must identify a discussion root.');
      const links = await this.rows('ReplyLink', { thread_id: root.row.id }, limit + 1, cursor.afterId);
      const replies = [];
      for (const link of links.slice(0, limit)) replies.push(await this.postRecord(await this.post(scope, String(link.post_id))));
      const subscribed = (await this.get('SubscriptionLink', identity('subscription', source.conversationId, 'thread', String(root.row.id))))?.active === 1n;
      return { root: await this.postRecord(root), replies, subscribed, rereadCursor: args.cursor ?? encodeCursor(queryKey, 0), ...(links.length > limit ? { nextCursor: encodeCursor(queryKey, 0, String(links[limit - 1].id)) } : {}) };
    }
    const channels = args.channelId ? [await this.channel(scope, args.channelId)] : await this.channels(scope);
    if (args.operation === 'list_threads' && !args.channelId) throw new Error('list_threads requires channelId.');
    const posts: Record<string, unknown>[] = [];
    let position = cursor.position; let afterId = cursor.afterId; let scanned = 0;
    while (position < channels.length && posts.length < limit && scanned < MAX_SCAN) {
      const remaining = Math.min(MAX_SCAN - scanned, limit - posts.length);
      const links = await this.rows('PostChannelLink', { channel_id: channels[position].id }, remaining + 1, afterId);
      const scan = links.slice(0, remaining);
      for (const link of scan) {
        afterId = String(link.id); scanned += 1;
        const post = await this.post(scope, String(link.post_id));
        if (args.operation === 'list_threads' && post.threadId !== post.row.id) continue;
        const text = await this.content(String(post.row.content_object_id));
        if (query && !text.toLocaleLowerCase().includes(query)) continue;
        posts.push(await this.postRecord(post, text));
      }
      if (links.length <= remaining) { position += 1; afterId = undefined; }
    }
    return { posts, scanned, rereadCursor: args.cursor ?? encodeCursor(queryKey, 0), ...(position < channels.length ? { nextCursor: encodeCursor(queryKey, position, afterId) } : {}) };
  }

  private async replay(receipt: DomainRow, digest: string): Promise<Record<string, unknown>> {
    if (receipt.request_digest !== digest) throw new Error('Board command identity was reused with different arguments.');
    const result = JSON.parse(await this.content(String(receipt.result_object_id))) as Record<string, unknown>;
    // Notifications are ephemeral running-turn notices: replay never creates a delayed backlog.
    return { ...await this.materializeResult(result), deduplicated: true, ...(receipt.operation === 'post' ? { notifications: [], notificationReplay: 'not_replayed' } : {}) };
  }

  private async materializeResult(result: Record<string, unknown>): Promise<Record<string, unknown>> {
    const original = result.channel as { id?: unknown } | undefined;
    if (original && typeof original.id === 'string') {
      const channel = await this.get('Channel', original.id);
      if (!channel) throw new Error('Previously created board channel is no longer available.');
      return { ...result, channel: channelRecord(channel) };
    }
    return result;
  }

  private async deliverNotice(notice: CollaborationBoardNotice): Promise<CollaborationBoardNotificationResult> {
    try {
      const turns = (await this.database.snapshot([DOMAIN_REPOSITORIES.domain('Turn').list({ where: { conversation_id: notice.targetConversationId, status: 'active' }, limit: 2 })])).snapshot[0] as DomainRow[];
      if (turns.length !== 1) return { status: 'skipped_idle' };
      if (!this.options.notify) return { status: 'failed', reason: 'Board notification adapter is unavailable; post remains readable.' };
      const result = await this.options.notify(notice);
      if (!result || !['delivered', 'skipped_idle', 'failed'].includes(result.status)) return { status: 'failed', reason: 'Board notification adapter returned an invalid outcome.' };
      return result;
    } catch { return { status: 'failed', reason: 'Board notice could not be delivered; post remains readable.' }; }
  }

  private async subscriptionTarget(scope: BoardScope, args: CollaborationBoardArguments): Promise<{ channelId?: string; threadId?: string }> {
    if (Boolean(args.channelId) === Boolean(args.threadId)) throw new Error('Specify exactly one channelId or threadId.');
    if (args.channelId) { await this.channel(scope, required(args.channelId, 'channelId')); return { channelId: args.channelId }; }
    const post = await this.post(scope, required(args.threadId, 'threadId'));
    if (post.threadId !== post.row.id) throw new Error('threadId must identify a discussion root.');
    return { threadId: args.threadId };
  }

  private async subscription(steps: RepositoryTransactionStep[], conversationId: string, target: { channelId?: string; threadId?: string }, active: boolean, now: string): Promise<void> {
    const id = identity('subscription', conversationId, target.channelId ? 'channel' : 'thread', target.channelId ?? required(target.threadId, 'threadId'));
    const existing = await this.get('SubscriptionLink', id);
    if (existing) steps.push(repo('SubscriptionLink').update(id, { active: active ? 1n : 0n, updated_at: now }));
    else steps.push(savepoint('board_subscription', [repo('SubscriptionLink').insert({ id, conversation_id: conversationId,
      channel_id: target.channelId ?? null, thread_id: target.threadId ?? null, active: active ? 1n : 0n, created_at: now, updated_at: now })], {
      kind: 'rollback-and-continue-on-unique', constraints: [{ domain: `${PREFIX}SubscriptionLink`, columns: ['id'] }]
    }), repo('SubscriptionLink').update(id, { active: active ? 1n : 0n, updated_at: now }));
  }

  private async channels(scope: BoardScope): Promise<DomainRow[]> {
    const links = await this.rows('ChannelScopeLink', { root_conversation_id: scope.rootConversationId }, MAX_CHANNELS + 1);
    if (links.length > MAX_CHANNELS) throw new Error('Board channel bound exceeded.');
    const channels: DomainRow[] = [];
    for (const link of links) channels.push(await this.channel(scope, String(link.channel_id)));
    return channels.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  }

  private async channel(scope: BoardScope, channelId: string): Promise<DomainRow> {
    const [channel, link] = await Promise.all([this.get('Channel', channelId), this.get('ChannelScopeLink', identity('scope', channelId))]);
    if (!channel || !link || link.channel_id !== channelId || link.root_conversation_id !== scope.rootConversationId) throw new Error('Board channel is unavailable in this task tree.');
    return channel;
  }

  private async post(scope: BoardScope, postId: string): Promise<{ row: DomainRow; channelId: string; threadId: string; source: DomainRow }> {
    const [row, links, replies, source] = await Promise.all([this.get('Post', postId), this.rows('PostChannelLink', { post_id: postId }, 2), this.rows('ReplyLink', { post_id: postId }, 2), this.get('PostSourceLink', identity('post_source', postId))]);
    if (links.length !== 1 || replies.length > 1) throw new Error('Board post relationship is invalid.');
    const [link] = links; const [reply] = replies;
    if (!row || !link || !source || source.post_id !== postId || link.post_id !== postId) throw new Error('Board post is unavailable.');
    await this.channel(scope, String(link.channel_id));
    return { row, channelId: String(link.channel_id), threadId: String(reply?.thread_id ?? postId), source };
  }

  private async postRecord(post: Awaited<ReturnType<CollaborationBoard['post']>>, text?: string): Promise<Record<string, unknown>> {
    const body = text ?? await this.content(String(post.row.content_object_id));
    return { id: post.row.id, postId: post.row.id, channelId: post.channelId, threadId: post.threadId, authorConversationId: post.source.conversation_id,
      authorKind: post.source.source_kind, createdAt: Date.parse(String(post.row.created_at)), preview: Array.from(body).slice(0, 1000).join(''), characterCount: Number(post.row.character_count) };
  }

  private async content(id: string): Promise<string> {
    const metadata = await this.rawGet('ContentObject', id);
    if (!metadata) throw new Error('Board content object is unavailable.');
    return (await this.contentStore.read(metadata as ContentObjectMetadata)).toString('utf8');
  }
  private get(domain: string, id: string): Promise<DomainRow | undefined> { return this.rawGet(`${PREFIX}${domain}`, id); }
  private async rawGet(domain: string, id: string): Promise<DomainRow | undefined> {
    return ((await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0] as DomainRow | null) ?? undefined;
  }
  private async rows(domain: string, where: DomainRow, limit: number, afterId?: string): Promise<DomainRow[]> {
    return (await this.database.snapshot([repo(domain).list({ where, limit, orderBy: { column: 'id', direction: 'asc' }, ...(afterId ? { afterId } : {}) })])).snapshot[0] as DomainRow[];
  }
}

function repo(name: string) { return DOMAIN_REPOSITORIES.domain(`${PREFIX}${name}`); }
function required(value: unknown, label: string, trim = true): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty text.`);
  return trim ? value.trim() : value;
}
function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function identity(kind: string, ...values: string[]): string { return `board_${kind}_${hash(JSON.stringify(values)).slice(0, 32)}`; }
function orderedIdentity(kind: string, createdAt: string, postId: string): string {
  return `board_${kind}_${createdAt}_${hash(postId).slice(0, 32)}`;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function channelRecord(row: DomainRow) { return { id: row.id, channelId: row.id, name: row.name, createdAt: Date.parse(String(row.created_at)) }; }
function encodeCursor(key: string, position: number, afterId?: string): string {
  return Buffer.from(JSON.stringify({ key, position, ...(afterId ? { afterId } : {}) })).toString('base64url');
}
function parseCursor(value: unknown, key: string): { position: number; afterId?: string } {
  if (value === undefined) return { position: 0 };
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid board cursor.');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new Error('Invalid board cursor.'); }
  const cursor = parsed as { key?: unknown; position?: unknown; afterId?: unknown };
  if (!cursor || cursor.key !== key || !Number.isSafeInteger(cursor.position) || Number(cursor.position) < 0 || Number(cursor.position) > MAX_CHANNELS || (cursor.afterId !== undefined && typeof cursor.afterId !== 'string')) throw new Error('Board cursor does not match this query.');
  return { position: Number(cursor.position), ...(typeof cursor.afterId === 'string' ? { afterId: cursor.afterId } : {}) };
}

function validateArguments(args: CollaborationBoardArguments): void {
  const fields: Record<string, readonly string[]> = {
    create_channel: ['name', 'subscribe'],
    list_channels: ['query', 'limit', 'cursor'],
    list_threads: ['channelId', 'limit', 'cursor'],
    read_thread: ['threadId', 'limit', 'cursor'],
    read_post: ['postId', 'offsetChars', 'limitChars'],
    search: ['channelId', 'query', 'limit', 'cursor'],
    subscribe: ['channelId', 'threadId'],
    unsubscribe: ['channelId', 'threadId'],
    post: ['channelId', 'threadId', 'text', 'notifyConversationIds']
  };
  for (const key of Object.keys(args)) {
    if (key !== 'operation' && !fields[args.operation].includes(key)) throw new Error(`Unexpected agent_board argument for ${args.operation}: ${key}.`);
  }
  for (const key of ['channelId', 'threadId', 'postId', 'name', 'text', 'query', 'cursor'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'string') throw new TypeError(`${key} must be text.`);
  }
}
