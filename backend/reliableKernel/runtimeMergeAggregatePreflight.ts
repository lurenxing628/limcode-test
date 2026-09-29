import Database from 'better-sqlite3';
import type { RuntimeDatabase } from './runtimeDatabase';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { assertModelRequestAggregate } from './runtimeModelRequestAggregate';
import { RuntimeDataInvariantError } from './runtimeDataInvariant';
import { RUNTIME_DOMAIN_SCHEMA_BY_KEY } from './schema/domainManifest';
import { attachRuntimeStatementCache, detachRuntimeStatementCache, prepareCached } from './runtimeStatementCache';

const DOMAINS = ['ModelRequest', 'Operation', 'Attempt', 'ModelStreamFence'] as const;
type AggregateDomain = typeof DOMAINS[number];
export interface MergeModelAggregate {
  modelRequestId: string;
  rows: Record<AggregateDomain, DomainRow[]>;
}
const PAGE = 64;
const TOUCHED = 'limcode_merge_aggregate_touched';
const CAPACITY: Record<AggregateDomain, number> = { ModelRequest: 1, Operation: 2, Attempt: 12, ModelStreamFence: 2 };

/** A bounded, internally consistent view of each target aggregate, read only by its own worker. */
export function readMergeModelAggregates(database: Database.Database, ids: readonly string[]): MergeModelAggregate[] {
  if (!Array.isArray(ids) || ids.length > PAGE || ids.some((id) => typeof id !== 'string' || !id)) {
    throw new TypeError('Merge aggregate read needs at most 64 ModelRequest ids.');
  }
  return ids.map((id) => {
    const read = (domain: AggregateDomain, where: string, parameters: string[]): DomainRow[] => {
      const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain)!;
      return (prepareCached(database, `SELECT * FROM ${schema.table} WHERE ${where} LIMIT ${CAPACITY[domain]}`)
        .all(...parameters) as Record<string, unknown>[]).map((raw) => DOMAIN_REPOSITORIES.codec(domain).decode(raw));
    };
    const requests = read('ModelRequest', 'id = ?', [id]);
    const operations = read('Operation', "owner_kind = 'model_request' AND owner_id = ?", [id]);
    return { modelRequestId: id, rows: {
      ModelRequest: requests,
      Operation: operations,
      Attempt: operations.flatMap((operation) => read('Attempt', 'operation_id = ?', [String(operation.id)])),
      ModelStreamFence: read('ModelStreamFence', 'model_request_id = ?', [id])
    } };
  });
}

/**
 * Checks the effective aggregate (kept source rows UNION target rows), not just new request rows.
 * Both directions of the soft ModelRequest/Operation relationship are covered, including attempts
 * added to an existing target request. A TEMP key set keeps memory bounded across all source chunks;
 * only one bounded aggregate is materialized in a separate in-memory connection for the very same
 * assertion the writer runs. No transaction or schema object of either real database is changed.
 * The final writer check remains authoritative when the target changes after this dry run.
 */
export class MergeAggregatePreflight {
  private readonly scratch = new Database(':memory:');
  private closed = false;

