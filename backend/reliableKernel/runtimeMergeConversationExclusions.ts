import Database from 'better-sqlite3';
import type { RuntimeDataSetMergeExcludedConversation } from './runtimeDataSetMergeLedger';
import {
  createRuntimeMergeConversationOwnership, runtimeMergeOwnershipEdges, runtimeMergeContentIdentityEdges,
  RUNTIME_MERGE_CONTENT_REFERENCE_COLUMNS, runtimeMergeRecipeContentReferences
} from './runtimeMergeConversationOwnership';

const EDGES = 'merge_exclusion_edges';
const NODES = 'merge_exclusion_nodes';
const CONTENT = 'merge_exclusion_content';
const CONTENT_EDGES = 'merge_exclusion_content_edges';
export class RuntimeMergeUnattributedError extends Error {
  public readonly code = 'runtime-data-set-merge-unattributed';
}

type RawRow = Readonly<Record<string, unknown>>;

/** A disk-backed index fed by the existing row scan, never a second scan of the source. */
export class RuntimeMergeConversationExclusions {
  private readonly index = new Database(':memory:');
  private readonly owners;
  private readonly edge: Database.Statement;
  private readonly content: Database.Statement;
  private readonly identity: Database.Statement;
  private readonly seed: Database.Statement;
  private readonly contains: Database.Statement;

  public constructor(private readonly source: Database.Database) {
    this.owners = createRuntimeMergeConversationOwnership(source);
    this.index.pragma('temp_store = FILE');
    this.index.pragma('temp.cache_size = -8192');
    this.write(() => this.index.exec(`
      CREATE TEMP TABLE ${EDGES} (a_domain TEXT, a_id TEXT, b_domain TEXT, b_id TEXT, PRIMARY KEY(a_domain,a_id,b_domain,b_id)) WITHOUT ROWID;
      CREATE INDEX temp.merge_exclusion_reverse ON ${EDGES}(b_domain,b_id,a_domain,a_id);
      CREATE TEMP TABLE ${NODES} (domain TEXT, id TEXT, code TEXT, count INTEGER NOT NULL DEFAULT 1, visited INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(domain,id)) WITHOUT ROWID;
      CREATE INDEX temp.merge_exclusion_pending ON ${NODES}(visited);
      CREATE TEMP TABLE ${CONTENT} (content_id TEXT, domain TEXT, id TEXT, PRIMARY KEY(content_id,domain,id)) WITHOUT ROWID;
      CREATE TEMP TABLE ${CONTENT_EDGES} (a_domain TEXT, a_id TEXT, b_domain TEXT, b_id TEXT, PRIMARY KEY(a_domain,a_id,b_domain,b_id)) WITHOUT ROWID;
      CREATE INDEX temp.merge_exclusion_content_reverse ON ${CONTENT_EDGES}(b_domain,b_id,a_domain,a_id);
    `));
    this.edge = this.index.prepare(`INSERT OR IGNORE INTO temp.${EDGES} VALUES (?,?,?,?)`);
    this.identity = this.index.prepare(`INSERT OR IGNORE INTO temp.${CONTENT_EDGES} VALUES (?,?,?,?)`);
    this.content = this.index.prepare(`INSERT OR IGNORE INTO temp.${CONTENT} VALUES (?,?,?)`);
    this.seed = this.index.prepare(`INSERT INTO temp.${NODES}(domain,id,code) VALUES ('Conversation',?,?) ON CONFLICT(domain,id) DO UPDATE SET count=count+1,
      code=CASE WHEN ${NODES}.code='runtime-data-set-merge-unfinished-work' THEN excluded.code ELSE ${NODES}.code END,
      visited=CASE WHEN ${NODES}.code='runtime-data-set-merge-unfinished-work' AND excluded.code<>'runtime-data-set-merge-unfinished-work' THEN 0 ELSE ${NODES}.visited END`);
    this.contains = this.index.prepare(`SELECT 1 FROM temp.${NODES} WHERE domain=? AND id=?`);
  }

  public observe(domain: string, row: RawRow): void {
    this.write(() => {
      for (const edge of runtimeMergeOwnershipEdges(domain, row)) this.edge.run(edge.fromDomain, edge.fromId, edge.toDomain, edge.toId);
      for (const edge of runtimeMergeContentIdentityEdges(domain, row)) this.identity.run(edge.fromDomain, edge.fromId, edge.toDomain, edge.toId);
      if (typeof row.id !== 'string') return;
      for (const column of RUNTIME_MERGE_CONTENT_REFERENCE_COLUMNS.get(domain) ?? []) {
        const id = row[column];
        if (typeof id === 'string') this.content.run(id, domain, row.id);
      }
      // Only projection recipes have the contracted embedded CAS references.
      if (domain === 'ModelContextProjection') {
        for (const column of ['recipe_json', 'recipe']) {
          const value = row[column];
          let recipe: unknown = value;
          if (typeof value === 'string') { try { recipe = JSON.parse(value); } catch { continue; } }
          for (const id of runtimeMergeRecipeContentReferences(recipe)) this.content.run(id, domain, row.id);
        }
      }
    });
  }

  public observeRecipe(domain: string, id: string, recipe: unknown): void {
    for (const contentId of runtimeMergeRecipeContentReferences(recipe)) this.content.run(contentId, domain, id);
  }

  public exclude(domain: string, row: RawRow, code: string): void {
    const owners = this.owners.resolve(domain, row);
    if (!owners?.size) throw new RuntimeMergeUnattributedError(`无法按对话剔除 ${domain}:${String(row.id)}（${code}）：内容派生身份或无法归属。`);
    this.write(() => { for (const id of owners) this.seed.run(id, code); });
  }

