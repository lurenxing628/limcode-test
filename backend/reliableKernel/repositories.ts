import type { RuntimeDomainMutation } from './contracts';
import {
  RUNTIME_DOMAIN_SCHEMAS,
  RUNTIME_DOMAIN_SCHEMA_BY_KEY
} from './schema/domainManifest';
import type { ColumnDefinition, RuntimeDomainSchema } from './schema/types';

export type DomainRow = Record<string, unknown>;

/** Domains eligible for trusted Conversation-fork transcript copy inserts. */
export const HISTORICAL_COPY_DOMAINS: readonly string[] = [
  'ModelRequest',
  'Operation',
  'Attempt',
  'ModelStreamFence'
];
export type EncodedRow = Record<string, string | bigint | Buffer | null>;

export interface RepositoryInsertMutation {
  kind: 'insert';
  domain: string;
  row: DomainRow;
  allocateSequence?: {
    column: string;
    scope: DomainRow;
  };
  /** Fixed writer dataflow: copy this MessageRevision's allocated revision_seq into ContextSegmentSource.source_revision. */
  messageRevisionSequenceReferenceId?: string;
  /**
   * Conversation-fork transcript copy: the row is a verbatim copy of an already-terminal source row,
   * so the writer skips "must start prepared/pending" creation invariants and instead enforces the
   * mirrored terminal invariants. Restricted to ModelRequest/Operation/Attempt/ModelStreamFence.
   */
  historicalCopy?: true;
}

export interface RepositoryUpdateMutation {
  kind: 'update';
  domain: string;
  id: string;
  patch: DomainRow;
}

export interface RepositoryDeleteMutation {
  kind: 'delete';
  domain: string;
  id: string;
}

export interface RepositoryCheckpointPruneMutation {
  kind: 'pruneModelStreamCheckpoints';
  domain: 'ModelStreamCheckpoint';
  modelRequestId: string;
  attemptSeq: bigint;
  socketGeneration: bigint;
  terminalCheckpointId: string;
}

export interface RepositoryDeleteWhereMutation {
  kind: 'deleteWhere';
  domain: string;
  where: DomainRow;
  maxChanges: 1;
}

export interface RepositoryAssertStep {
  kind: 'assert';
  domain: string;
  id: string;
  where: DomainRow;
}

export interface RepositoryAssertAllStep {
  kind: 'assertAll';
  domain: string;
  where: DomainRow;
  expected: DomainRow;
}

export interface RepositoryAssertNoneStep {
  kind: 'assertNone';
  domain: string;
  where: DomainRow;
}

export interface RepositoryAssertExactIdsStep {
  kind: 'assertExactIds';
  domain: string;
  where: DomainRow;
  expectedIds: string[];
}

export interface RepositoryExpectedUniqueConstraint {
  domain: string;
  columns: string[];
}

export type RepositorySavepointOnError = 'propagate' | {
  kind: 'rollback-and-continue-on-unique';
  constraints: RepositoryExpectedUniqueConstraint[];
};

export interface RepositorySavepoint {
  kind: 'savepoint';
  name: string;
  steps: RepositoryTransactionStep[];
  onError: RepositorySavepointOnError;
}

export type RepositoryMutation =
  | RepositoryInsertMutation
  | RepositoryUpdateMutation
  | RepositoryDeleteMutation
  | RepositoryDeleteWhereMutation
  | RepositoryCheckpointPruneMutation;
export type RepositoryTransactionStep =
  | RepositoryMutation
  | RepositoryAssertStep
  | RepositoryAssertAllStep
  | RepositoryAssertNoneStep
  | RepositoryAssertExactIdsStep
  | RepositorySavepoint;

export interface RepositoryGetRead {
  kind: 'get';
  domain: string;
  id: string;
}

export interface RepositoryKeysetCursor { column: string; value: string | bigint; id: string; direction: 'before' | 'after' }

export interface RepositoryListRead {
  kind: 'list';
  domain: string;
  where?: DomainRow;
  orderBy?: { column: string; direction: 'asc' | 'desc' };
  afterId?: string;
  keyset?: RepositoryKeysetCursor;
  /** Fixed mailbox membership predicate, valid only for CollaborationMessage. */
  collaborationConversationId?: string;
  limit: number;
}

