import type Database from 'better-sqlite3';

/**
 * Row shape better-sqlite3 keeps on a Statement object. pluck/raw/expand are mutually exclusive
 * and stay on the object until changed, exactly like safeIntegers.
 */
export type RuntimeStatementRows = 'object' | 'pluck' | 'raw' | 'expand';

export interface RuntimeStatementMode {
  /** Row shape of a statement that returns data; defaults to plain objects. */
  rows?: RuntimeStatementRows;
  /**
   * BigInt integers; defaults to the connection's default when the cache was attached, as for a
   * fresh prepare. That default must not change while the cache is attached (the change throws).
   */
  safeIntegers?: boolean;
}

/** Counters of one connection's cache; metadata only, never SQL text or parameters. */
export interface RuntimeStatementCacheCounters {
  entries: number;
  maxEntries: number;
  /** Native prepares made through this cache: misses, busy bypasses and uncached statements. */
  prepares: number;
  hits: number;
  misses: number;
  evictions: number;
  /** Same SQL requested while its cached Statement was iterating; served by a private prepare. */
  busyBypasses: number;
  /** Variable-text SQL (placeholder lists) that is prepared per call and never cached. */
  uncached: number;
}

export const RUNTIME_STATEMENT_CACHE_MAX_ENTRIES = 256;

type PreparingConnection = Pick<Database.Database, 'prepare'>;

interface NormalizedMode {
  rows: RuntimeStatementRows;
  safeIntegers: boolean;
}

/**
 * Bounded LRU of prepared Statements for one SQLite connection.
 *
 * better-sqlite3 releases a Statement's native memory only from a finalizer that runs after the
 * thread returns to its event loop. A Runtime transaction is one synchronous worker call, so
 * preparing per step makes native memory grow with the number of rows until the commit returns.
 * Reusing the Statement of an identical SQL text keeps that memory proportional to the number of
 * distinct statements instead.
 *
 * Entries are keyed by SQL text plus the requested result mode, and the mode is applied again on
 * every hit, so a Statement always behaves like the fresh prepare it replaces. A Statement that is
 * still iterating is never handed out twice. The cache belongs to exactly one connection object and
 * is dropped with it; another connection or a reopened worker starts empty. SQLite automatically
 * recompiles a Statement after a schema change, and better-sqlite3 updates its returned column shape.
 * The connection's default safeIntegers must not change after attaching: cached Statements keep the
 * default read at attach time, so attachRuntimeStatementCache makes such a change throw.
 */
export class RuntimeStatementCache {
  private readonly entries = new Map<string, Database.Statement>();
  /** The connection default read when the cache was created; every cached Statement uses it. */
  public readonly connectionSafeIntegers: boolean;
  private closed = false;
  private prepares = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private busyBypasses = 0;
  private uncached = 0;

  public constructor(
    private readonly database: Database.Database,
    private readonly maxEntries: number = RUNTIME_STATEMENT_CACHE_MAX_ENTRIES
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Runtime statement cache size must be a positive integer.');
    }
    // A fresh prepare inherits the connection default; read it back instead of assuming it.
    this.connectionSafeIntegers = typeof (database.prepare('SELECT 1 AS probe').get() as { probe: unknown }).probe === 'bigint';
  }

  /** Statement for fixed SQL text, reused while it stays in the LRU. */
  public prepare(sql: string, mode: RuntimeStatementMode = {}): Database.Statement {
    this.assertOpen();
    const normalized = this.normalize(mode);
    const key = `${normalized.rows}:${normalized.safeIntegers ? 'bigint' : 'number'}:${sql}`;
    const cached = this.entries.get(key);
    if (cached) {
      if (cached.busy) {
        // An open iterator owns the cached Statement. Re-entering the same SQL gets a private one
        // that is not cached, so the iterator's Statement is never reset or reconfigured.
        this.busyBypasses += 1;
        return this.prepareNative(sql, normalized);
      }
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.hits += 1;
      return applyMode(cached, normalized);
    }
    this.misses += 1;
    const statement = this.prepareNative(sql, normalized);
    this.entries.set(key, statement);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      // Only the cache reference is dropped; a caller still holding the Statement keeps using it.
      this.entries.delete(oldest);
      this.evictions += 1;
    }
    return statement;
  }

  /**
   * Statement for SQL whose text varies per call (for example one placeholder per id). Every
   * length would be another cache key, so it is prepared for this call only.
   */
  public prepareUncached(sql: string, mode: RuntimeStatementMode = {}): Database.Statement {
    this.assertOpen();
    this.uncached += 1;
    return this.prepareNative(sql, this.normalize(mode));
  }

  public inspect(): RuntimeStatementCacheCounters {
    return {
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      prepares: this.prepares,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      busyBypasses: this.busyBypasses,
      uncached: this.uncached
    };
  }

  /** Called before the connection closes; the cache can never serve another connection. */
  public close(): void {
    this.closed = true;
    this.entries.clear();
  }

  private prepareNative(sql: string, mode: NormalizedMode): Database.Statement {
    this.prepares += 1;
    return applyMode(this.database.prepare(sql), mode);
  }

  private normalize(mode: RuntimeStatementMode): NormalizedMode {
    const rows = mode.rows ?? 'object';
    if (rows !== 'object' && rows !== 'pluck' && rows !== 'raw' && rows !== 'expand') {
      throw new TypeError(`Unsupported statement row shape: ${String(rows)}`);
    }
    if (mode.safeIntegers !== undefined && typeof mode.safeIntegers !== 'boolean') {
      throw new TypeError('Statement safeIntegers mode must be a boolean.');
    }
    return { rows, safeIntegers: mode.safeIntegers ?? this.connectionSafeIntegers };
  }

  private assertOpen(): void {
    if (this.closed || !this.database.open) throw new Error('Runtime statement cache connection is closed.');
  }
}

