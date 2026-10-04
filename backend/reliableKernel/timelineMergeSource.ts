import type Database from 'better-sqlite3';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDataInvariantError } from './runtimeDataInvariant';
import { TIMELINE_DOMAIN_SCHEMAS } from './schema/domainsTimeline';
import type { RuntimeDomainSchema } from './schema/types';

export const TIMELINE_MERGE_DOMAINS: ReadonlySet<string> = new Set([
  'RuntimeDeliveryTimelineLink', 'CollaborationSendTimelineLink'
]);
export const TIMELINE_IMPORT_PROVENANCE_DOMAIN = 'TimelineImportProvenance';

export interface TimelineMergeSourceIdentity { sourceDataSetId: string; sourceRootInstanceId: string }

/** The caller already holds a verified, immutable source snapshot; never infer its origin. */
export function readTimelineMergeSourceIdentity(database: Database.Database): TimelineMergeSourceIdentity {
  const row = database.prepare('SELECT data_set_id, root_instance_id FROM root_binding WHERE singleton = 1').get() as {
    data_set_id?: unknown; root_instance_id?: unknown;
  } | undefined;
  if (typeof row?.data_set_id !== 'string' || !row.data_set_id
    || typeof row.root_instance_id !== 'string' || !row.root_instance_id) {
    throw new Error('Timeline import requires its verified source root identity.');
  }
  return { sourceDataSetId: row.data_set_id, sourceRootInstanceId: row.root_instance_id };
}

export interface TimelineMergeSourceRow {
  schema: RuntimeDomainSchema;
  row: DomainRow;
}

/**
 * Read both typed relations as one indexed source stream. Sorting each domain separately would
 * destroy send/receive interleaving when the destination allocates its shared import suffix.
 * Only one decoded row is retained here; callers bound their batches and yield even for skipped
 * rows. The source connection remains read-only throughout the iterator's lifetime.
 */
export function* timelineMergeSourceRows(
  database: Database.Database,
  includeInOrderProof: (domain: string, id: string) => boolean = () => true
): IterableIterator<TimelineMergeSourceRow> {
  const schemas = TIMELINE_DOMAIN_SCHEMAS.filter(schema => TIMELINE_MERGE_DOMAINS.has(schema.key));
  const columns = [...new Set(schemas.flatMap(schema => schema.columns.map(column => column.name)))];
  const select = schemas.map(schema => {
    const own = new Set(schema.columns.map(column => column.name));
    return `SELECT '${schema.key}' AS timeline_domain, ${columns.map(name =>
      own.has(name) ? `"${name}"` : `NULL AS "${name}"`).join(', ')} FROM "${schema.table}"`;
  }).join(' UNION ALL ');
  const byKey = new Map(schemas.map(schema => [schema.key, schema]));
  const statement = database.prepare(`${select} ORDER BY conversation_id, exchange_seq`);
  let previous: { conversationId: unknown; sequence: unknown } | undefined;
  for (const raw of statement.iterate() as IterableIterator<Record<string, unknown>>) {
    const schema = byKey.get(String(raw.timeline_domain));
    if (!schema) throw new Error('Unknown timeline import source domain.');
    if (!includeInOrderProof(schema.key, String(raw.id))) {
      // Match ordinary merge filtering: discarded history must not fail kept history's codec or
      // cross-row checks, but still yields one identity so callers count/yield every scanned row.
      yield { schema, row: { id: String(raw.id) } };
      continue;
    }
    if (previous && previous.conversationId === raw.conversation_id && previous.sequence === raw.exchange_seq) {
      throw new RuntimeDataInvariantError(schema.key, String(raw.id), 'Source send and receive coordinates must share one unique sequence.');
    }
    previous = { conversationId: raw.conversation_id, sequence: raw.exchange_seq };
    const record = Object.fromEntries(schema.columns.map(column => [column.name, raw[column.name]]));
    yield { schema, row: DOMAIN_REPOSITORIES.domain(schema.key).codec.decode(record) };
  }
}
