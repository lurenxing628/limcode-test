import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { TURN_INTENT_ENVELOPE_CONTENT_TYPE } from './guidanceIntent';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

/**
 * True for a manual compression or summary rebuild Turn: its admitted TurnIntent payload carries
 * the immutable runtimeMaintenance descriptor. Such a Turn runs no model over new input, so it
 * never takes a RuntimeDelivery in; deliveries for its Conversation wait for the next real Turn.
 * The classification never changes once the Turn is admitted.
 */
export async function isRuntimeMaintenanceTurn(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnId: string
): Promise<boolean> {
  const intents = (await database.snapshot([
    DOMAIN_REPOSITORIES.domain('TurnIntent').list({ where: { turn_id: turnId }, limit: 2 })
  ])).snapshot[0] as DomainRow[];
  // Copied history Turns of a fork have no TurnIntent here and never run again.
  if (intents.length !== 1) return false;
  const revisions = (await database.snapshot([
    DOMAIN_REPOSITORIES.domain('TurnIntentRevision').list({
      where: { intent_id: intents[0].id },
      orderBy: { column: 'revision_seq', direction: 'desc' },
      limit: 1
    })
  ])).snapshot[0] as DomainRow[];
  if (!revisions[0]) return false;
  const metadata = (await database.snapshot([
    DOMAIN_REPOSITORIES.domain('ContentObject').get(String(revisions[0].content_object_id))
  ])).snapshot[0] as ContentObjectMetadata | null;
  if (!metadata || metadata.content_type !== TURN_INTENT_ENVELOPE_CONTENT_TYPE) return false;
  const payload: unknown = JSON.parse((await contentStore.read(metadata)).toString('utf8'));
  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)
    && (payload as Record<string, unknown>).runtimeMaintenance !== undefined;
}