  public constructor(
    private readonly source: Database.Database,
    private readonly target: RuntimeDatabase,
    private readonly kept: (domain: string, id: string) => boolean = () => true
  ) {
    try {
      this.scratch.defaultSafeIntegers(true);
      this.scratch.pragma('temp_store = FILE');
      this.scratch.pragma('temp.cache_size = -1024');
      for (const domain of DOMAINS) {
        const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain)!;
        this.scratch.exec(`CREATE TABLE ${schema.table} (${schema.columns.map((c) =>
          `"${c.name}" ${c.type}${c.name === 'id' ? ' PRIMARY KEY' : ''}`).join(', ')})`);
      }
      attachRuntimeStatementCache(this.scratch);
      this.scratch.exec(`CREATE TEMP TABLE ${TOUCHED} (id TEXT PRIMARY KEY, flags INTEGER NOT NULL) WITHOUT ROWID`);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  public touch(domain: string, row: DomainRow): void {
    let id: unknown;
    if (domain === 'ModelRequest') id = row.id;
    else if (domain === 'Operation' && row.owner_kind === 'model_request') id = row.owner_id;
    else if (domain === 'Attempt') {
      const operation = this.source.prepare('SELECT owner_kind, owner_id FROM operation WHERE id = ?')
        .get(row.operation_id) as { owner_kind: string; owner_id: string } | undefined;
      if (!operation) throw new RuntimeDataInvariantError('Operation', String(row.operation_id), `Operation ${row.operation_id} does not exist.`);
      if (operation.owner_kind === 'model_request') id = operation.owner_id;
    } else if (domain === 'ModelStreamFence' || domain === 'ModelStreamCheckpoint') id = row.model_request_id;
    if (typeof id === 'string') {
      const flags = domain === 'ModelRequest' ? 1 : domain === 'ModelStreamFence' || domain === 'ModelStreamCheckpoint' ? 2 : 0;
      prepareCached(this.scratch, `INSERT INTO temp.${TOUCHED} VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET flags = flags | excluded.flags`).run(id, flags);
    }
  }

  public async validate(signal?: AbortSignal): Promise<void> {
    for (let after = ''; ;) {
      signal?.throwIfAborted();
      const page = prepareCached(this.scratch, `SELECT id, flags FROM temp.${TOUCHED} WHERE id > ? ORDER BY id LIMIT ${PAGE}`)
        .all(after) as Array<{ id: string; flags: bigint }>;
      const ids = page.map((entry) => entry.id);
      if (ids.length === 0) return;
      const targets = await this.target.mergeModelAggregates(ids);
      for (const target of targets) {
        signal?.throwIfAborted();
        const flags = page.find((entry) => entry.id === target.modelRequestId)!.flags;
        if ((flags & 2n) !== 0n && (flags & 1n) === 0n) throw new RuntimeDataInvariantError('ModelRequest', target.modelRequestId,
          `Historical stream copy requires its ModelRequest ${target.modelRequestId} to be copied in the same transaction.`);
        this.validateOne(target);
      }
      after = ids[ids.length - 1]!;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    detachRuntimeStatementCache(this.scratch);
    this.scratch.close();
  }

  private sourceRows(domain: AggregateDomain, where: string, value: string): DomainRow[] {
    const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain)!;
    const rows: DomainRow[] = [];
    // Filter BEFORE the bound: a skipped row must not hide a later, kept row.
    for (const raw of this.source.prepare(`SELECT * FROM ${schema.table} WHERE ${where}`).iterate(value) as IterableIterator<Record<string, unknown>>) {
      if (!this.kept(domain, String(raw.id))) continue;
      rows.push(DOMAIN_REPOSITORIES.codec(domain).decode(raw));
      if (rows.length >= CAPACITY[domain]) break;
    }
    return rows;
  }

  private validateOne(target: MergeModelAggregate): void {
    const id = target.modelRequestId;
    const union = (left: DomainRow[], right: DomainRow[]): DomainRow[] => [...new Map([...left, ...right].map((row) => [String(row.id), row])).values()];
    const operations = union(target.rows.Operation, this.sourceRows('Operation', "owner_kind = 'model_request' AND owner_id = ?", id));
    const rows: Record<AggregateDomain, DomainRow[]> = {
      ModelRequest: union(target.rows.ModelRequest, this.sourceRows('ModelRequest', 'id = ?', id)),
      Operation: operations,
      Attempt: union(target.rows.Attempt, operations.flatMap((operation) => this.sourceRows('Attempt', 'operation_id = ?', String(operation.id)))),
      ModelStreamFence: union(target.rows.ModelStreamFence, this.sourceRows('ModelStreamFence', 'model_request_id = ?', id))
    };
    if (rows.ModelStreamFence.length > 1) throw new RuntimeDataInvariantError('ModelRequest', id, `ModelRequest ${id} has more than one terminal fence.`);
    for (const domain of DOMAINS) {
      const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain)!;
      this.scratch.exec(`DELETE FROM ${schema.table}`);
      const columns = schema.columns.map((c) => c.name);
      const insert = prepareCached(this.scratch, `INSERT INTO ${schema.table} (${columns.join(',')}) VALUES (${columns.map((c) => `@${c}`).join(',')})`);
      for (const row of rows[domain]) insert.run(DOMAIN_REPOSITORIES.codec(domain).encodeInsert(row));
    }
    assertModelRequestAggregate(this.scratch, id);
  }

}