export type RepositoryRead = RepositoryGetRead | RepositoryListRead;

export class DomainRowCodec {
  private readonly columnsByName: ReadonlyMap<string, ColumnDefinition>;

  public constructor(
    public readonly name: string,
    public readonly schema: RuntimeDomainSchema
  ) {
    this.columnsByName = new Map(schema.columns.map((column) => [column.name, column]));
  }

  public encodeInsert(row: DomainRow): EncodedRow {
    rejectUnknownKeys(row, this.columnsByName, this.name);
    const encoded: EncodedRow = {};
    for (const column of this.schema.columns) {
      const value = row[column.name];
      if (value === undefined) {
        if (column.defaultSql !== undefined) continue;
        if (column.nullable) {
          encoded[column.name] = null;
          continue;
        }
        throw new TypeError(`${this.name}.${column.name} is required.`);
      }
      encoded[column.name] = encodeValue(column, value, this.name);
    }
    return encoded;
  }

  public encodePatch(patch: DomainRow): EncodedRow {
    rejectUnknownKeys(patch, this.columnsByName, this.name);
    if ('id' in patch) throw new TypeError(`${this.name}.id is immutable.`);
    const encoded: EncodedRow = {};
    for (const [name, value] of Object.entries(patch)) {
      const column = this.columnsByName.get(name);
      if (!column) throw new TypeError(`${this.name}.${name} is not a schema column.`);
      if (value === undefined) throw new TypeError(`${this.name}.${name} cannot be undefined.`);
      encoded[name] = encodeValue(column, value, this.name);
    }
    if (Object.keys(encoded).length === 0) throw new TypeError(`${this.name} update patch cannot be empty.`);
    return encoded;
  }

  public encodeWhere(where: DomainRow): EncodedRow {
    rejectUnknownKeys(where, this.columnsByName, this.name);
    const encoded: EncodedRow = {};
    for (const [name, value] of Object.entries(where)) {
      const column = this.columnsByName.get(name);
      if (!column) throw new TypeError(`${this.name}.${name} is not a schema column.`);
      if (value === undefined) throw new TypeError(`${this.name}.${name} cannot be undefined.`);
      encoded[name] = encodeValue(column, value, this.name);
    }
    return encoded;
  }

  public decode(row: Record<string, unknown>): DomainRow {
    const decoded: DomainRow = {};
    for (const column of this.schema.columns) {
      if (!(column.name in row)) throw new TypeError(`${this.name} query row is missing ${column.name}.`);
      const value = row[column.name];
      if (value === null) {
        if (!column.nullable) throw new TypeError(`${this.name}.${column.name} unexpectedly contains NULL.`);
        decoded[column.name] = null;
      } else if (column.json) {
        if (typeof value !== 'string') throw new TypeError(`${this.name}.${column.name} must be JSON text in SQLite.`);
        decoded[column.name] = JSON.parse(value);
      } else if (column.type === 'INTEGER') {
        if (typeof value !== 'bigint') throw new TypeError(`${this.name}.${column.name} must be read with safe integers enabled.`);
        decoded[column.name] = value;
      } else if (column.type === 'BLOB') {
        if (!Buffer.isBuffer(value)) throw new TypeError(`${this.name}.${column.name} must be a Buffer.`);
        decoded[column.name] = Buffer.from(value);
      } else {
        if (typeof value !== 'string') throw new TypeError(`${this.name}.${column.name} must be text.`);
        decoded[column.name] = value;
      }
    }
    return decoded;
  }

  public hasColumn(name: string): boolean {
    return this.columnsByName.has(name);
  }

  public column(name: string): ColumnDefinition | undefined {
    return this.columnsByName.get(name);
  }
}

export class DomainRepository {
  public constructor(
    public readonly name: string,
    public readonly schema: RuntimeDomainSchema,
    public readonly codec: DomainRowCodec
  ) {}