  private contentUsers(id: string): Iterable<{ domain: string; id: string }> {
    return this.pagedUsers(`WITH RECURSIVE users(domain,id) AS (
      SELECT domain,id FROM temp.${CONTENT} WHERE content_id=?
      UNION SELECT e.a_domain,e.a_id FROM temp.${CONTENT_EDGES} e JOIN users u ON e.b_domain=u.domain AND e.b_id=u.id
      UNION SELECT e.b_domain,e.b_id FROM temp.${CONTENT_EDGES} e JOIN users u ON e.a_domain=u.domain AND e.a_id=u.id
    ) SELECT domain,id FROM users WHERE domain NOT IN ('ContentObject','Attachment','AttachmentObservationLink','ProjectContext')`, [id]);
  }

  public excludeContent(id: string, code: string): void {
    let found = false;
    for (const user of this.contentUsers(id)) {
      found = true;
      // The graph already contains every ownership edge; use its source row only for the seed.
      const owners = this.resolveIndexedOwners(user.domain, user.id);
      if (!owners.length) throw new RuntimeMergeUnattributedError(`无法按对话剔除正文 ${id}（${code}）：引用 ${user.domain}:${user.id} 无法归属。`);
      this.write(() => { for (const owner of owners) this.seed.run(owner, code); });
    }
    if (!found) throw new RuntimeMergeUnattributedError(`无法按对话剔除正文 ${id}（${code}）：没有可归属的引用。`);
  }

  private *pagedUsers(sql: string, parameters: string[]): IterableIterator<{domain:string;id:string}> {
    const page = this.index.prepare(`${sql} AND (domain,id) > (?,?) ORDER BY domain,id LIMIT 250`);
    let domain = '', id = '';
    for (;;) {
      const rows = page.all(...parameters,domain,id) as Array<{domain:string;id:string}>;
      if (!rows.length) return;
      for (const row of rows) yield row;
      ({domain,id}=rows[rows.length-1]);
    }
  }

  private resolveIndexedOwners(domain: string, id: string): string[] {
    return this.index.prepare(`WITH RECURSIVE owners(domain,id) AS (
      VALUES (?,?) UNION SELECT e.b_domain,e.b_id FROM temp.${EDGES} e JOIN owners o ON e.a_domain=o.domain AND e.a_id=o.id
    ) SELECT id FROM owners WHERE domain='Conversation'`).pluck().all(domain,id) as string[];
  }

  public requiredContent(id: string): boolean {
    let found = false;
    for (const user of this.contentUsers(id)) {
      found = true;
      if (!this.includes(user.domain,user.id)) return true;
    }
    return !found;
  }

  /** Expand linked families on disk, returning the thread after each bounded frontier page. */
  public async finish(chunkRows = 250): Promise<void> {
    const next = this.index.prepare(`SELECT domain,id,code FROM temp.${NODES} WHERE visited=0 LIMIT ?`);
    const mark = this.index.prepare(`UPDATE temp.${NODES} SET visited=1 WHERE domain=? AND id=? AND code=?`);
    const spread = this.index.prepare(`INSERT INTO temp.${NODES}(domain,id,code)
      SELECT b_domain,b_id,? FROM temp.${EDGES} WHERE a_domain=? AND a_id=?
      UNION SELECT a_domain,a_id,? FROM temp.${EDGES} WHERE b_domain=? AND b_id=?
      ON CONFLICT(domain,id) DO UPDATE SET code=excluded.code,visited=0
      WHERE ${NODES}.code='runtime-data-set-merge-unfinished-work' AND excluded.code<>'runtime-data-set-merge-unfinished-work'`);
    for (;;) {
      const rows = next.all(chunkRows) as Array<{domain: string; id: string; code: string}>;
      if (!rows.length) return;
      this.write(() => { for (const row of rows) {
        if (!mark.run(row.domain,row.id,row.code).changes) continue;
        spread.run(row.code,row.domain,row.id,row.code,row.domain,row.id);
      } });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  public hasProblems(): boolean { return this.index.prepare(`SELECT 1 FROM temp.${NODES} LIMIT 1`).get() !== undefined; }

  public includes(domain: string, id: string): boolean {
    if (domain === 'ContentObject') return !this.requiredContent(id);
    if (domain === 'Attachment' || domain === 'AttachmentObservationLink') {
      const users = this.pagedUsers(`WITH RECURSIVE users(domain,id) AS (
        VALUES (?,?) UNION SELECT e.a_domain,e.a_id FROM temp.${CONTENT_EDGES} e JOIN users u ON e.b_domain=u.domain AND e.b_id=u.id
      UNION SELECT e.b_domain,e.b_id FROM temp.${CONTENT_EDGES} e JOIN users u ON e.a_domain=u.domain AND e.a_id=u.id
      ) SELECT domain,id FROM users WHERE domain NOT IN ('Attachment','AttachmentObservationLink')`,[domain,id]);
      let found = false;
      for (const user of users) { found = true; if (!this.includes(user.domain,user.id)) return false; }
      return found;
    }
    return this.contains.get(domain,id) !== undefined;
  }

  public excluded(): RuntimeDataSetMergeExcludedConversation[] {
    const title = this.source.prepare('SELECT title FROM conversation WHERE id=?').pluck();
    const rows = this.index.prepare(`SELECT id AS conversationId,code,count FROM temp.${NODES} WHERE domain='Conversation' ORDER BY id`).all() as Array<Omit<RuntimeDataSetMergeExcludedConversation,'title'>>;
    return rows.map(row => ({...row,title: String(title.get(row.conversationId) ?? row.conversationId)}));
  }

  public close(): void {
    if (this.index.open) this.index.close();
  }

  private write<T>(run: () => T): T { return run(); }
}
