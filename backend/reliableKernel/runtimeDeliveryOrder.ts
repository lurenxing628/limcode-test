import { requirePhaseFId, requirePositiveInteger } from './phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

const ORDER_SOURCE_READ_BATCH_SIZE = 100;

/**
 * Order new input injections before their immutable PendingTurnInput positions are allocated.
 * Collaboration has a durable global sequence; timestamps from different Hosts (or the same
 * millisecond) cannot order peer updates. Other results keep their existing timestamp/id slots.
 * Sorting peer rows only into the peer slots preserves process/answer ordering without a mixed
 * comparator whose sequence and timestamp comparisons could form a cycle.
 * Already injected input is never reordered: recovery uses its committed position instead.
 */
export async function orderRuntimeDeliveriesForInjection(
  database: RuntimeDatabase,
  deliveries: readonly DomainRow[]
): Promise<DomainRow[]> {
  const ordered = [...deliveries].sort((left, right) =>
    String(left.created_at).localeCompare(String(right.created_at))
    || String(left.id).localeCompare(String(right.id))
  );
  if (ordered.length < 2) return ordered;

  const peers: Array<{ row: DomainRow; position: number; sequence: bigint }> = [];
  for (let start = 0; start < ordered.length; start += ORDER_SOURCE_READ_BATCH_SIZE) {
    const batch = ordered.slice(start, start + ORDER_SOURCE_READ_BATCH_SIZE);
    const inboxes = (await database.snapshot(batch.map((delivery) =>
      DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').get(
        requirePhaseFId(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id')
      )
    ))).snapshot;
    const peerSources: Array<{ row: DomainRow; position: number; messageId: string }> = [];
    for (let index = 0; index < batch.length; index += 1) {
      const inbox = inboxes[index];
      if (!inbox || Array.isArray(inbox)) throw new Error('Runtime delivery ordering requires its inbox source.');
      if (inbox.source_kind !== 'collaboration_message') continue;
      peerSources.push({ row: batch[index], position: start + index,
        messageId: requirePhaseFId(inbox.source_id, 'RuntimeInboxItem.source_id') });
    }
    if (peerSources.length === 0) continue;
    const messages = (await database.snapshot(peerSources.map(({ messageId }) =>
      DOMAIN_REPOSITORIES.domain('CollaborationMessage').get(messageId)
    ))).snapshot;
    for (let index = 0; index < peerSources.length; index += 1) {
      const message = messages[index];
      if (!message || Array.isArray(message)) throw new Error('Runtime delivery ordering requires its collaboration message.');
      peers.push({ row: peerSources[index].row, position: peerSources[index].position,
        sequence: requirePositiveInteger(message.message_seq, 'CollaborationMessage.message_seq') });
    }
  }
  const positions = peers.map(({ position }) => position);
  peers.sort((left, right) => left.sequence < right.sequence ? -1
    : left.sequence > right.sequence ? 1 : left.position - right.position);
  for (let index = 0; index < peers.length; index += 1) ordered[positions[index]] = peers[index].row;
  return ordered;
}