  public insert(row: DomainRow): RepositoryInsertMutation {
    this.requireMutation('insert');
    this.codec.encodeInsert(row);
    return { kind: 'insert', domain: this.schema.key, row: clonePlainRecord(row) };
  }

  /**
   * Trusted Conversation-fork transcript copy channel. Only the domains whose creation invariants
   * (prepared/pending start state, Fence fixed-writer restriction) are mirrored by terminal-state
   * checks in the database worker may use it.
   */
  public insertHistoricalCopy(row: DomainRow): RepositoryInsertMutation {
    this.requireMutation('insert');
    if (!HISTORICAL_COPY_DOMAINS.includes(this.schema.key)) {
      throw new TypeError(`${this.name} does not permit historical copy inserts.`);
    }
    this.codec.encodeInsert(row);
    return { kind: 'insert', domain: this.schema.key, row: clonePlainRecord(row), historicalCopy: true };
  }

  public insertWithNextSequence(
    row: DomainRow,
    allocation: { column: string; scope: DomainRow }
  ): RepositoryInsertMutation {
    if (!allocation.column.endsWith('_seq')) {
      throw new TypeError(`${this.name}.${allocation.column} is not a sequence column.`);
    }
    return this.insertWithNextAllocatedInteger(row, allocation);
  }

  /** Fixed MessageRevision -> Context source relation resolved inside the same writer transaction. */
  public insertMessageContextSourceForRevision(
    row: DomainRow,
    messageRevisionId: string
  ): RepositoryInsertMutation {
    this.requireMutation('insert');
    if (this.schema.key !== 'ContextSegmentSource') {
      throw new TypeError(`${this.name} is not the ContextSegmentSource Repository.`);
    }
    if ('source_revision' in row) {
      throw new TypeError(`${this.name}.source_revision cannot be supplied for a writer-allocated Message revision.`);
    }
    requireId(messageRevisionId);
    if (row.source_kind !== 'message_revision' || row.source_id !== messageRevisionId) {
      throw new TypeError('Message Context source must identify the referenced MessageRevision.');
    }
    this.codec.encodeInsert({ ...row, source_revision: 1n });
    return {
      kind: 'insert',
      domain: 'ContextSegmentSource',
      row: clonePlainRecord(row),
      messageRevisionSequenceReferenceId: messageRevisionId
    };
  }

