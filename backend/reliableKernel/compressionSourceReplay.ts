import type { FullProviderContextItem } from './modelProviderControlPlane';
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import type { RuntimeDatabase } from './runtimeDatabase';
import { selectConversationCompressionBlock } from './compressionBlockOwnership';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';

const MAX_REPLAY_SEGMENTS = 32768;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_DEPTH = 64;

/** Hard caps of one source reconstruction; exceeding one is a size limit, not broken provenance. */
export const COMPRESSION_SOURCE_REPLAY_LIMITS = Object.freeze({
  segments: MAX_REPLAY_SEGMENTS,
  bytes: MAX_REPLAY_BYTES,
  depth: MAX_REPLAY_DEPTH
});
export type CompressionSourceReplayLimit = keyof typeof COMPRESSION_SOURCE_REPLAY_LIMITS;
export const COMPRESSION_SOURCE_REPLAY_LIMIT_CODE = 'MODEL_CONTEXT_REPLAY_LIMIT';

export function compressionSourceReplayLimitOf(error: unknown): CompressionSourceReplayLimit | undefined {
  const record = error && typeof error === 'object' ? error as { code?: unknown; limit?: unknown } : undefined;
  return record?.code === COMPRESSION_SOURCE_REPLAY_LIMIT_CODE
    && typeof record.limit === 'string' && record.limit in COMPRESSION_SOURCE_REPLAY_LIMITS
    ? record.limit as CompressionSourceReplayLimit
    : undefined;
}

/** Text-summary fallbacks cannot summarize an encrypted or signed native state as if it were text.
 * Normally only those states are expanded through immutable CompressionBlockSource provenance.
 * Explicit manual reconstruction expands text summaries too, discarding their possibly incorrect
 * aliases instead of guessing replacements. This read never mutates history; missing/cyclic
 * provenance fails closed rather than producing a successful but empty replacement summary.
 * Shared summary segments are expanded through the block owned by the requesting Conversation. */
export async function expandTextCompressionSources(
  database: RuntimeDatabase,
  store: ContentAddressedStore,
  conversationId: string,
  input: readonly FullProviderContextItem[],
  options: { sourceReplay?: 'immutable_provenance' } = {}
): Promise<FullProviderContextItem[]> {
  const shouldExpand = (item: FullProviderContextItem) => options.sourceReplay === 'immutable_provenance'
    ? item.segmentKind === 'compression'
    : isNativeState(item);
  if (!input.some(shouldExpand)) return [...input];
  const output: FullProviderContextItem[] = [];
  const cache = new Map<string, FullProviderContextItem>();
  let visits = 0;
  let bytes = 0;
  const stack = input.slice().reverse().map((item) => ({ item, ancestors: [] as string[] }));
  while (stack.length) {
    const { item, ancestors } = stack.pop()!;
    if (++visits > MAX_REPLAY_SEGMENTS) throw limited('segments', '压缩来源超过重建数量上限。');
    bytes += Buffer.byteLength(item.content, 'utf8');
    if (bytes > MAX_REPLAY_BYTES) throw limited('bytes', '压缩来源超过重建字节上限。');
    if (!shouldExpand(item)) { output.push(item); continue; }
    if (ancestors.includes(item.segmentId)) throw invalid('原生压缩来源存在循环。');
    if (ancestors.length >= MAX_REPLAY_DEPTH) throw limited('depth', '压缩来源超过重建深度上限。');
    const sources = rows((await database.snapshotAll(DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
      where: { segment_id: item.segmentId }, orderBy: { column: 'id', direction: 'asc' }, limit: 1000
    }))).snapshot);
    let block: DomainRow;
    try {
      block = await selectConversationCompressionBlock(database, item.segmentId, conversationId, sources);
    } catch {
      throw invalid('原生压缩状态缺少本对话唯一的历史来源。');
    }
    const blockId = id(block.id);
    if (block.summary_object_id !== (await get(database, 'ContextSegment', item.segmentId)).content_object_id) {
      throw invalid('压缩摘要与不可变来源的内容身份不一致。');
    }
    const originals = (await database.snapshotAll(DOMAIN_REPOSITORIES.domain('CompressionBlockSource').list({
      where: { compression_block_id: blockId }, orderBy: { column: 'id', direction: 'asc' }, limit: 1000
    }))).snapshot.sort((left, right) => {
      const a = BigInt(String(left.position)); const b = BigInt(String(right.position));
      return a < b ? -1 : a > b ? 1 : 0;
    });
    if (!originals.length) throw invalid('原生压缩来源为空。');
    if (originals.length > MAX_REPLAY_SEGMENTS - visits) throw limited('segments', '压缩来源超过重建数量上限。');
    const expanded: FullProviderContextItem[] = [];
    for (const [position, source] of originals.entries()) {
      if (BigInt(String(source.position)) !== BigInt(position)) throw invalid('原生压缩来源顺序不连续。');
      const segmentId = id(source.segment_id);
      let original = cache.get(segmentId);
      if (!original) {
        const segment = await get(database, 'ContextSegment', segmentId);
        const metadata = await get(database, 'ContentObject', id(segment.content_object_id));
        if (Number(metadata.byte_length) > MAX_REPLAY_BYTES - bytes) throw limited('bytes', '历史内容超过重建字节上限。');
        const content = (await store.read(metadata as unknown as ContentObjectMetadata)).toString('utf8');
        let role: string | null = null;
        if (metadata.content_type === 'application/vnd.limcode.message+json') {
          const message: unknown = JSON.parse(content);
          if (record(message) && (message.role === 'user' || message.role === 'model')) role = message.role;
        }
        original = { segmentId, segmentKind: id(segment.segment_kind), messageRole: role,
          contentType: id(metadata.content_type), content };
        cache.set(segmentId, original);
      }
      expanded.push(original);
    }
    for (const original of expanded.reverse()) stack.push({ item: original, ancestors: [...ancestors, item.segmentId] });
  }
  return output;
}

function isNativeState(item: FullProviderContextItem): boolean {
  if (item.segmentKind !== 'compression' || item.contentType !== 'application/vnd.limcode.compression-contents+json') return false;
  const document: unknown = JSON.parse(item.content);
  if (!record(document) || !Array.isArray(document.contents)) throw invalid('压缩内容不是有效的规范信封。');
  return document.contents.some((message) => record(message) && Array.isArray(message.parts)
    && message.parts.some((part) => record(part) && record(part.providerContext)));
}
async function get(database: RuntimeDatabase, domain: string, key: string): Promise<DomainRow> {
  const row = (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(key)])).snapshot[0];
  if (!row || Array.isArray(row)) throw invalid(`${domain} 历史来源缺失。`);
  return row;
}
function rows(value: unknown): DomainRow[] { if (!Array.isArray(value)) throw invalid('历史来源查询无效。'); return value as DomainRow[]; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function id(value: unknown): string { if (typeof value !== 'string' || !value) throw invalid('历史来源身份无效。'); return value; }
function invalid(message: string): Error { return Object.assign(new Error(message), { code: 'MODEL_CONTEXT_NATIVE_SOURCE_INVALID' }); }
function limited(limit: CompressionSourceReplayLimit, message: string): Error {
  return Object.assign(new Error(message), { code: COMPRESSION_SOURCE_REPLAY_LIMIT_CODE, limit });
}