function applyMode(statement: Database.Statement, mode: NormalizedMode): Database.Statement {
  if (statement.reader) {
    // Each toggle only clears its own shape, so all three are cleared before one is selected.
    statement.pluck(false).raw(false).expand(false);
    if (mode.rows !== 'object') statement[mode.rows](true);
  } else if (mode.rows !== 'object') {
    // Same TypeError a fresh prepare would raise for pluck/raw/expand on a statement without rows.
    statement[mode.rows](true);
  }
  return statement.safeIntegers(mode.safeIntegers);
}

const caches = new WeakMap<object, RuntimeStatementCache>();

/**
 * Attaches a new cache to one connection; a connection never shares or inherits a cache.
 * Set the connection's default safeIntegers before attaching and never change it afterwards:
 * a cached Statement keeps the default of the attach time while a fresh prepare would follow the
 * new one. Until the cache is detached, `defaultSafeIntegers` with another value throws.
 */
export function attachRuntimeStatementCache(
  database: Database.Database,
  maxEntries: number = RUNTIME_STATEMENT_CACHE_MAX_ENTRIES
): RuntimeStatementCache {
  if (caches.has(database)) throw new Error('Runtime statement cache is already attached to this connection.');
  const cache = new RuntimeStatementCache(database, maxEntries);
  caches.set(database, cache);
  const attachedDefault = cache.connectionSafeIntegers;
  const setDefault = database.defaultSafeIntegers;
  Object.defineProperty(database, 'defaultSafeIntegers', {
    configurable: true,
    writable: true,
    value: (toggle?: boolean) => {
      if ((toggle ?? true) !== attachedDefault) {
        throw new Error('The connection default safeIntegers must not change while a Runtime statement cache is attached.');
      }
      return setDefault.call(database, attachedDefault);
    }
  });
  return cache;
}

/** Detaches and closes the connection's cache; call before closing the connection. */
export function detachRuntimeStatementCache(database: Database.Database): void {
  const cache = caches.get(database);
  if (!cache) return;
  cache.close();
  caches.delete(database);
  Reflect.deleteProperty(database, 'defaultSafeIntegers');
}

/**
 * Fixed-SQL Statement of this connection. Connections without an attached cache (tests that call a
 * projection directly, one-off inspection connections) prepare fresh exactly as before.
 * Callers must not change the returned Statement's mode or bind() it; pass the mode instead.
 */
export function prepareCached(
  database: PreparingConnection,
  sql: string,
  mode?: RuntimeStatementMode
): Database.Statement {
  const cache = caches.get(database);
  if (cache) return cache.prepare(sql, mode);
  return applyFreshMode(database.prepare(sql), mode);
}

/** Variable-text SQL (placeholder lists): always a fresh prepare, never cached. */
export function prepareUncached(
  database: PreparingConnection,
  sql: string,
  mode?: RuntimeStatementMode
): Database.Statement {
  const cache = caches.get(database);
  if (cache) return cache.prepareUncached(sql, mode);
  return applyFreshMode(database.prepare(sql), mode);
}

function applyFreshMode(statement: Database.Statement, mode: RuntimeStatementMode | undefined): Database.Statement {
  if (!mode) return statement;
  if (mode.rows && mode.rows !== 'object') statement[mode.rows](true);
  if (mode.safeIntegers !== undefined) statement.safeIntegers(mode.safeIntegers);
  return statement;
}