  public insertWithNextPosition(row: DomainRow): RepositoryInsertMutation {
    if (this.schema.key !== 'PendingTurnInput') {
      throw new TypeError(`${this.name} does not support writer-allocated position.`);
    }
    const turnId = row.turn_id;
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new TypeError(`${this.name}.turn_id is required to allocate position.`);
    }
    return this.insertWithNextAllocatedInteger(row, {
      column: 'position',
      scope: { turn_id: turnId }
    });
  }

  public update(id: string, patch: DomainRow): RepositoryUpdateMutation {
    this.requireMutation('update');
    requireId(id);
    assertRuntimeDomainUpdatePatch(this.schema.key, patch);
    this.codec.encodePatch(patch);
    return { kind: 'update', domain: this.schema.key, id, patch: clonePlainRecord(patch) };
  }

  public delete(id: string): RepositoryDeleteMutation {
    this.requireMutation('delete');
    requireId(id);
    if (this.schema.key === 'ModelStreamCheckpoint') {
      throw new Error('ModelStreamCheckpoint delete is limited to the fixed writer pruneAfterTerminalFence operation.');
    }
    return { kind: 'delete', domain: this.schema.key, id };
  }

  public pruneAfterTerminalFence(
    modelRequestId: string,
    attemptSeq: bigint,
    socketGeneration: bigint,
    terminalCheckpointId: string
  ): RepositoryCheckpointPruneMutation {
    this.requireMutation('delete');
    if (this.schema.key !== 'ModelStreamCheckpoint') {
      throw new Error(`${this.name} does not support ModelStream checkpoint pruning.`);
    }
    requireId(modelRequestId);
    requireId(terminalCheckpointId);
    if (typeof attemptSeq !== 'bigint' || attemptSeq <= 0n) throw new TypeError('attemptSeq must be positive.');
    if (typeof socketGeneration !== 'bigint' || socketGeneration <= 0n) {
      throw new TypeError('socketGeneration must be positive.');
    }
    return {
      kind: 'pruneModelStreamCheckpoints',
      domain: 'ModelStreamCheckpoint',
      modelRequestId,
      attemptSeq,
      socketGeneration,
      terminalCheckpointId
    };
  }

  public deleteByUnique(where: DomainRow): RepositoryDeleteWhereMutation {
    this.requireMutation('delete');
    if (this.schema.key === 'ModelStreamCheckpoint') {
      throw new Error('ModelStreamCheckpoint delete is limited to the fixed writer pruneAfterTerminalFence operation.');
    }
    if (!coversUniqueIdentity(this.schema, where)) {
      throw new TypeError(`${this.name}.deleteByUnique requires a declared UNIQUE identity.`);
    }
    this.codec.encodeWhere(where);
    return { kind: 'deleteWhere', domain: this.schema.key, where: clonePlainRecord(where), maxChanges: 1 };
  }

  public assert(id: string, where: DomainRow): RepositoryAssertStep {
    requireId(id);
    this.codec.encodeWhere(where);
    return { kind: 'assert', domain: this.schema.key, id, where: clonePlainRecord(where) };
  }

  /** Transaction-local assertion: every row matching `where` must also match `expected`. */
  public assertAll(where: DomainRow, expected: DomainRow): RepositoryAssertAllStep {
    this.codec.encodeWhere(where);
    this.codec.encodeWhere(expected);
    if (Object.keys(expected).length === 0) throw new TypeError(`${this.name}.assertAll requires expected fields.`);
    return {
      kind: 'assertAll',
      domain: this.schema.key,
      where: clonePlainRecord(where),
      expected: clonePlainRecord(expected)
    };
  }

  /** Transaction-local assertion that a scoped relation set has exactly these stable row ids. */
  public assertExactIds(where: DomainRow, expectedIds: readonly string[]): RepositoryAssertExactIdsStep {
    this.codec.encodeWhere(where);
    if (Object.keys(where).length === 0) throw new TypeError(`${this.name}.assertExactIds requires predicates.`);
    const ids = expectedIds.map((id) => {
      requireId(id);
      return id;
    });
    if (new Set(ids).size !== ids.length) throw new TypeError(`${this.name}.assertExactIds received duplicate ids.`);
    return {
      kind: 'assertExactIds',
      domain: this.schema.key,
      where: clonePlainRecord(where),
      expectedIds: [...ids].sort()
    };
  }

  /** Transaction-local assertion that no row matches `where`. */
  public assertNone(where: DomainRow): RepositoryAssertNoneStep {
    this.codec.encodeWhere(where);
    if (Object.keys(where).length === 0) throw new TypeError(`${this.name}.assertNone requires predicates.`);
    return { kind: 'assertNone', domain: this.schema.key, where: clonePlainRecord(where) };
  }

  public get(id: string): RepositoryGetRead {
    requireId(id);
    return { kind: 'get', domain: this.schema.key, id };
  }

  public list(options: Omit<RepositoryListRead, 'kind' | 'domain'>): RepositoryListRead {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0 || options.limit > 1000) {
      throw new RangeError('Repository list limit must be an integer from 1 to 1000.');
    }
    if (options.where) this.codec.encodeWhere(options.where);
    if (options.orderBy && !this.codec.hasColumn(options.orderBy.column)) {
      throw new TypeError(`${this.name} cannot order by unknown column ${options.orderBy.column}.`);
    }
    if (options.afterId !== undefined) {
      requireId(options.afterId);
      if (options.orderBy && (options.orderBy.column !== 'id' || options.orderBy.direction !== 'asc')) {
        throw new TypeError(`${this.name} afterId pagination requires id ascending order.`);
      }
    }
    if (options.keyset) {
      if (options.afterId !== undefined) throw new TypeError('Cannot combine afterId and keyset cursors.');
      const column = this.codec.column(options.keyset.column);
      if (!column || column.type === 'BLOB' || column.json || column.nullable) throw new TypeError('Keyset requires a non-null scalar schema column.');
      if (options.orderBy?.column !== options.keyset.column) throw new TypeError('Keyset column must match orderBy.');
      if (!['before', 'after'].includes(options.keyset.direction)) throw new TypeError('Keyset direction must be before or after.');
      requireId(options.keyset.id);
      this.codec.encodeWhere({ [column.name]: options.keyset.value });
    }
    if (options.collaborationConversationId !== undefined) {
      if (this.schema.key !== 'CollaborationMessage') throw new TypeError('Mailbox scope is only valid for CollaborationMessage.');
      requireId(options.collaborationConversationId);
    }
    return {
      kind: 'list',
      domain: this.schema.key,
      ...(options.where ? { where: clonePlainRecord(options.where) } : {}),
      ...(options.orderBy ? { orderBy: { ...options.orderBy } } : {}),
      ...(options.afterId ? { afterId: options.afterId } : {}),
      ...(options.keyset ? { keyset: { ...options.keyset } } : {}),
      ...(options.collaborationConversationId ? { collaborationConversationId: options.collaborationConversationId } : {}),
      limit: options.limit
    };
  }

  private insertWithNextAllocatedInteger(
    row: DomainRow,
    allocation: { column: string; scope: DomainRow }
  ): RepositoryInsertMutation {
    this.requireMutation('insert');
    const column = this.codec.column(allocation.column);
    if (!column || column.type !== 'INTEGER') {
      throw new TypeError(`${this.name}.${allocation.column} is not an allocatable INTEGER column.`);
    }
    if (allocation.column in row) throw new TypeError(`${this.name}.${allocation.column} must be allocated by the writer.`);
    this.codec.encodeInsert({ ...row, [allocation.column]: '1' });
    this.codec.encodeWhere(allocation.scope);
    return {
      kind: 'insert',
      domain: this.schema.key,
      row: clonePlainRecord(row),
      allocateSequence: {
        column: allocation.column,
        scope: clonePlainRecord(allocation.scope)
      }
    };
  }

  private requireMutation(mutation: RuntimeDomainMutation): void {
    if (!this.schema.mutations.includes(mutation)) {
      throw new Error(`${this.name} does not allow ${mutation}.`);
    }
  }
}

