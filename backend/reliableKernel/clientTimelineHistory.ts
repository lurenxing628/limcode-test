import type Database from 'better-sqlite3';
import { prepareCached } from './runtimeStatementCache';
import type { DomainRow } from './repositories';

export interface TimelineWindow { receives: DomainRow[]; sends: DomainRow[]; oldestSequence?: string; hasMore: boolean }

/** Two indexed suffix seeks; every accepted event remains independently pageable at one cut. */
export function readTimelineWindow(database: Database.Database, conversationId: string, limit: number, before?: bigint): TimelineWindow {
  const read = (table: string) => (prepareCached(database, `
    SELECT * FROM ${table} WHERE conversation_id = @conversationId
      ${before === undefined ? '' : 'AND exchange_seq < @before'}
     ORDER BY exchange_seq DESC LIMIT @limit
  `).all({ conversationId, limit: BigInt(limit + 1), ...(before === undefined ? {} : { before }) }) as DomainRow[])
    .map(row => projectTimelineLinkRecord(database, table === 'runtime_delivery_timeline_link' ? 'RuntimeDeliveryTimelineLink' : 'CollaborationSendTimelineLink', row));
  const all = [...read('runtime_delivery_timeline_link').map(row => ({ kind: 'receive', row })),
    ...read('collaboration_send_timeline_link').map(row => ({ kind: 'send', row }))]
    .sort((left, right) => BigInt(String(left.row.exchange_seq)) > BigInt(String(right.row.exchange_seq)) ? -1 : 1);
  for (let index = 1; index < all.length; index += 1) {
    if (all[index].row.exchange_seq === all[index - 1].row.exchange_seq) throw new Error('Exchange timeline sequence collision.');
  }
  const selected = all.slice(0, limit);
  return { receives: selected.filter(item => item.kind === 'receive').map(item => item.row),
    sends: selected.filter(item => item.kind === 'send').map(item => item.row),
    ...(selected.length ? { oldestSequence: String(selected[selected.length - 1].row.exchange_seq) } : {}),
    hasMore: all.length > limit };
}

/** The accepted identity of a logical inbox is stable even when a later retry is in the window. */
export function canonicalDeliveryTimelineLinks(database: Database.Database, conversationId: string, inboxIds: readonly string[]): DomainRow[] {
  const statement = prepareCached(database, `SELECT * FROM runtime_delivery_timeline_link
    WHERE conversation_id = ? AND inbox_item_id = ? ORDER BY exchange_seq ASC LIMIT 1`);
  const links = new Map<string, DomainRow>();
  for (const inboxId of new Set(inboxIds)) {
    const row = statement.get(conversationId, inboxId) as DomainRow | undefined;
    if (row) links.set(String(row.id), projectTimelineLinkRecord(database, 'RuntimeDeliveryTimelineLink', row));
  }
  return [...links.values()];
}

export function projectTimelineLinkRecord(database: Database.Database, domain: string, row: DomainRow): DomainRow {
  const field = domain === 'RuntimeDeliveryTimelineLink' ? 'receive_timeline_link_id' : 'send_timeline_link_id';
  const imported = Boolean(prepareCached(database, `SELECT id FROM timeline_import_provenance WHERE ${field} = ? LIMIT 1`).get(row.id));
  return { ...row, imported };
}
