import { readCompressionDecision, readCompressionPurpose, safeProviderFailureMessage,
  type CompressionRecoveryDecision } from './compressionExecution';

export interface CompressionNotice { id: string; title: string; detail: string; turnId: string; createdAt: number; }
type Row = Record<string, unknown>;
type Buckets = Record<string, Record<string, Row>>;

/** Pure projection of committed bounded metadata. No per-message detail requests, timing guesses,
 * prompt parsing or client-side execution decisions. A group is exactly one frozen source/settings. */
export function projectCompressionNotices(input: {
  conversationId: string;
  records: Buckets;
  messages: readonly { id: string; role: string; createdAt: number }[];
  turnIdByMessageId: Record<string, string>;
  placedTerminationIds?: readonly string[];
}): {
  byAnchor: Record<string, CompressionNotice[]>;
  unanchored: CompressionNotice[];
  unanchoredFailures: CompressionNotice[];
} {
  const turns = new Set(Object.values(input.records.Turn ?? {})
    .filter((turn) => turn.conversation_id === input.conversationId).map((turn) => String(turn.id)));
  const anchors = new Map<string, string>();
  for (const message of input.messages) {
    if (message.role === 'user' && input.turnIdByMessageId[message.id]) anchors.set(input.turnIdByMessageId[message.id], message.id);
  }
  const validTimes = input.messages.map((message) => message.createdAt).filter((time) => time > 0);
  const floor = validTimes.length ? Math.min(...validTimes) : 0;
  const groups = new Map<string, CompressionNotice>();
  const compressionTurns = new Set<string>();
  for (const request of Object.values(input.records.ModelRequest ?? {})) {
    const turnId = String(request.turn_id);
    if (!turns.has(turnId)) continue;
    const stats = record(request.stream_stats_json);
    if (!stats) continue;
    try {
      if (stats.compressionPurpose !== undefined) {
        const purpose = readCompressionPurpose(stats.compressionPurpose);
        compressionTurns.add(turnId);
        const block = input.records.CompressionBlock?.[purpose.blockId];
        if (request.terminal_state === 'completed' && block && block.status !== 'soft_deleted'
          && purpose.priorFailures.length) {
          const decision: CompressionRecoveryDecision = {
            groupId: purpose.groupId, outcome: 'compressed', methodKind: purpose.methodKind,
            failures: purpose.priorFailures
          };
          groups.set(`${turnId}:${purpose.groupId}`, notice(decision, turnId, time(block.created_at)));
        }
      }
      if (stats.compressionDecision !== undefined) {
        const decision = readCompressionDecision(stats.compressionDecision);
        if (decision.failures.length || decision.outcome === 'continued_uncompressed') {
          groups.set(`${turnId}:${decision.groupId}`, notice(decision, turnId, time(request.created_at)));
        }
      }
    } catch {
      // Invalid/partial wire summaries are never treated as success. Durable server errors and the
      // existing feed-resync path remain authoritative; a malformed presentation cannot break chat.
    }
  }
  const byAnchor: Record<string, CompressionNotice[]> = {};
  const unanchored: CompressionNotice[] = [];
  for (const item of [...groups.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const anchor = anchors.get(item.turnId);
    if (anchor) (byAnchor[anchor] ??= []).push(item);
    else if (item.createdAt >= floor) unanchored.push(item);
  }
  const placed = new Set(input.placedTerminationIds ?? []);
  const unanchoredFailures = Object.values(input.records.TurnTermination ?? {}).flatMap((termination): CompressionNotice[] => {
    const id = String(termination.id);
    const turnId = String(termination.turn_id);
    const createdAt = time(termination.created_at);
    if (!turns.has(turnId) || termination.terminal_status !== 'failed' || placed.has(id) || createdAt < floor) return [];
    return [{ id, turnId, createdAt, title: compressionTurns.has(turnId) ? '上下文压缩失败' : '本轮执行失败',
      detail: safeProviderFailureMessage(termination.reason) }];
  }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return { byAnchor, unanchored, unanchoredFailures };
}
function notice(decision: CompressionRecoveryDecision, turnId: string, createdAt: number): CompressionNotice {
  const errors = decision.failures.map((failure) => `${label(failure.methodKind)}${failure.status ? `（HTTP ${failure.status}）` : ''}：${failure.message}`).join('；');
  return {
    id: `compression-warning:${turnId}:${decision.groupId}`, turnId, createdAt,
    title: decision.outcome === 'compressed' ? '上下文压缩已使用后备方法' : '本次请求保留原始上下文',
    detail: decision.outcome === 'compressed'
      ? `已使用${label(decision.methodKind ?? '')}完成压缩。${errors}`
      : `压缩未完成，完整输入估算为 ${decision.estimatedTokens} Token，未超过计划输入容量 ${decision.limitTokens} Token；本次普通请求继续使用未压缩上下文。${errors}`
  };
}
function label(value: string): string {
  return ({ provider_native: 'Provider 原生压缩', segmented_summary: '分段摘要', llm_summary: '单次 LLM 摘要',
    deterministic_summary: '确定性摘要', manual_summary: '手动摘要' } as Record<string, string>)[value] ?? value;
}
function record(value: unknown): Row | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined; }
function time(value: unknown): number { const result = typeof value === 'string' ? Date.parse(value) : Number(value); return Number.isFinite(result) ? result : 0; }