export class DomainRepositorySet {
  private readonly byDomain = new Map<string, DomainRepository>();
  private readonly byName = new Map<string, DomainRepository>();
  private readonly codecsByDomain = new Map<string, DomainRowCodec>();

  public constructor() {
    for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
      const codec = new DomainRowCodec(schema.codec, schema);
      const repository = new DomainRepository(schema.repository, schema, codec);
      this.byDomain.set(schema.key, repository);
      this.byName.set(repository.name, repository);
      this.codecsByDomain.set(schema.key, codec);
    }
  }

  public domain(domainKey: string): DomainRepository {
    const repository = this.byDomain.get(domainKey);
    if (!repository) throw new Error(`Unknown Runtime domain Repository: ${domainKey}`);
    return repository;
  }

  public named(repositoryName: string): DomainRepository {
    const repository = this.byName.get(repositoryName);
    if (!repository) throw new Error(`Unknown Runtime Repository: ${repositoryName}`);
    return repository;
  }

  public codec(domainKey: string): DomainRowCodec {
    const codec = this.codecsByDomain.get(domainKey);
    if (!codec) throw new Error(`Unknown Runtime domain Codec: ${domainKey}`);
    return codec;
  }

  public all(): readonly DomainRepository[] {
    return RUNTIME_DOMAIN_SCHEMAS.map((schema) => this.domain(schema.key));
  }
}

export const DOMAIN_REPOSITORIES = new DomainRepositorySet();

export function savepoint(
  name: string,
  steps: RepositoryTransactionStep[],
  onError: RepositorySavepointOnError = 'propagate'
): RepositorySavepoint {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new TypeError(`Invalid savepoint name: ${name}`);
  return {
    kind: 'savepoint',
    name,
    steps: steps.map(cloneStep),
    onError: cloneSavepointOnError(onError)
  };
}

export function schemaForDomain(domainKey: string): RuntimeDomainSchema {
  const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domainKey);
  if (!schema) throw new Error(`Unknown Runtime domain: ${domainKey}`);
  return schema;
}

function encodeValue(column: ColumnDefinition, value: unknown, codecName: string): string | bigint | Buffer | null {
  if (value === null) {
    if (!column.nullable) throw new TypeError(`${codecName}.${column.name} cannot be null.`);
    return null;
  }
  if (column.json) {
    if (typeof value === 'string') {
      JSON.parse(value);
      return value;
    }
    return JSON.stringify(value);
  }
  if (column.type === 'TEXT') {
    if (typeof value !== 'string') throw new TypeError(`${codecName}.${column.name} must be a string.`);
    return value;
  }
  if (column.type === 'BLOB') {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new TypeError(`${codecName}.${column.name} must be bytes.`);
    }
    return Buffer.from(value);
  }
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${codecName}.${column.name} must be a bigint or decimal integer string.`);
}

function coversUniqueIdentity(schema: RuntimeDomainSchema, where: DomainRow): boolean {
  const fields = new Set(Object.keys(where));
  if (fields.has('id')) return true;
  return schema.indexes.some((index) => {
    if (!index.endsWith(' UNIQUE') || index.includes(' WHERE ')) return false;
    const columns = index.slice(0, -' UNIQUE'.length).split(',').map((column) => column.trim());
    return columns.length > 0 && columns.every((column) => fields.has(column));
  });
}

function declaresUniqueConstraint(schema: RuntimeDomainSchema, columnsInput: readonly string[]): boolean {
  const columns = [...columnsInput].sort();
  if (columns.length === 1 && columns[0] === 'id') return true;
  return schema.indexes.some((index) => {
    const partialMarker = ' UNIQUE WHERE ';
    const definition = index.includes(partialMarker)
      ? index.slice(0, index.indexOf(partialMarker))
      : index.endsWith(' UNIQUE')
        ? index.slice(0, -' UNIQUE'.length)
        : null;
    if (definition === null) return false;
    const declared = definition.split(',').map((column) => column.trim()).sort();
    return declared.length === columns.length
      && declared.every((column, position) => column === columns[position]);
  });
}


function rejectUnknownKeys(
  record: DomainRow,
  columns: ReadonlyMap<string, ColumnDefinition>,
  codecName: string
): void {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError(`${codecName} input must be an object.`);
  for (const key of Object.keys(record)) {
    if (!columns.has(key)) throw new TypeError(`${codecName} input contains unknown field ${key}.`);
  }
}

function requireId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('Runtime row id must be a non-empty string.');
}

function clonePlainRecord(record: DomainRow): DomainRow {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, clonePlainValue(value)]));
}

function clonePlainValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value === 'bigint' || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(clonePlainValue);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, clonePlainValue(nested)]));
}

function cloneStep(step: RepositoryTransactionStep): RepositoryTransactionStep {
  if (step.kind === 'savepoint') return savepoint(step.name, step.steps, step.onError);
  if (step.kind === 'assert') return { ...step, where: clonePlainRecord(step.where) };
  if (step.kind === 'assertAll') return {
    ...step,
    where: clonePlainRecord(step.where),
    expected: clonePlainRecord(step.expected)
  };
  if (step.kind === 'assertExactIds') return {
    ...step,
    where: clonePlainRecord(step.where),
    expectedIds: [...step.expectedIds]
  };
  if (step.kind === 'assertNone') return { ...step, where: clonePlainRecord(step.where) };
  if (step.kind === 'deleteWhere') return { ...step, where: clonePlainRecord(step.where) };
  if (step.kind === 'pruneModelStreamCheckpoints') return { ...step };
  if (step.kind === 'insert') return {
    ...step,
    row: clonePlainRecord(step.row),
    ...(step.allocateSequence ? {
      allocateSequence: {
        column: step.allocateSequence.column,
        scope: clonePlainRecord(step.allocateSequence.scope)
      }
    } : {}),
    ...(step.messageRevisionSequenceReferenceId
      ? { messageRevisionSequenceReferenceId: step.messageRevisionSequenceReferenceId }
      : {})
  };
  if (step.kind === 'update') return { ...step, patch: clonePlainRecord(step.patch) };
  return { ...step };
}

const RESTRICTED_UPDATE_COLUMNS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['ExecutionLease', new Set(['owner_id', 'host_boot_id', 'generation', 'acquired_at', 'expires_at'])],
  ['ModelRequest', new Set(['status', 'terminal_state', 'usage_json', 'stream_stats_json', 'updated_at'])],
  ['CompressionBlock', new Set(['status', 'updated_at'])],
  ['Operation', new Set(['status', 'updated_at'])],
  ['Attempt', new Set(['status', 'updated_at', 'completed_at'])],
  // request_object_id may change exactly once with pending -> dispatched to wrap the immutable
  // capability request in its durable dispatch lease fence.
  ['EffectIntent', new Set(['dispatch_state', 'request_object_id', 'updated_at'])],
  ['ChildExecution', new Set(['status', 'updated_at'])],
  ['ChildExecutionIntentLink', new Set(['state', 'updated_at'])],
  ['ChildExecutionActiveTurnLink', new Set(['turn_id', 'updated_at'])],
  ['AnswerBridge', new Set(['current_submission_id', 'status', 'updated_at'])],
  ['RuntimeInboxItem', new Set(['state', 'updated_at'])],
  ['CollaborationRequest', new Set(['state', 'updated_at'])],
  ['CollaborationBoardSubscriptionLink', new Set(['active', 'updated_at'])],
  ['RuntimeDelivery', new Set(['target_turn_id', 'phase', 'state', 'failure_reason', 'updated_at'])],
  ['RuntimeDeliveryInputLink', new Set(['handled_at', 'updated_at'])],
  ['ProcessCompletionDispatch', new Set([
    'state', 'claim_owner_host_boot_id', 'claim_generation', 'claim_expires_at', 'attempt_count',
    'failure_count', 'next_attempt_at', 'last_error', 'completed_at', 'updated_at'
  ])],
  ['RuntimeDeliveryWake', new Set([
    'state', 'claim_owner_host_boot_id', 'claim_generation', 'claim_expires_at', 'attempt_count',
    'failure_count', 'next_attempt_at', 'last_error', 'acknowledged_at', 'updated_at'
  ])]
]);

export function assertRuntimeDomainUpdatePatch(domain: string, patch: DomainRow): void {
  const allowed = RESTRICTED_UPDATE_COLUMNS.get(domain);
  if (!allowed) return;
  for (const column of Object.keys(patch)) {
    if (!allowed.has(column)) throw new Error(`${domain}.${column} is immutable after insert.`);
  }
  if (domain === 'CompressionBlock' && 'status' in patch) {
    const status = patch.status;
    if (!['enabled', 'disabled', 'soft_deleted'].includes(String(status))) {
      throw new TypeError('CompressionBlock.status must be enabled, disabled, or soft_deleted.');
    }
  }
}

function cloneSavepointOnError(onError: RepositorySavepointOnError): RepositorySavepointOnError {
  if (onError === 'propagate') return onError;
  if (onError.constraints.length === 0) throw new TypeError('Expected UNIQUE savepoint requires constraints.');
  return {
    kind: onError.kind,
    constraints: onError.constraints.map((constraint) => {
      const repository = DOMAIN_REPOSITORIES.domain(constraint.domain);
      if (constraint.columns.length === 0) throw new TypeError('Expected UNIQUE constraint requires columns.');
      for (const column of constraint.columns) {
        if (!repository.codec.hasColumn(column)) {
          throw new TypeError(`${repository.name} expected UNIQUE constraint references unknown column ${column}.`);
        }
      }
      if (!declaresUniqueConstraint(repository.schema, constraint.columns)) {
        throw new TypeError(`${repository.name} expected constraint is not a declared UNIQUE identity.`);
      }
      return { domain: constraint.domain, columns: [...constraint.columns] };
    })
  };
}
