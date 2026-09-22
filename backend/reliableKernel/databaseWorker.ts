import { createHash } from 'node:crypto';
import { compressionExecutionMetadata, readProviderRequestFailure } from '../../shared/compressionExecution';
import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parentPort, threadId, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { toSqliteFilePath } from './sqliteFilePath';
import type { RuntimeAllocatedSequence, RuntimeChange, RuntimeCommitResult, SnapshotBarrier } from './contracts';
import type { ContentObjectMetadata } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { createConversationRuntimeWorkProbe } from './conversationRuntimePendingWork';
import { executeConversationChildTaskSnapshot } from './childTaskFactsSnapshot';
import {
  deriveCommittedParentHandling,
  executeClientKeysetPage,
  executeClientProjectionSnapshot,
  executeClientVisibleMessageHistoryPage,
  executeConversationHistoryProjection,
  projectAnswerBridgeRecord,
  projectChildExecutionActivityRecord,
  projectCollaborationMessageRecord,
  projectCompressionBlockRecord,
  projectConversationCommandReceiptRecord,
  projectConversationContextStatusRecord,
  projectMessageWindowRecord,
  projectProcessRecord,
  projectQueuedTurnIntentRecord,
  projectTurnClientRecord,
  type ClientProjectionContentAccess
} from './clientProjection';
import {
  assertCurrentSchema,
  assertDatabaseBinding,
  configureReaderConnection,
  configureWriterConnection,
  initializeCurrentSchema,
  inspectDatabaseFoundation
} from './databaseSchema';
import {
  MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT,
  MODEL_STREAM_OUTPUT_DELTA_CHECKPOINT_LIMIT,
  MODEL_STREAM_TERMINAL_TAIL,
  type ChildConversationOriginCandidate,
  type ChildProcessCleanupMaterializationCandidate,
  type ContextContentMaterializationSnapshot,
  type ContextMaterializationRecord,
  type ContextMaterializationSnapshot,
  type ContextModelSource,
  type DatabaseWorkerData,
  type DatabaseWorkerDiagnostics,
  type DatabaseWorkerRequest,
  type DatabaseWorkerResponse,
  type ExecutionLeaseFencePayload,
  type EffectReceiptReconciliationCandidate,
  type ModelStreamActivityInput,
  type ModelStreamActivityResult,
  type ModelStreamEventCommitInput,
  type ModelStreamEventCommitResult,
  type ModelRequestCancelInput,
  type ModelRequestCancelResult,
  type ProcessOutputRegistrationMismatch,
  type SerializedWorkerError,
  type ToolFactsSnapshot
} from './databaseWorkerProtocol';
import {
  DOMAIN_REPOSITORIES,
  HISTORICAL_COPY_DOMAINS,
  assertRuntimeDomainUpdatePatch,
  type DomainRepository,
  type DomainRow,
  type EncodedRow,
  type RepositoryCheckpointPruneMutation,
  type RepositoryInsertMutation,
  type RepositoryListRead,
  type RepositoryMutation,
  type RepositoryRead,
  type RepositorySavepointOnError,
  type RepositoryTransactionStep
} from './repositories';
import {
  quote,
  requireEncodedId,
  requireNonNegativeIntegerString,
  requireRuntimeId,
  sqlText
} from './runtimeSqlRows';

const CONTEXT_CAS_CACHE_MAX_ENTRIES = 4_096;
const CONTEXT_CAS_CACHE_MAX_BYTES = 32 * 1024 * 1024;

interface VerifiedContextCasCacheEntry {
  id: string;
  sha256: string;
  byteLength: bigint;
  storageKey: string;
  bytes: Buffer;
}

/**
 * Context materialization repeatedly reads immutable CAS objects while compiling adjacent model
 * rounds. Keep only verified bytes in a strict LRU budget so 1000-node histories do not issue 1000
 * filesystem reads on every round. Entries never cross a worker/RootBinding lifetime, and callers
 * receive copies in the packed transfer buffer rather than mutable cache Buffers.
 */
class VerifiedContextCasCache {
  private readonly entries = new Map<string, VerifiedContextCasCacheEntry>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  public read(metadata: DomainRow, resolvedCasRootPath: string): Buffer {
    const identity = contextCasIdentity(metadata);
    const cached = this.entries.get(identity.id);
    if (cached) {
      assertSameContextCasIdentity(cached, identity);
      this.entries.delete(identity.id);
      this.entries.set(identity.id, cached);
      this.hits += 1;
      return cached.bytes;
    }
    this.misses += 1;
    const bytes = readVerifiedCasBytes(metadata, resolvedCasRootPath);
    if (bytes.length <= CONTEXT_CAS_CACHE_MAX_BYTES) {
      while (
        this.entries.size >= CONTEXT_CAS_CACHE_MAX_ENTRIES
        || this.totalBytes + bytes.length > CONTEXT_CAS_CACHE_MAX_BYTES
      ) {
        const oldestId = this.entries.keys().next().value as string | undefined;
        if (!oldestId) break;
        const oldest = this.entries.get(oldestId);
        this.entries.delete(oldestId);
        if (oldest) this.totalBytes -= oldest.bytes.length;
        this.evictions += 1;
      }
      const entry: VerifiedContextCasCacheEntry = { ...identity, bytes };
      this.entries.set(identity.id, entry);
      this.totalBytes += bytes.length;
    }
    return bytes;
  }

  public inspect(): DatabaseWorkerDiagnostics['contextCasCache'] {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      maxEntries: CONTEXT_CAS_CACHE_MAX_ENTRIES,
      maxBytes: CONTEXT_CAS_CACHE_MAX_BYTES,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions
    };
  }
}

const port = requireParentPort();
const data = workerData as DatabaseWorkerData;

/**
 * Bounded verified-CAS read capability handed to the client projection module. The worker keeps
 * ownership of the CAS root, digest verification and the context cache; projection never resolves
 * paths itself.
 */
const clientProjectionContent: ClientProjectionContentAccess = {
  readVerifiedBytes: (metadata) => readVerifiedCasBytes(metadata, path.resolve(data.binding.paths.casRootPath))
};

void start().catch((error) => {
  post({ type: 'fatal', error: serializeError(error) });
  process.exitCode = 1;
});

async function start(): Promise<void> {
  if (data.mode === 'initialize') {
    await mkdir(data.binding.paths.casRootPath, { recursive: false });
    const database = new Database(toSqliteFilePath(data.binding.paths.databasePath), { fileMustExist: false });
    try {
      configureWriterConnection(database);
      initializeCurrentSchema(database, data.binding);
    } finally {
      database.close();
    }
    post({ type: 'ready', workerThreadId: threadId, mode: data.mode });
    port.close();
    return;
  }

  const writer = new Database(toSqliteFilePath(data.binding.paths.databasePath), { fileMustExist: true });
  configureWriterConnection(writer);
  assertCurrentSchema(writer, data.binding);
  configureTransactionChangeCapture(writer);
  const reader = new Database(toSqliteFilePath(data.binding.paths.databasePath), { readonly: true, fileMustExist: true });
  configureReaderConnection(reader);
  let commitSeq = 0n;
  let closed = false;
  const contextCasCache = new VerifiedContextCasCache();
  const conversationRuntimeWork = createConversationRuntimeWorkProbe(reader);

  post({ type: 'ready', workerThreadId: threadId, mode: data.mode });
  port.on('message', (request: DatabaseWorkerRequest) => {
    if (closed) return;
    const receivedAtMs = Number.isFinite(request.metricEnqueuedAtMs)
      ? performance.now()
      : undefined;
    const respond = (
      response: Extract<DatabaseWorkerResponse, { type: 'response' }>,
      transferList: readonly ArrayBuffer[] = []
    ) => postMeasuredResponse(response, request.metricEnqueuedAtMs, receivedAtMs, transferList);
    try {
      if (request.kind === 'transaction') {
        assertDatabaseBinding(writer, data.binding);
        const result = executeTransaction(writer, request.steps, commitSeq + 1n);
        commitSeq += 1n;
        post({ type: 'commit', result });
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'snapshot') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeSnapshot(reader, request.reads, commitSeq);
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'snapshotAll') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeSnapshotAll(reader, request.read, commitSeq);
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'toolFactsSnapshot') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeToolFactsSnapshot(reader, request.toolCallId, commitSeq);
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'conversationChildTaskSnapshot') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeConversationChildTaskSnapshot(
          reader, request.conversationId, commitSeq, executeRead, clientProjectionContent.readVerifiedBytes
        );
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'processOutputRegistrationMismatches') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeProcessOutputRegistrationMismatches(reader);
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'effectReceiptReconciliationCandidates') {
        assertDatabaseBinding(reader, data.binding);
        respond({ type: 'response', id: request.id, ok: true, result: executeEffectReceiptReconciliationCandidates(reader) });
        return;
      }
      if (request.kind === 'childConversationOriginCandidates') {
        assertDatabaseBinding(reader, data.binding);
        respond({ type: 'response', id: request.id, ok: true, result: executeChildConversationOriginCandidates(reader) });
        return;
      }
      if (request.kind === 'childProcessCleanupMaterializationCandidates') {
        assertDatabaseBinding(reader, data.binding);
        respond({ type: 'response', id: request.id, ok: true, result: executeChildProcessCleanupMaterializationCandidates(reader) });
        return;
      }
      if (request.kind === 'conversationRuntimeWork') {
        assertDatabaseBinding(reader, data.binding);
        const result = conversationRuntimeWork(requireRuntimeId(request.conversationId));
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'contextMaterialization') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeContextMaterialization(reader, request.rootId, commitSeq);
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'contextContentMaterialization') {
        assertDatabaseBinding(reader, data.binding);
        const structure = executeContextMaterialization(reader, request.rootId, commitSeq);
        const attached = attachContextContent(structure, data.binding.paths.casRootPath, contextCasCache);
        respond({ type: 'response', id: request.id, ok: true, result: attached.result }, attached.transferList);
        return;
      }
      if (request.kind === 'modelStreamEvent') {
        assertDatabaseBinding(writer, data.binding);
        const result = executeModelStreamEvent(writer, request.input, commitSeq + 1n);
        if (result.commit) {
          commitSeq += 1n;
          post({ type: 'commit', result: result.commit });
        }
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'modelStreamActivity') {
        assertDatabaseBinding(writer, data.binding);
        const result = executeModelStreamActivity(writer, request.input, commitSeq + 1n);
        if (result.commit) {
          commitSeq += 1n;
          post({ type: 'commit', result: result.commit });
        }
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'cancelCurrentModelRequest') {
        assertDatabaseBinding(writer, data.binding);
        const result = executeCancelCurrentModelRequest(writer, request.input, commitSeq + 1n);
        if (result.commit) {
          commitSeq += 1n;
          post({ type: 'commit', result: result.commit });
        }
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'clientProjectionSnapshot') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeClientProjectionSnapshot(
          reader,
          request.activeConversationId,
          commitSeq,
          clientProjectionContent
        );
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'clientKeysetPage') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeClientKeysetPage(reader, request.input);
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'clientVisibleMessageHistoryPage') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeClientVisibleMessageHistoryPage(reader, request.input, clientProjectionContent);
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'conversationHistoryProjection') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeConversationHistoryProjection(reader, request.input, commitSeq);
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'externalDataVersion') {
        assertDatabaseBinding(writer, data.binding);
        // SQLite changes this connection-local value only when another connection commits.
        // Reading it from the writer (rather than the separate reader) therefore excludes every
        // commit made by this RuntimeDatabase worker while still detecting other Extension Hosts.
        const result = BigInt(writer.pragma('data_version', { simple: true }) as number | bigint).toString();
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'inspect') {
        assertDatabaseBinding(writer, data.binding);
        const result: DatabaseWorkerDiagnostics = {
          ...inspectDatabaseFoundation(writer),
          workerThreadId: threadId,
          hostBootId: data.hostBootId,
          writerConnectionCount: 1,
          readerConnectionCount: 1,
          readerJournalMode: String(reader.pragma('journal_mode', { simple: true })),
          readerForeignKeys: BigInt(reader.pragma('foreign_keys', { simple: true }) as number | bigint),
          readerBusyTimeoutMs: BigInt(reader.pragma('busy_timeout', { simple: true }) as number | bigint),
          currentCommitSeq: commitSeq.toString(),
          contextCasCache: contextCasCache.inspect()
        };
        respond({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      assertDatabaseBinding(writer, data.binding);
      closed = true;
      reader.close();
      writer.close();
      respond({ type: 'response', id: request.id, ok: true, result: null });
      port.close();
    } catch (error) {
      respond({ type: 'response', id: request.id, ok: false, error: serializeError(error) });
    }
  });
}

function configureTransactionChangeCapture(database: Database.Database): void {
  database.exec(`
    CREATE TEMP TABLE runtime_transaction_change (
      sequence INTEGER PRIMARY KEY,
      domain TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('upsert', 'remove'))
    )
  `);
  for (const schema of DOMAIN_REPOSITORIES.all().map((repository) => repository.schema)) {
    if (schema.client === 'none') continue;
    const domain = sqlText(schema.key);
    for (const operation of ['insert', 'update', 'delete'] as const) {
      const row = operation === 'delete' ? 'OLD' : 'NEW';
      const kind = operation === 'delete' ? 'remove' : 'upsert';
      database.exec(`
        CREATE TEMP TRIGGER ${quote(`capture_${schema.table}_${operation}`)}
        AFTER ${operation.toUpperCase()} ON ${quote(schema.table)}
        BEGIN
          INSERT INTO runtime_transaction_change (domain, id, kind)
          VALUES (${domain}, ${row}.id, '${kind}');
        END
      `);
    }
  }

  // Message 是独立事实，conversation membership/current revision 也是独立 Link。Link 改变时
  // 重新投影 Message 窗口记录；尚未组成完整窗口的 Message 只产生幂等 remove，不阻塞写事务。
  for (const relation of [
    { table: 'message_part_of_conversation', messageColumn: 'message_id' },
    { table: 'message_current_revision_link', messageColumn: 'message_id' }
  ]) {
    for (const operation of ['insert', 'update', 'delete'] as const) {
      const row = operation === 'delete' ? 'OLD' : 'NEW';
      const kind = operation === 'delete' ? 'remove' : 'upsert';
      database.exec(`
        CREATE TEMP TRIGGER ${quote(`capture_message_from_${relation.table}_${operation}`)}
        AFTER ${operation.toUpperCase()} ON ${quote(relation.table)}
        BEGIN
          INSERT INTO runtime_transaction_change (domain, id, kind)
          VALUES ('Message', ${row}.${quote(relation.messageColumn)}, '${kind}');
        END
      `);
    }
  }

  // RuntimeDeliveryInputLink 本身不是客户端领域；它改变的是 RuntimeDelivery 的派生
  // parent_handling_state，因此在同一 commit 中重新投影对应 Delivery。
  for (const operation of ['insert', 'update'] as const) {
    database.exec(`
      CREATE TEMP TRIGGER ${quote(`capture_runtime_delivery_from_input_link_${operation}`)}
      AFTER ${operation.toUpperCase()} ON runtime_delivery_input_link
      BEGIN
        INSERT INTO runtime_transaction_change (domain, id, kind)
        VALUES ('RuntimeDelivery', NEW.delivery_id, 'upsert');
      END
    `);
  }

  // ConversationContextHeadLink keeps its persisted client=none mapping. Its bounded current-root
  // summary is an independent derived view, captured transactionally like Message window and
  // RuntimeDelivery parent state without adding a second mutable authority.
  for (const operation of ['insert', 'update', 'delete'] as const) {
    const row = operation === 'delete' ? 'OLD' : 'NEW';
    const kind = operation === 'delete' ? 'remove' : 'upsert';
    database.exec(`
      CREATE TEMP TRIGGER ${quote(`capture_context_status_from_head_${operation}`)}
      AFTER ${operation.toUpperCase()} ON conversation_context_head_link
      BEGIN
        INSERT INTO runtime_transaction_change (domain, id, kind)
        VALUES ('ConversationContextStatus', ${row}.id, '${kind}');
      END
      `);
  }

  // CommandReceipt remains an internal epoch domain. The Webview receives only this narrow,
  // conversation-scoped derived fact so a lost one-shot TurnInputResult can still converge from
  // the durable Feed. Internal/callback/recovery source keys are never projected.
  database.exec(`
    CREATE TEMP TRIGGER capture_conversation_command_receipt_insert
    AFTER INSERT ON command_receipt
    WHEN NEW.source_kind = 'command' AND NEW.conversation_id IS NOT NULL
    BEGIN
      INSERT INTO runtime_transaction_change (domain, id, kind)
      VALUES ('ConversationCommandReceipt', NEW.id, 'upsert');
    END
  `);

  // Child ToolCall/ModelRequest rows stay isolated from the parent Conversation feed. Instead,
  // changes to the active child generation re-project one bounded, non-authoritative activity row
  // keyed by ChildExecution. This gives the parent UI live progress without merging transcripts.
  for (const table of ['tool_call', 'model_request'] as const) {
    for (const operation of ['insert', 'update'] as const) {
      database.exec(`
        CREATE TEMP TRIGGER ${quote(`capture_child_activity_from_${table}_${operation}`)}
        AFTER ${operation.toUpperCase()} ON ${quote(table)}
        BEGIN
          INSERT INTO runtime_transaction_change (domain, id, kind)
          SELECT 'ChildExecutionActivity', membership.child_execution_id, 'upsert'
            FROM child_execution_turn_link AS membership
           WHERE membership.turn_id = NEW.turn_id;
        END
      `);
    }
  }
  for (const operation of ['insert', 'update'] as const) {
    database.exec(`
      CREATE TEMP TRIGGER ${quote(`capture_child_activity_from_execution_${operation}`)}
      AFTER ${operation.toUpperCase()} ON child_execution
      BEGIN
        INSERT INTO runtime_transaction_change (domain, id, kind)
        VALUES ('ChildExecutionActivity', NEW.id, 'upsert');
      END
    `);
  }
  database.exec(`
    CREATE TEMP TRIGGER capture_child_activity_from_execution_delete
    AFTER DELETE ON child_execution
    BEGIN
      INSERT INTO runtime_transaction_change (domain, id, kind)
      VALUES ('ChildExecutionActivity', OLD.id, 'remove');
    END
  `);
  for (const operation of ['insert', 'update', 'delete'] as const) {
    const row = operation === 'delete' ? 'OLD' : 'NEW';
    database.exec(`
      CREATE TEMP TRIGGER ${quote(`capture_child_activity_from_active_turn_${operation}`)}
      AFTER ${operation.toUpperCase()} ON child_execution_active_turn_link
      BEGIN
        INSERT INTO runtime_transaction_change (domain, id, kind)
        VALUES ('ChildExecutionActivity', ${row}.child_execution_id, 'upsert');
      END
    `);
  }
}

function readTransactionChanges(database: Database.Database): RuntimeChange[] {
  const rows = database.prepare(`
    SELECT current.sequence, current.domain, current.id, current.kind
      FROM runtime_transaction_change AS current
      JOIN (
        SELECT domain, id, MAX(sequence) AS sequence
          FROM runtime_transaction_change
         GROUP BY domain, id
      ) AS latest
        ON latest.sequence = current.sequence
     ORDER BY current.sequence
  `).all() as Array<{ sequence: bigint; domain: string; id: string; kind: 'upsert' | 'remove' }>;
  const topology = new Map(DOMAIN_REPOSITORIES.all().map((repository, index) => [repository.schema.key, index]));
  topology.set('ConversationContextStatus', topology.size);
  topology.set('ConversationCommandReceipt', topology.size);
  topology.set('ChildExecutionActivity', topology.size);
  return rows
    .map((row) => {
      if (row.domain === 'ChildExecutionActivity') {
        if (row.kind === 'remove') return { ...row };
        const record = projectChildExecutionActivityRecord(database, row.id, clientProjectionContent);
        return record
          ? { ...row, kind: 'upsert' as const, record }
          : { ...row, kind: 'remove' as const };
      }
      if (row.kind === 'remove') return { ...row };
      if (row.domain === 'ConversationContextStatus') {
        return { ...row, record: projectConversationContextStatusRecord(database, row.id) };
      }
      if (row.domain === 'ConversationCommandReceipt') {
        return { ...row, record: projectConversationCommandReceiptRecord(database, row.id) };
      }
      const repository = DOMAIN_REPOSITORIES.domain(row.domain);
      const raw = database.prepare(`SELECT * FROM ${quote(repository.schema.table)} WHERE id = ?`).get(row.id);
      if (!raw) throw new Error(`Committed upsert projection ${row.domain}/${row.id} is missing.`);
      let record = repository.codec.decode(raw as Record<string, unknown>);
      if (row.domain === 'TurnIntent') {
        const projected = projectQueuedTurnIntentRecord(database, row.id);
        if (!projected) return { ...row, kind: 'remove' as const };
        record = projected;
      }
      if (row.domain === 'Turn') {
        record = projectTurnClientRecord(database, row.id, clientProjectionContent);
      }
      if (row.domain === 'Message') {
        const projected = projectMessageWindowRecord(database, row.id);
        if (!projected) return { ...row, kind: 'remove' as const };
        record = projected;
      }
      if (row.domain === 'CompressionBlock') {
        record = projectCompressionBlockRecord(database, row.id);
      }
      if (row.domain === 'AnswerBridge') {
        record = projectAnswerBridgeRecord(database, row.id);
      }
      if (row.domain === 'Process') {
        record = projectProcessRecord(database, row.id, clientProjectionContent);
      }
      if (row.domain === 'CollaborationMessage') {
        record = projectCollaborationMessageRecord(database, row.id, clientProjectionContent);
      }
      if (row.domain === 'RuntimeDelivery') {
        const links = database.prepare(`
          SELECT handled_at
            FROM runtime_delivery_input_link
           WHERE delivery_id = ?
           LIMIT 2
        `).all(row.id) as Array<{ handled_at: string | null }>;
        if (links.length > 1) throw new Error(`RuntimeDelivery ${row.id} has multiple input links.`);
        record.parent_handling_state = deriveCommittedParentHandling(record, links[0] ?? null);
      }
      return { ...row, record };
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'remove' ? -1 : 1;
      const leftOrder = topology.get(left.domain);
      const rightOrder = topology.get(right.domain);
      if (leftOrder === undefined || rightOrder === undefined) throw new Error('Runtime change references an unknown domain.');
      const dependencyOrder = left.kind === 'remove' ? rightOrder - leftOrder : leftOrder - rightOrder;
      if (dependencyOrder !== 0) return dependencyOrder;
      return left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0;
    })
    .map(({ sequence: _sequence, ...change }) => change);
}

function executeTransaction(
  database: Database.Database,
  steps: RepositoryTransactionStep[],
  nextCommitSeq: bigint
): RuntimeCommitResult {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('Runtime transaction requires at least one Repository step.');
  const allocatedSequences: RuntimeAllocatedSequence[] = [];
  let changes: RuntimeChange[] = [];
  database.exec('BEGIN IMMEDIATE');

  try {
    database.exec('DELETE FROM temp.runtime_transaction_change');
    executeSteps(database, steps, allocatedSequences);
    assertTouchedRuntimeAggregates(database, steps);
    changes = readTransactionChanges(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { commitSeq: nextCommitSeq.toString(), changes, allocatedSequences };
}


function executeModelStreamEvent(
  database: Database.Database,
  input: ModelStreamEventCommitInput,
  nextCommitSeq: bigint
): ModelStreamEventCommitResult {
  const modelRequestId = requireRuntimeId(input.modelRequestId);
  const checkpointId = requireRuntimeId(input.checkpointId);
  const attemptSeq = requirePositiveInteger(input.attemptSeq, 'ModelStreamEvent.attemptSeq');
  const socketGeneration = requirePositiveInteger(input.socketGeneration, 'ModelStreamEvent.socketGeneration');
  const streamSeq = requirePositiveInteger(input.streamSeq, 'ModelStreamEvent.streamSeq');
  if (!['output_delta', 'output_item_done', 'native_control', 'native_tool_call', 'partial_summary', 'terminal_summary'].includes(input.checkpointKind)) {
    throw new TypeError(`Unsupported ModelStream checkpoint kind: ${String(input.checkpointKind)}`);
  }
  if (typeof input.now !== 'string' || input.now.length === 0) throw new TypeError('ModelStreamEvent.now must be non-empty.');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM temp.runtime_transaction_change');
    assertExecutionLeaseFence(database, input.executionFence);
    const requestRaw = database.prepare('SELECT * FROM model_request WHERE id = ?').get(modelRequestId);
    if (!requestRaw) throw new Error(`ModelRequest ${modelRequestId} does not exist.`);
    const request = DOMAIN_REPOSITORIES.codec('ModelRequest').decode(requestRaw as Record<string, unknown>);
    const existing = database.prepare(
      'SELECT model_request_id, attempt_seq, socket_generation, stream_seq, checkpoint_kind, content_object_id '
        + 'FROM model_stream_checkpoint WHERE id = ? LIMIT 1'
    ).get(checkpointId) as {
      model_request_id?: unknown;
      attempt_seq?: unknown;
      socket_generation?: unknown;
      stream_seq?: unknown;
      checkpoint_kind?: unknown;
      content_object_id?: unknown;
    } | undefined;
    if (existing) {
      if (
        existing.model_request_id !== modelRequestId
        || existing.attempt_seq !== attemptSeq
        || existing.socket_generation !== socketGeneration
        || existing.stream_seq !== streamSeq
        || existing.checkpoint_kind !== input.checkpointKind
        || existing.content_object_id !== input.contentObject.id
      ) {
        const error = new Error(`ModelStream checkpoint ${checkpointId} conflicts with an existing event identity.`) as Error & {
          code: string;
        };
        error.code = 'MODEL_STREAM_IDEMPOTENCY_CONFLICT';
        throw error;
      }
      database.exec('ROLLBACK');
      return {
        accepted: false,
        checkpointed: false,
        terminal: request.status === 'terminal',
        ignoredReason: 'duplicate'
      };
    }
    const fence = database.prepare(
      'SELECT id FROM model_stream_fence WHERE model_request_id = ? LIMIT 1'
    ).get(modelRequestId);
    const turn = database.prepare('SELECT status FROM turn WHERE id = ?').get(request.turn_id) as { status?: unknown } | undefined;
    if (fence || request.status === 'terminal' || turn?.status !== 'active') {
      database.exec('ROLLBACK');
      return { accepted: false, checkpointed: false, terminal: true, ignoredReason: 'terminal' };
    }
    if (request.status !== 'streaming') throw new Error(`ModelRequest ${modelRequestId} is not streaming.`);
    const identity = decodeModelStreamIdentity(request.stream_stats_json);
    if (identity.attemptSeq !== attemptSeq) {
      database.exec('ROLLBACK');
      return { accepted: false, checkpointed: false, terminal: false, ignoredReason: 'old-attempt' };
    }
    if (identity.socketGeneration !== socketGeneration) {
      database.exec('ROLLBACK');
      return { accepted: false, checkpointed: false, terminal: false, ignoredReason: 'old-socket-generation' };
    }
    if (input.checkpointKind === 'output_delta' || input.checkpointKind === 'output_item_done') {
      const checkpointCountRow = database.prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(CASE WHEN checkpoint_kind = 'output_delta' THEN 1 ELSE 0 END), 0) AS output_delta_count
          FROM model_stream_checkpoint
         WHERE model_request_id = ? AND checkpoint_kind NOT IN ('native_control', 'native_tool_call')
      `).get(modelRequestId) as { count: bigint; output_delta_count: bigint };
      if (
        typeof checkpointCountRow.count !== 'bigint'
        || typeof checkpointCountRow.output_delta_count !== 'bigint'
      ) throw new Error('ModelStream checkpoint counts were not INTEGER values.');
      if (
        (input.checkpointKind === 'output_delta'
          && checkpointCountRow.output_delta_count >= BigInt(MODEL_STREAM_OUTPUT_DELTA_CHECKPOINT_LIMIT))
        || (input.checkpointKind === 'output_item_done'
          && checkpointCountRow.count >= BigInt(MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT))
      ) {
        database.exec('ROLLBACK');
        return {
          accepted: true,
          checkpointed: false,
          terminal: false,
          ignoredReason: 'checkpoint-capacity'
        };
      }
    }
    const contentId = requireRuntimeId(input.contentObject.id);
    assertPreparedContentInsert(input.contentObject, input.contentInsert);
    const contentSteps: RepositoryTransactionStep[] = preparedContentObjectSteps([{
      metadata: input.contentObject as ContentObjectMetadata,
      ...(input.contentInsert ? { insert: input.contentInsert } : {})
    }], 'model_stream_content');
    executeSteps(database, contentSteps, []);
    insertStreamFact(database, 'ModelStreamCheckpoint', {
      id: checkpointId,
      model_request_id: modelRequestId,
      attempt_seq: attemptSeq,
      socket_generation: socketGeneration,
      stream_seq: streamSeq,
      checkpoint_kind: input.checkpointKind,
      content_object_id: contentId,
      created_at: input.now
    });
    if (input.checkpointKind === 'terminal_summary') {
      const terminalFenceId = requireRuntimeId(input.terminalFenceId);
      if (!input.terminalStats || typeof input.terminalStats !== 'object' || Array.isArray(input.terminalStats)) {
        throw new TypeError('Completed ModelStream event requires terminalStats.');
      }
      const terminalIdentity = decodeModelStreamIdentity(input.terminalStats);
      if (terminalIdentity.attemptSeq !== attemptSeq || terminalIdentity.socketGeneration !== socketGeneration) {
        throw new Error('Completed ModelStream terminalStats do not match the active stream identity.');
      }
      const operation = database.prepare(
        "SELECT id FROM operation WHERE owner_kind = 'model_request' AND owner_id = ? LIMIT 1"
      ).get(modelRequestId) as { id?: unknown } | undefined;
      if (typeof operation?.id !== 'string') throw new Error(`ModelRequest ${modelRequestId} has no Operation.`);
      const attempt = database.prepare(
        'SELECT id FROM attempt WHERE operation_id = ? AND attempt_seq = ? LIMIT 1'
      ).get(operation.id, attemptSeq) as { id?: unknown } | undefined;
      if (typeof attempt?.id !== 'string') throw new Error(`ModelRequest ${modelRequestId} has no attempt ${attemptSeq}.`);
      insertStreamFact(database, 'ModelStreamFence', {
        id: terminalFenceId,
        model_request_id: modelRequestId,
        attempt_seq: attemptSeq,
        socket_generation: socketGeneration,
        terminal_stream_seq: streamSeq,
        outcome: 'completed',
        created_at: input.now
      });
      executeSteps(database, [
        DOMAIN_REPOSITORIES.domain('Attempt').update(attempt.id, {
          status: 'completed', updated_at: input.now, completed_at: input.now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operation.id, {
          status: 'completed', updated_at: input.now
        }),
        DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
          status: 'terminal',
          terminal_state: 'completed',
          usage_json: input.usage,
          stream_stats_json: input.terminalStats,
          updated_at: input.now
        })
      ], []);
      executeSteps(database, [
        DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').pruneAfterTerminalFence(
          modelRequestId,
          attemptSeq,
          socketGeneration,
          checkpointId
        )
      ], []);
      assertModelRequestAggregate(database, modelRequestId);
    } else {
      if (input.terminalFenceId !== null || input.terminalStats !== null || input.usage !== null) {
        throw new TypeError('Non-terminal ModelStream event cannot carry terminal facts.');
      }
    }
    const changes = readTransactionChanges(database);
    database.exec('COMMIT');
    const commit: RuntimeCommitResult = {
      commitSeq: nextCommitSeq.toString(),
      changes,
      allocatedSequences: []
    };
    return {
      accepted: true,
      checkpointed: true,
      terminal: input.checkpointKind === 'terminal_summary',
      commit
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function executeModelStreamActivity(
  database: Database.Database,
  input: ModelStreamActivityInput,
  nextCommitSeq: bigint
): ModelStreamActivityResult {
  const modelRequestId = requireRuntimeId(input.modelRequestId);
  const attemptSeq = requirePositiveInteger(input.attemptSeq, 'ModelStreamActivity.attemptSeq');
  const socketGeneration = requirePositiveInteger(input.socketGeneration, 'ModelStreamActivity.socketGeneration');
  const streamSeq = requirePositiveInteger(input.streamSeq, 'ModelStreamActivity.streamSeq');
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt <= 0) {
    throw new TypeError('ModelStreamActivity.observedAt must be a positive safe integer.');
  }
  if (typeof input.now !== 'string' || input.now.length === 0) {
    throw new TypeError('ModelStreamActivity.now must be non-empty.');
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM temp.runtime_transaction_change');
    assertExecutionLeaseFence(database, input.executionFence);
    const requestRaw = database.prepare('SELECT * FROM model_request WHERE id = ?').get(modelRequestId);
    if (!requestRaw) throw new Error(`ModelRequest ${modelRequestId} does not exist.`);
    const request = DOMAIN_REPOSITORIES.codec('ModelRequest').decode(requestRaw as Record<string, unknown>);
    const fence = database.prepare(
      'SELECT id FROM model_stream_fence WHERE model_request_id = ? LIMIT 1'
    ).get(modelRequestId);
    const turn = database.prepare('SELECT status FROM turn WHERE id = ?').get(request.turn_id) as { status?: unknown } | undefined;
    if (fence || request.status === 'terminal' || turn?.status !== 'active') {
      database.exec('ROLLBACK');
      return { accepted: false, terminal: true };
    }
    if (request.status !== 'streaming') {
      database.exec('ROLLBACK');
      return { accepted: false, terminal: false };
    }
    const identity = decodeModelStreamIdentity(request.stream_stats_json);
    if (identity.attemptSeq !== attemptSeq || identity.socketGeneration !== socketGeneration) {
      database.exec('ROLLBACK');
      return { accepted: false, terminal: false };
    }
    const stats = request.stream_stats_json as Record<string, unknown>;
    const previousSeq = optionalDecimalInteger(stats.lastStreamSeq, 'lastStreamSeq') ?? 0n;
    const previousAt = optionalPositiveInteger(stats.lastStreamEventAt, 'lastStreamEventAt') ?? 0;
    const nextSeq = streamSeq > previousSeq ? streamSeq : previousSeq;
    const nextAt = input.observedAt > previousAt ? input.observedAt : previousAt;
    if (nextSeq === previousSeq && nextAt === previousAt) {
      database.exec('ROLLBACK');
      return { accepted: false, terminal: false };
    }
    executeSteps(database, [
      DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
        status: 'streaming',
        stream_stats_json: {
          ...stats,
          lastStreamSeq: nextSeq.toString(),
          lastStreamEventAt: nextAt
        },
        updated_at: input.now
      })
    ], []);
    const changes = readTransactionChanges(database);
    database.exec('COMMIT');
    return {
      accepted: true,
      terminal: false,
      commit: { commitSeq: nextCommitSeq.toString(), changes, allocatedSequences: [] }
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function executeCancelCurrentModelRequest(
  database: Database.Database,
  input: ModelRequestCancelInput,
  nextCommitSeq: bigint
): ModelRequestCancelResult {
  const modelRequestId = requireRuntimeId(input.modelRequestId);
  if (typeof input.terminalState !== 'string' || input.terminalState.length === 0) {
    throw new TypeError('ModelRequest cancellation terminalState must be non-empty.');
  }
  if (typeof input.now !== 'string' || input.now.length === 0) {
    throw new TypeError('ModelRequest cancellation time must be non-empty.');
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM temp.runtime_transaction_change');
    assertExecutionLeaseFence(database, input.executionFence);
    const requestRaw = database.prepare('SELECT * FROM model_request WHERE id = ?').get(modelRequestId);
    if (!requestRaw) throw new Error(`ModelRequest ${modelRequestId} does not exist.`);
    const request = DOMAIN_REPOSITORIES.codec('ModelRequest').decode(requestRaw as Record<string, unknown>);
    const identity = decodeModelStreamIdentity(request.stream_stats_json);
    if (request.status === 'terminal') {
      database.exec('ROLLBACK');
      return {
        cancelled: false,
        terminalState: typeof request.terminal_state === 'string' ? request.terminal_state : null,
        attemptSeq: identity.attemptSeq.toString(),
        socketGeneration: identity.socketGeneration.toString()
      };
    }
    const fence = database.prepare(
      'SELECT id FROM model_stream_fence WHERE model_request_id = ? LIMIT 1'
    ).get(modelRequestId);
    if (fence) throw new Error(`Active ModelRequest ${modelRequestId} unexpectedly has a terminal fence.`);
    const operation = database.prepare(
      "SELECT id FROM operation WHERE owner_kind = 'model_request' AND owner_id = ? LIMIT 1"
    ).get(modelRequestId) as { id?: unknown } | undefined;
    if (typeof operation?.id !== 'string') throw new Error(`ModelRequest ${modelRequestId} has no Operation.`);
    const attempt = database.prepare(
      'SELECT id FROM attempt WHERE operation_id = ? AND attempt_seq = ? LIMIT 1'
    ).get(operation.id, identity.attemptSeq) as { id?: unknown } | undefined;
    if (typeof attempt?.id !== 'string') {
      throw new Error(`ModelRequest ${modelRequestId} has no current attempt ${identity.attemptSeq}.`);
    }
    executeSteps(database, [
      DOMAIN_REPOSITORIES.domain('Attempt').update(attempt.id, {
        status: 'cancelled', updated_at: input.now, completed_at: input.now
      }),
      DOMAIN_REPOSITORIES.domain('Operation').update(operation.id, {
        status: 'cancelled', updated_at: input.now
      }),
      DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
        status: 'terminal', terminal_state: input.terminalState, updated_at: input.now
      })
    ], []);
    assertModelRequestAggregate(database, modelRequestId);
    const changes = readTransactionChanges(database);
    database.exec('COMMIT');
    const commit: RuntimeCommitResult = {
      commitSeq: nextCommitSeq.toString(),
      changes,
      allocatedSequences: []
    };
    return {
      cancelled: true,
      terminalState: input.terminalState,
      attemptSeq: identity.attemptSeq.toString(),
      socketGeneration: identity.socketGeneration.toString(),
      commit
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function assertExecutionLeaseFence(
  database: Database.Database,
  fence: ExecutionLeaseFencePayload | undefined
): void {
  if (!fence) return;
  const id = requireRuntimeId(fence.id);
  const conversationId = requireRuntimeId(fence.conversationId);
  const turnId = requireRuntimeId(fence.turnId);
  const ownerId = requireRuntimeId(fence.ownerId);
  const hostBootId = requireRuntimeId(fence.hostBootId);
  const generation = requirePositiveInteger(fence.generation, 'ExecutionLeaseFence.generation');
  const row = database.prepare(
    'SELECT 1 AS present FROM execution_lease '
      + 'WHERE id = ? AND conversation_id = ? AND turn_id = ? AND owner_id = ? '
      + 'AND host_boot_id = ? AND generation = ? LIMIT 1'
  ).get(id, conversationId, turnId, ownerId, hostBootId, generation);
  if (row) return;
  const error = new Error(`ExecutionLease ${id} generation ${generation} no longer authorizes this write.`) as Error & {
    code: string;
  };
  error.code = 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
  throw error;
}

const NATIVE_CAPABILITY_FIELDS: Readonly<Record<string, true>> = {
  asyncTools: true,
  steering: true,
  reasoningUpdates: true,
  multiplexing: true,
  explicitCaching: true
};

function decodeModelStreamIdentity(value: unknown): {
  attemptSeq: bigint;
  socketGeneration: bigint;
  retryMaxAttempts?: number;
  retryDelayMs?: number;
  retryNotBeforeAt?: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('ModelRequest.stream_stats_json must be an object.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const allowedKeys = new Set([
    'attemptSeq',
    'socketGeneration',
    'retryReason',
    'retryMaxAttempts',
    'retryDelayMs',
    'retryNotBeforeAt',
    'providerStartedAt',
    'firstOutputAt',
    'completedAt',
    'streamOutputDurationMs',
    'lastStreamSeq',
    'lastStreamEventAt',
    'nativeCapabilities',
    'thinkingSelection',
    'nativeInitialPromptTokenCount',
    'compressionPurpose',
    'compressionDecision',
    'failure'
  ]);
  if (
    !keys.includes('attemptSeq')
    || !keys.includes('retryReason')
    || !keys.includes('socketGeneration')
    || keys.some((key) => !allowedKeys.has(key))
    || (
      record.retryReason !== null
      && record.retryReason !== 'connection_interrupted'
      && record.retryReason !== 'rate_limited'
      && record.retryReason !== 'temporary_service_error'
      && record.retryReason !== 'first_semantic_timeout'
      && record.retryReason !== 'stream_stalled'
      && record.retryReason !== 'compression_timeout'
    )
  ) throw new TypeError('ModelRequest.stream_stats_json has an invalid shape.');
  compressionExecutionMetadata(record);
  if (record.failure !== undefined) readProviderRequestFailure(record.failure);
  assertOptionalBoundedInteger(record.retryMaxAttempts, 'retryMaxAttempts', 1, 10);
  assertOptionalBoundedInteger(record.retryDelayMs, 'retryDelayMs', 0, Number.MAX_SAFE_INTEGER);
  assertOptionalBoundedInteger(record.retryNotBeforeAt, 'retryNotBeforeAt', 1, Number.MAX_SAFE_INTEGER);
  const attemptSeq = decimalRuntimeInteger(record.attemptSeq, 'stream_stats.attemptSeq');
  const retryMaxAttempts = typeof record.retryMaxAttempts === 'number'
    ? record.retryMaxAttempts
    : attemptSeq === 2n ? 1 : undefined;
  const retryDelayMs = typeof record.retryDelayMs === 'number' ? record.retryDelayMs : undefined;
  const retryNotBeforeAt = typeof record.retryNotBeforeAt === 'number' ? record.retryNotBeforeAt : undefined;
  assertOptionalStreamTiming(record.providerStartedAt, 'providerStartedAt');
  assertOptionalStreamTiming(record.firstOutputAt, 'firstOutputAt');
  assertOptionalStreamTiming(record.completedAt, 'completedAt');
  assertOptionalStreamTiming(record.streamOutputDurationMs, 'streamOutputDurationMs', true);
  optionalDecimalInteger(record.lastStreamSeq, 'lastStreamSeq');
  optionalPositiveInteger(record.lastStreamEventAt, 'lastStreamEventAt');
  if (record.thinkingSelection !== undefined && (typeof record.thinkingSelection !== 'string' || record.thinkingSelection.length > 1024)) {
    throw new TypeError('ModelRequest.stream_stats_json.thinkingSelection must be a bounded string.');
  }
  optionalNonNegativeInteger(record.nativeInitialPromptTokenCount, 'nativeInitialPromptTokenCount');
  if (record.nativeCapabilities !== undefined) {
    const capabilities = record.nativeCapabilities;
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      throw new TypeError('ModelRequest.stream_stats_json.nativeCapabilities must be an object.');
    }
    const native = capabilities as Record<string, unknown>;
    for (const key of Object.keys(native)) {
      if (NATIVE_CAPABILITY_FIELDS[key] !== true) {
        throw new TypeError(`Unknown ModelRequest native capability ${key}.`);
      }
    }
    for (const key in NATIVE_CAPABILITY_FIELDS) {
      if (typeof native[key] !== 'boolean') {
        throw new TypeError(`ModelRequest native capability ${key} must be boolean.`);
      }
    }
  }
  return {
    attemptSeq,
    socketGeneration: decimalRuntimeInteger(record.socketGeneration, 'stream_stats.socketGeneration'),
    ...(retryMaxAttempts !== undefined ? { retryMaxAttempts } : {}),
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    ...(retryNotBeforeAt !== undefined ? { retryNotBeforeAt } : {})
  };
}

function optionalDecimalInteger(value: unknown, label: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`ModelRequest.stream_stats_json.${label} must be a decimal integer string.`);
  }
  return BigInt(value);
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  throw new TypeError(`ModelRequest.stream_stats_json.${label} must be a non-negative safe integer.`);
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  const parsed = optionalNonNegativeInteger(value, label);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) throw new TypeError(`ModelRequest.stream_stats_json.${label} must be positive.`);
  return parsed;
}

function assertOptionalBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`ModelRequest.stream_stats_json.${label} must be an integer in [${minimum}, ${maximum}].`);
  }
}

function assertOptionalStreamTiming(value: unknown, label: string, allowZero = false): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) <= 0)) {
    throw new TypeError(`ModelRequest.stream_stats_json.${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer.`);
  }
}

function decimalRuntimeInteger(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return BigInt(value);
}

function requirePositiveInteger(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n) throw new TypeError(`${label} must be a positive SQLite INTEGER.`);
  return value;
}

function executeSteps(
  database: Database.Database,
  steps: RepositoryTransactionStep[],
  allocatedSequences: RuntimeAllocatedSequence[]
): void {
  for (const step of steps) {
    if (step.kind === 'assert') {
      executeAssertion(database, step.domain, step.id, step.where);
      continue;
    }
    if (step.kind === 'assertAll') {
      executeAssertAll(database, step.domain, step.where, step.expected);
      continue;
    }
    if (step.kind === 'assertNone') {
      executeAssertNone(database, step.domain, step.where);
      continue;
    }
    if (step.kind === 'assertExactIds') {
      executeAssertExactIds(database, step.domain, step.where, step.expectedIds);
      continue;
    }
    if (step.kind !== 'savepoint') {
      executeMutation(database, step, allocatedSequences);
      continue;
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(step.name)) throw new Error(`Invalid savepoint name: ${step.name}`);
    const marker = quote(step.name);
    const sequenceCount = allocatedSequences.length;
    database.exec(`SAVEPOINT ${marker}`);
    try {
      executeSteps(database, step.steps, allocatedSequences);
      database.exec(`RELEASE SAVEPOINT ${marker}`);
    } catch (error) {
      database.exec(`ROLLBACK TO SAVEPOINT ${marker}`);
      database.exec(`RELEASE SAVEPOINT ${marker}`);
      allocatedSequences.length = sequenceCount;
      if (!matchesSavepointContinuation(error, step.onError)) throw error;
    }
  }
}

function executeAssertion(
  database: Database.Database,
  domain: string,
  id: string,
  where: DomainRow
): void {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const encoded = repository.codec.encodeWhere(where);
  const predicates = ['id = @__id'];
  const parameters: EncodedRow & { __id: string } = { __id: requireRuntimeId(id) };
  for (const [name, value] of Object.entries(encoded)) {
    if (name === 'id') throw new Error(`${repository.name} assertion id must be supplied separately.`);
    if (value === null) predicates.push(`${quote(name)} IS NULL`);
    else {
      predicates.push(`${quote(name)} = @${name}`);
      parameters[name] = value;
    }
  }
  const matched = database.prepare(
    `SELECT 1 AS matched FROM ${quote(repository.schema.table)} WHERE ${predicates.join(' AND ')} LIMIT 1`
  ).get(parameters);
  if (!matched) {
    const error = new Error(`${repository.name} transaction assertion failed for ${id}.`) as Error & { code: string };
    error.code = 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
    throw error;
  }
}

function executeAssertAll(
  database: Database.Database,
  domain: string,
  where: DomainRow,
  expected: DomainRow
): void {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const encodedWhere = repository.codec.encodeWhere(where);
  const encodedExpected = repository.codec.encodeWhere(expected);
  if (Object.keys(encodedExpected).length === 0) throw new Error(`${repository.name} assertAll requires expected fields.`);
  const predicates: string[] = [];
  const violations: string[] = [];
  const parameters: EncodedRow = {};
  for (const [name, value] of Object.entries(encodedWhere)) {
    if (value === null) predicates.push(`${quote(name)} IS NULL`);
    else {
      const parameter = `where_${name}`;
      predicates.push(`${quote(name)} = @${parameter}`);
      parameters[parameter] = value;
    }
  }
  for (const [name, value] of Object.entries(encodedExpected)) {
    if (value === null) violations.push(`${quote(name)} IS NOT NULL`);
    else {
      const parameter = `expected_${name}`;
      violations.push(`(${quote(name)} IS NULL OR ${quote(name)} != @${parameter})`);
      parameters[parameter] = value;
    }
  }
  const sql = `SELECT id FROM ${quote(repository.schema.table)}`
    + `${predicates.length ? ` WHERE ${predicates.join(' AND ')} AND (${violations.join(' OR ')})` : ` WHERE ${violations.join(' OR ')}`}`
    + ' LIMIT 1';
  const violating = database.prepare(sql).get(parameters) as { id?: unknown } | undefined;
  if (violating) {
    const error = new Error(`${repository.name} transaction assertAll failed for ${String(violating.id)}.`) as Error & { code: string };
    error.code = 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
    throw error;
  }
}

function executeAssertExactIds(
  database: Database.Database,
  domain: string,
  where: DomainRow,
  expectedIds: readonly string[]
): void {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const encoded = repository.codec.encodeWhere(where);
  const { predicates, parameters } = whereClause(encoded);
  if (predicates.length === 0) throw new Error(`${repository.name} assertExactIds requires predicates.`);
  const actualIds = (database.prepare(
    `SELECT id FROM ${quote(repository.schema.table)} WHERE ${predicates.join(' AND ')} ORDER BY id ASC`
  ).all(parameters) as Array<{ id: unknown }>).map((row) => requireRuntimeId(row.id));
  const expected = [...expectedIds].map(requireRuntimeId).sort();
  if (
    actualIds.length !== expected.length
    || actualIds.some((id, index) => id !== expected[index])
  ) {
    const error = new Error(`${repository.name} transaction assertExactIds failed.`) as Error & { code: string };
    error.code = 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
    throw error;
  }
}

function executeAssertNone(database: Database.Database, domain: string, where: DomainRow): void {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const encoded = repository.codec.encodeWhere(where);
  const { predicates, parameters } = whereClause(encoded);
  if (predicates.length === 0) throw new Error(`${repository.name} assertNone requires predicates.`);
  const matched = database.prepare(
    `SELECT id FROM ${quote(repository.schema.table)} WHERE ${predicates.join(' AND ')} LIMIT 1`
  ).get(parameters) as { id?: unknown } | undefined;
  if (matched) {
    const error = new Error(`${repository.name} transaction assertNone failed for ${String(matched.id)}.`) as Error & { code: string };
    error.code = 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
    throw error;
  }
}

function executeMutation(
  database: Database.Database,
  mutation: RepositoryMutation,
  allocatedSequences: RuntimeAllocatedSequence[]
): void {
  const repository = DOMAIN_REPOSITORIES.domain(mutation.domain);
  const schema = repository.schema;
  const mutationKind = mutation.kind === 'deleteWhere' || mutation.kind === 'pruneModelStreamCheckpoints'
    ? 'delete'
    : mutation.kind;
  if (!schema.mutations.includes(mutationKind)) {
    throw new Error(`${schema.repository} does not allow ${mutationKind}.`);
  }

  if (mutation.kind === 'pruneModelStreamCheckpoints') {
    executeCheckpointPrune(database, mutation);
  } else if (mutation.kind === 'insert') {
    const historicalCopy = mutation.historicalCopy === true;
    if (historicalCopy && !HISTORICAL_COPY_DOMAINS.includes(schema.key)) {
      throw new Error(`${schema.key} does not permit historical copy inserts.`);
    }
    if (schema.key === 'ModelStreamCheckpoint' || (schema.key === 'ModelStreamFence' && !historicalCopy)) {
      throw new Error(`${schema.key} insert is limited to the fixed writer modelStreamEvent operation.`);
    }
    const allocatedRow = mutation.allocateSequence
      ? allocateNextSequence(database, repository, mutation)
      : mutation.row;
    const row = resolveMessageRevisionSequenceReference(allocatedRow, mutation, allocatedSequences);
    if (schema.key === 'ModelRequest') {
      if (historicalCopy) {
        if (row.status !== 'terminal' || row.terminal_state === null) {
          throw new Error('Fork copy ModelRequest must be terminal with a terminal_state.');
        }
      } else if (row.status !== 'prepared' || row.terminal_state !== null) {
        throw new Error('ModelRequest insert must start prepared and non-terminal.');
      }
      decodeModelStreamIdentity(row.stream_stats_json);
    }
    if (schema.key === 'Operation' && row.owner_kind === 'model_request') {
      if (historicalCopy) {
        if (row.status === 'pending') {
          throw new Error('Fork copy ModelRequest Operation must not be pending.');
        }
      } else if (row.status !== 'pending') {
        throw new Error('ModelRequest Operation must start pending.');
      }
    }
    if (schema.key === 'Attempt') {
      const operation = database.prepare('SELECT owner_kind FROM operation WHERE id = ?').get(row.operation_id) as {
        owner_kind?: unknown;
      } | undefined;
      if (operation?.owner_kind === 'model_request') {
        if (historicalCopy) {
          if (row.status === 'pending') throw new Error('Fork copy ModelRequest Attempt must not be pending.');
        } else if (row.status !== 'pending') {
          throw new Error('ModelRequest Attempt must start pending.');
        }
        if (typeof row.attempt_seq !== 'bigint' || row.attempt_seq < 1n || row.attempt_seq > 11n) {
          throw new Error('ModelRequest permits only attempt_seq 1 through 11.');
        }
      }
    }
    const encoded = repository.codec.encodeInsert(row);
    const id = requireEncodedId(encoded.id, schema.codec);
    if (mutation.allocateSequence) {
      const value = encoded[mutation.allocateSequence.column];
      if (typeof value !== 'bigint') throw new Error('Allocated sequence was not encoded as SQLite INTEGER.');
      allocatedSequences.push({
        domain: schema.key,
        id,
        column: mutation.allocateSequence.column,
        value: value.toString()
      });
    }
    if (schema.key === 'ContentObject') assertPublishedContentObject(encoded, data.binding.paths.casRootPath);
    const names = Object.keys(encoded);
    const sql = `INSERT INTO ${quote(schema.table)} (${names.map(quote).join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`;
    database.prepare(sql).run(encoded);
  } else if (mutation.kind === 'update') {
    const id = requireRuntimeId(mutation.id);
    assertRuntimeDomainUpdatePatch(schema.key, mutation.patch);
    assertRuntimeStateTransition(database, schema.key, id, mutation.patch);
    const encoded = repository.codec.encodePatch(mutation.patch);
    const assignments = Object.keys(encoded).map((name) => `${quote(name)} = @${name}`);
    const result = database.prepare(`UPDATE ${quote(schema.table)} SET ${assignments.join(', ')} WHERE id = @__id`)
      .run({ ...encoded, __id: id });
    if (result.changes !== 1) throw new Error(`${schema.repository} update expected one row: ${id}`);
  } else if (mutation.kind === 'deleteWhere') {
    if (schema.key === 'ModelStreamCheckpoint') {
      throw new Error('ModelStreamCheckpoint rows can only be pruned by the fixed writer stream-finalization operation.');
    }
    const encoded = repository.codec.encodeWhere(mutation.where);
    const { predicates, parameters } = whereClause(encoded);
    if (predicates.length === 0) throw new Error(`${schema.repository}.deleteWhere requires predicates.`);
    const result = database.prepare(`DELETE FROM ${quote(schema.table)} WHERE ${predicates.join(' AND ')}`).run(parameters);
    if (result.changes > mutation.maxChanges) {
      throw new Error(`${schema.repository}.deleteWhere exceeded ${mutation.maxChanges} row.`);

    }
  } else {
    const id = requireRuntimeId(mutation.id);
    if (schema.key === 'ModelStreamCheckpoint') {
      throw new Error('ModelStreamCheckpoint rows can only be pruned by the fixed writer stream-finalization operation.');
    }
    const result = database.prepare(`DELETE FROM ${quote(schema.table)} WHERE id = ?`).run(id);
    if (result.changes !== 1) throw new Error(`${schema.repository} delete expected one row: ${id}`);
  }
}

function assertPreparedContentInsert(
  metadata: DomainRow,
  insert: RepositoryInsertMutation | undefined
): void {
  if (!insert) return;
  if (insert.domain !== 'ContentObject' || insert.allocateSequence || insert.messageRevisionSequenceReferenceId) {
    throw new Error('ModelStream contentInsert must be one plain ContentObject insert.');
  }
  const encodedMetadata = DOMAIN_REPOSITORIES.codec('ContentObject').encodeInsert(metadata);
  const encodedInsert = DOMAIN_REPOSITORIES.codec('ContentObject').encodeInsert(insert.row);
  for (const [column, value] of Object.entries(encodedMetadata)) {
    if (encodedInsert[column] !== value) {
      throw new Error(`ModelStream contentInsert does not match published metadata column ${column}.`);
    }
  }
}

function insertStreamFact(
  database: Database.Database,
  domain: 'ModelStreamCheckpoint' | 'ModelStreamFence',
  row: DomainRow
): void {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const encoded = repository.codec.encodeInsert(row);
  const names = Object.keys(encoded);
  database.prepare(
    `INSERT INTO ${quote(repository.schema.table)} (${names.map(quote).join(', ')}) `
      + `VALUES (${names.map((name) => `@${name}`).join(', ')})`
  ).run(encoded);
}

function executeCheckpointPrune(
  database: Database.Database,
  mutation: RepositoryCheckpointPruneMutation
): void {
  const modelRequestId = requireRuntimeId(mutation.modelRequestId);
  const terminalCheckpointId = requireRuntimeId(mutation.terminalCheckpointId);
  const fence = database.prepare(`
    SELECT attempt_seq, socket_generation
      FROM model_stream_fence
     WHERE model_request_id = ?
     LIMIT 1
  `).get(modelRequestId) as { attempt_seq?: unknown; socket_generation?: unknown } | undefined;
  if (
    fence?.attempt_seq !== mutation.attemptSeq
    || fence.socket_generation !== mutation.socketGeneration
  ) throw new Error('ModelStream checkpoint prune requires the matching terminal fence identity.');
  const terminal = database.prepare(`
    SELECT model_request_id, attempt_seq, socket_generation, checkpoint_kind
      FROM model_stream_checkpoint
     WHERE id = ?
     LIMIT 1
  `).get(terminalCheckpointId) as {
    model_request_id?: unknown;
    attempt_seq?: unknown;
    socket_generation?: unknown;
    checkpoint_kind?: unknown;
  } | undefined;
  if (
    terminal?.model_request_id !== modelRequestId
    || terminal.attempt_seq !== mutation.attemptSeq
    || terminal.socket_generation !== mutation.socketGeneration
    || terminal.checkpoint_kind !== 'terminal_summary'
  ) throw new Error('ModelStream checkpoint prune requires the matching terminal summary.');
  const retained = database.prepare(`
    SELECT id
      FROM model_stream_checkpoint
     WHERE model_request_id = ?
       AND attempt_seq = ?
       AND socket_generation = ?
       AND checkpoint_kind != 'terminal_summary'
     ORDER BY stream_seq DESC
     LIMIT ?
  `).all(
    modelRequestId,
    mutation.attemptSeq,
    mutation.socketGeneration,
    BigInt(MODEL_STREAM_TERMINAL_TAIL)
  ) as Array<{ id: string }>;
  const keep = new Set([terminalCheckpointId, ...retained.map((row) => requireRuntimeId(row.id))]);
  const obsolete = database.prepare(
    'SELECT id FROM model_stream_checkpoint WHERE model_request_id = ?'
  ).all(modelRequestId) as Array<{ id: string }>;
  const deleteStatement = database.prepare('DELETE FROM model_stream_checkpoint WHERE id = ?');
  for (const row of obsolete) {
    const id = requireRuntimeId(row.id);
    if (!keep.has(id)) deleteStatement.run(id);
  }
}

function resolveMessageRevisionSequenceReference(
  row: DomainRow,
  mutation: RepositoryInsertMutation,
  allocatedSequences: RuntimeAllocatedSequence[]
): DomainRow {
  const messageRevisionId = mutation.messageRevisionSequenceReferenceId;
  if (!messageRevisionId) return row;
  if (
    mutation.domain !== 'ContextSegmentSource'
    || row.source_kind !== 'message_revision'
    || row.source_id !== messageRevisionId
    || 'source_revision' in row
  ) {
    throw new Error('Writer Message revision reference has an invalid ContextSegmentSource shape.');
  }
  const allocated = [...allocatedSequences].reverse().find((entry) =>
    entry.domain === 'MessageRevision'
    && entry.id === messageRevisionId
    && entry.column === 'revision_seq'
  );
  if (!allocated) {
    throw new Error(
      `ContextSegmentSource.source_revision references MessageRevision ${messageRevisionId} before its writer allocation.`
    );
  }
  return { ...row, source_revision: allocated.value };
}

function assertTouchedRuntimeAggregates(
  database: Database.Database,
  steps: readonly RepositoryTransactionStep[]
): void {
  const modelRequestIds = new Set<string>();
  const turnIds = new Set<string>();
  const visit = (step: RepositoryTransactionStep): void => {
    if (step.kind === 'savepoint') {
      step.steps.forEach(visit);
      return;
    }
    if (
      step.kind === 'assert'
      || step.kind === 'assertAll'
      || step.kind === 'assertNone'
      || step.kind === 'assertExactIds'
    ) return;
    if (step.domain === 'ModelRequest') {
      const id = step.kind === 'insert' ? step.row.id : 'id' in step ? step.id : null;
      if (typeof id === 'string') modelRequestIds.add(id);
    } else if (step.domain === 'Operation') {
      const id = step.kind === 'insert' ? step.row.id : 'id' in step ? step.id : null;
      if (typeof id === 'string') {
        const owner = database.prepare('SELECT owner_kind, owner_id FROM operation WHERE id = ?').get(id) as {
          owner_kind?: unknown;
          owner_id?: unknown;
        } | undefined;
        if (owner?.owner_kind === 'model_request' && typeof owner.owner_id === 'string') {
          modelRequestIds.add(owner.owner_id);
        }
      }
    } else if (step.domain === 'Attempt') {
      const id = step.kind === 'insert' ? step.row.id : 'id' in step ? step.id : null;
      if (typeof id === 'string') {
        const owner = database.prepare(`
          SELECT operation.owner_kind, operation.owner_id
            FROM attempt
            JOIN operation ON operation.id = attempt.operation_id
           WHERE attempt.id = ?
        `).get(id) as { owner_kind?: unknown; owner_id?: unknown } | undefined;
        if (owner?.owner_kind === 'model_request' && typeof owner.owner_id === 'string') {
          modelRequestIds.add(owner.owner_id);
        }
      }
    } else if (step.domain === 'Turn') {
      const id = step.kind === 'insert' ? step.row.id : 'id' in step ? step.id : null;
      if (typeof id === 'string') turnIds.add(id);
    } else if (step.domain === 'TurnTermination' && step.kind === 'insert') {
      if (typeof step.row.turn_id === 'string') turnIds.add(step.row.turn_id);
    }
  };
  steps.forEach(visit);
  for (const turnId of turnIds) {
    const turn = database.prepare('SELECT status FROM turn WHERE id = ?').get(turnId) as { status?: unknown } | undefined;
    if (turn?.status === 'active') continue;
    const requests = database.prepare('SELECT id FROM model_request WHERE turn_id = ?').all(turnId) as Array<{ id: string }>;
    for (const request of requests) modelRequestIds.add(requireRuntimeId(request.id));
  }
  for (const modelRequestId of modelRequestIds) assertModelRequestAggregate(database, modelRequestId);
}

function assertModelRequestAggregate(database: Database.Database, modelRequestId: string): void {
  const requestRaw = database.prepare('SELECT * FROM model_request WHERE id = ?').get(modelRequestId);
  if (!requestRaw) throw new Error(`ModelRequest ${modelRequestId} does not exist.`);
  const request = DOMAIN_REPOSITORIES.codec('ModelRequest').decode(requestRaw as Record<string, unknown>);
  const identity = decodeModelStreamIdentity(request.stream_stats_json);
  const operations = database.prepare(
    "SELECT id, status FROM operation WHERE owner_kind = 'model_request' AND owner_id = ?"
  ).all(modelRequestId) as Array<{ id: string; status: string }>;
  if (operations.length !== 1) throw new Error(`ModelRequest ${modelRequestId} must own exactly one Operation.`);
  const operation = operations[0];
  const attempts = database.prepare(
    'SELECT id, attempt_seq, status, completed_at FROM attempt WHERE operation_id = ? ORDER BY attempt_seq'
  ).all(operation.id) as Array<{ id: string; attempt_seq: bigint; status: string; completed_at: string | null }>;
  if (attempts.length < 1 || attempts.length > 11) {
    throw new Error(`ModelRequest ${modelRequestId} must have between one and eleven Attempts.`);
  }
  attempts.forEach((attempt, index) => {
    if (attempt.attempt_seq !== BigInt(index + 1)) {
      throw new Error(`ModelRequest ${modelRequestId} Attempt sequence is not contiguous.`);
    }
  });
  const currentAttempt = attempts.find((attempt) => attempt.attempt_seq === identity.attemptSeq);
  if (!currentAttempt) throw new Error(`ModelRequest ${modelRequestId} stream identity has no matching Attempt.`);
  if (identity.attemptSeq !== BigInt(attempts.length)) {
    throw new Error(`ModelRequest ${modelRequestId} current Attempt must be the contiguous tail.`);
  }
  const priorAttempts = attempts.slice(0, -1);
  if (priorAttempts.some((attempt) => attempt.status !== 'transient_failed' || attempt.completed_at === null)) {
    throw new Error(`ModelRequest ${modelRequestId} prior Attempts must be durably transient_failed.`);
  }
  const fence = database.prepare('SELECT * FROM model_stream_fence WHERE model_request_id = ?').get(modelRequestId) as {
    attempt_seq?: unknown;
    socket_generation?: unknown;
    outcome?: unknown;
  } | undefined;
  const status = String(request.status);
  const terminalState = request.terminal_state;
  if (status !== 'terminal' && terminalState !== null) {
    throw new Error(`Non-terminal ModelRequest ${modelRequestId} cannot carry terminal_state.`);
  }
  if (identity.attemptSeq > 1n && (
    identity.retryMaxAttempts === undefined
    || identity.attemptSeq - 1n > BigInt(identity.retryMaxAttempts)
  )) {
    throw new Error(`ModelRequest ${modelRequestId} current Attempt exceeds its frozen retry budget.`);
  }
  if (status === 'prepared') {
    if (
      identity.attemptSeq !== 1n
      || identity.socketGeneration !== 0n
      || operation.status !== 'pending'
      || currentAttempt.status !== 'pending'
      || fence
    ) throw new Error(`Prepared ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (status === 'streaming') {
    if (
      identity.socketGeneration <= 0n
      || operation.status !== 'running'
      || currentAttempt.status !== 'running'
      || fence
    ) throw new Error(`Streaming ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (status === 'retrying') {
    if (
      identity.attemptSeq < 2n
      || identity.attemptSeq > 11n
      || identity.socketGeneration !== 0n
      || identity.retryDelayMs === undefined
      || identity.retryNotBeforeAt === undefined
      || operation.status !== 'running'
      || currentAttempt.status !== 'pending'
      || priorAttempts.length !== Number(identity.attemptSeq - 1n)
      || fence
    ) throw new Error(`Retrying ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (status !== 'terminal' || typeof terminalState !== 'string' || terminalState.length === 0) {
    throw new Error(`ModelRequest ${modelRequestId} has an unsupported aggregate status.`);
  }
  if (terminalState === 'completed') {
    if (
      operation.status !== 'completed'
      || currentAttempt.status !== 'completed'
      || fence?.attempt_seq !== identity.attemptSeq
      || fence.socket_generation !== identity.socketGeneration
      || fence.outcome !== 'completed'
    ) throw new Error(`Completed ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (fence) throw new Error(`Non-completed ModelRequest ${modelRequestId} cannot have a terminal fence.`);
  if (
    !['cancelled', 'failed'].includes(currentAttempt.status)
    || operation.status !== currentAttempt.status
  ) throw new Error(`Terminal ModelRequest ${modelRequestId} aggregate is inconsistent.`);
}

function assertRuntimeStateTransition(
  database: Database.Database,
  domain: string,
  id: string,
  patch: DomainRow
): void {
  if (domain === 'RuntimeDelivery') {
    const current = database.prepare('SELECT state FROM runtime_delivery WHERE id = ?').get(id) as {
      state?: unknown;
    } | undefined;
    if (!current || typeof current.state !== 'string') {
      throw new Error(`RuntimeDeliveryRepository update expected one row: ${id}`);
    }
    const nextState = 'state' in patch ? String(patch.state) : current.state;
    const allowed: Record<string, readonly string[]> = {
      pending: ['pending', 'consumed', 'failed'],
      consumed: [],
      failed: []
    };
    if (!allowed[current.state]?.includes(nextState)) {
      throw new Error(`RuntimeDelivery state cannot transition from ${current.state} to ${nextState}.`);
    }
    return;
  }
  if (domain === 'RuntimeDeliveryInputLink') {
    const current = database.prepare('SELECT handled_at FROM runtime_delivery_input_link WHERE id = ?').get(id) as {
      handled_at?: unknown;
    } | undefined;
    if (!current) throw new Error(`RuntimeDeliveryInputLinkRepository update expected one row: ${id}`);
    const nextHandledAt = 'handled_at' in patch ? patch.handled_at : current.handled_at;
    if (current.handled_at !== null || typeof nextHandledAt !== 'string' || nextHandledAt.length === 0) {
      throw new Error('RuntimeDeliveryInputLink.handled_at may only transition once from NULL to a timestamp.');
    }
    return;
  }
  if (domain === 'ProcessCompletionDispatch') {
    assertClaimedOutboxTransition(database, domain, 'process_completion_dispatch', id, patch, 'completed_at', 'completed');
    return;
  }
  if (domain === 'RuntimeDeliveryWake') {
    assertClaimedOutboxTransition(database, domain, 'runtime_delivery_wake', id, patch, 'acknowledged_at', 'acknowledged');
    return;
  }
  if (domain === 'ModelRequest') {
    const raw = database.prepare('SELECT * FROM model_request WHERE id = ?').get(id);
    if (!raw) throw new Error(`ModelRequestRepository update expected one row: ${id}`);
    const current = DOMAIN_REPOSITORIES.codec('ModelRequest').decode(raw as Record<string, unknown>);
    const currentStatus = String(current.status);
    const nextStatus = 'status' in patch ? String(patch.status) : currentStatus;
    const allowed: Record<string, readonly string[]> = {
      prepared: ['prepared', 'streaming', 'terminal'],
      streaming: ['streaming', 'retrying', 'terminal'],
      retrying: ['retrying', 'streaming', 'terminal'],
      terminal: []
    };
    if (!allowed[currentStatus]?.includes(nextStatus)) {
      throw new Error(`ModelRequest status cannot transition from ${currentStatus} to ${nextStatus}.`);
    }
    const terminalState = 'terminal_state' in patch ? patch.terminal_state : current.terminal_state;
    if (nextStatus === 'terminal') {
      if (typeof terminalState !== 'string' || terminalState.length === 0) {
        throw new Error('Terminal ModelRequest requires terminal_state.');
      }
    } else if (terminalState !== null) {
      throw new Error('Non-terminal ModelRequest cannot have terminal_state.');
    }
    if ('stream_stats_json' in patch) {
      const currentIdentity = decodeModelStreamIdentity(current.stream_stats_json);
      const nextIdentity = decodeModelStreamIdentity(patch.stream_stats_json);
      const sameAttempt = nextIdentity.attemptSeq === currentIdentity.attemptSeq;
      const sameRetryBudget = currentIdentity.retryMaxAttempts === nextIdentity.retryMaxAttempts;
      const oneRetry = nextIdentity.attemptSeq === currentIdentity.attemptSeq + 1n
        && nextIdentity.attemptSeq <= 11n
        && nextIdentity.socketGeneration === 0n
        && nextIdentity.retryMaxAttempts !== undefined
        && nextIdentity.attemptSeq - 1n <= BigInt(nextIdentity.retryMaxAttempts)
        && (currentIdentity.retryMaxAttempts === undefined || sameRetryBudget);
      if (
        (!sameAttempt && !oneRetry)
        || (sameAttempt && (!sameRetryBudget || nextIdentity.socketGeneration < currentIdentity.socketGeneration))
      ) {
        throw new Error('ModelRequest stream identity cannot move backwards or skip a bounded retry transition.');
      }
    }
    return;
  }
  if (domain !== 'Attempt' && domain !== 'Operation') return;
  const table = domain === 'Attempt' ? 'attempt' : 'operation';
  const ownerJoin = domain === 'Attempt'
    ? 'SELECT current.status, owner.owner_kind FROM attempt AS current JOIN operation AS owner ON owner.id = current.operation_id WHERE current.id = ?'
    : 'SELECT current.status, current.owner_kind FROM operation AS current WHERE current.id = ?';
  const current = database.prepare(ownerJoin).get(id) as { status?: unknown; owner_kind?: unknown } | undefined;
  if (!current || current.owner_kind !== 'model_request') return;
  const currentStatus = String(current.status);
  const nextStatus = 'status' in patch ? String(patch.status) : currentStatus;
  const allowed = domain === 'Attempt'
    ? {
        pending: ['pending', 'running', 'cancelled', 'failed'],
        running: ['running', 'transient_failed', 'completed', 'cancelled', 'failed'],
        transient_failed: [], completed: [], cancelled: [], failed: []
      } as Record<string, readonly string[]>
    : {
        pending: ['pending', 'running', 'cancelled', 'failed'],
        running: ['running', 'completed', 'cancelled', 'failed'],
        completed: [], cancelled: [], failed: []
      } as Record<string, readonly string[]>;
  if (!allowed[currentStatus]?.includes(nextStatus)) {
    throw new Error(`${domain} status cannot transition from ${currentStatus} to ${nextStatus} for a ModelRequest.`);
  }
}

function assertClaimedOutboxTransition(
  database: Database.Database,
  domain: 'ProcessCompletionDispatch' | 'RuntimeDeliveryWake',
  table: 'process_completion_dispatch' | 'runtime_delivery_wake',
  id: string,
  patch: DomainRow,
  terminalTimestampColumn: 'completed_at' | 'acknowledged_at',
  successState: 'completed' | 'acknowledged'
): void {
  const raw = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!raw) throw new Error(`${domain}Repository update expected one row: ${id}`);
  const current = DOMAIN_REPOSITORIES.codec(domain).decode(raw as Record<string, unknown>);
  const currentState = String(current.state);
  const nextState = 'state' in patch ? String(patch.state) : currentState;
  const allowed: Record<string, readonly string[]> = {
    pending: ['claimed', 'dead_letter'],
    claimed: ['pending', successState, 'dead_letter'],
    [successState]: [],
    dead_letter: []
  };
  if (!allowed[currentState]?.includes(nextState)) {
    throw new Error(`${domain} state cannot transition from ${currentState} to ${nextState}.`);
  }
  const next = { ...current, ...patch };
  const owner = next.claim_owner_host_boot_id;
  const expiresAt = next.claim_expires_at;
  const generation = next.claim_generation;
  const attempts = next.attempt_count;
  const failures = next.failure_count;
  if (
    typeof generation !== 'bigint' || generation < 0n
    || typeof attempts !== 'bigint' || attempts < 0n
    || typeof failures !== 'bigint' || failures < 0n
  ) throw new Error(`${domain} counters must be non-negative integers.`);
  if (nextState === 'claimed') {
    if (
      typeof owner !== 'string' || owner.length === 0
      || typeof expiresAt !== 'string' || expiresAt.length === 0
      || generation !== (current.claim_generation as bigint) + 1n
      || attempts !== (current.attempt_count as bigint) + 1n
    ) throw new Error(`${domain} claim must atomically fence one owner generation and attempt.`);
  } else if (owner !== null || expiresAt !== null) {
    throw new Error(`${domain} non-claimed state cannot retain a claim owner or expiry.`);
  }
  const terminalTimestamp = next[terminalTimestampColumn];
  if (nextState === successState) {
    if (typeof terminalTimestamp !== 'string' || terminalTimestamp.length === 0) {
      throw new Error(`${domain} ${successState} state requires ${terminalTimestampColumn}.`);
    }
  } else if (terminalTimestamp !== null) {
    throw new Error(`${domain} ${terminalTimestampColumn} is only valid in ${successState} state.`);
  }
  if (nextState === 'dead_letter' && (typeof next.last_error !== 'string' || next.last_error.length === 0)) {
    throw new Error(`${domain} dead_letter state requires last_error.`);
  }
}

function allocateNextSequence(
  database: Database.Database,
  repository: DomainRepository,
  mutation: RepositoryInsertMutation
): DomainRow {
  const allocation = mutation.allocateSequence;
  if (!allocation) return mutation.row;
  const column = repository.codec.column(allocation.column);
  const isSequence = allocation.column.endsWith('_seq');
  const isPendingInputPosition = repository.schema.key === 'PendingTurnInput' && allocation.column === 'position';
  if (!column || column.type !== 'INTEGER' || (!isSequence && !isPendingInputPosition)) {
    throw new Error(`${repository.name}.${allocation.column} is not an allocatable writer INTEGER.`);
  }
  if (allocation.column in mutation.row) throw new Error(`${repository.name}.${allocation.column} was supplied and allocated.`);
  const scope = repository.codec.encodeWhere(allocation.scope);
  const encodedRowScope = repository.codec.encodeWhere(
    Object.fromEntries(Object.keys(scope).map((name) => [name, mutation.row[name]]))
  );
  for (const name of Object.keys(scope)) {
    if (scope[name] !== encodedRowScope[name]) {
      throw new Error(`${repository.name} sequence scope does not match the inserted row: ${name}`);
    }
  }
  const predicates: string[] = [];
  const parameters: EncodedRow = {};
  for (const [name, value] of Object.entries(scope)) {
    if (value === null) predicates.push(`${quote(name)} IS NULL`);
    else {
      predicates.push(`${quote(name)} = @${name}`);
      parameters[name] = value;
    }
  }
  const sql = `SELECT COALESCE(MAX(${quote(allocation.column)}), 0) + 1 AS next_value FROM ${quote(repository.schema.table)}${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''}`;
  const result = database.prepare(sql).get(parameters) as { next_value: bigint };
  if (typeof result.next_value !== 'bigint' || result.next_value <= 0n) throw new Error('SQLite sequence allocation failed.');
  return { ...mutation.row, [allocation.column]: result.next_value };
}

function matchesSavepointContinuation(error: unknown, onError: RepositorySavepointOnError): boolean {
  if (onError === 'propagate') return false;
  const value = error as { code?: unknown; message?: unknown };
  if (
    typeof value.code !== 'string'
    || !['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(value.code)
    || typeof value.message !== 'string'
  ) return false;
  const marker = 'UNIQUE constraint failed:';
  const markerIndex = value.message.indexOf(marker);
  if (markerIndex < 0) return false;
  const actualColumns = value.message
    .slice(markerIndex + marker.length)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  return onError.constraints.some((constraint) => {
    const table = DOMAIN_REPOSITORIES.domain(constraint.domain).schema.table;
    const expectedColumns = constraint.columns.map((column) => `${table}.${column}`).sort();
    return actualColumns.length === expectedColumns.length
      && actualColumns.every((column, index) => column === expectedColumns[index]);
  });
}

function whereClause(encoded: EncodedRow): { predicates: string[]; parameters: EncodedRow } {
  const predicates: string[] = [];
  const parameters: EncodedRow = {};
  for (const [name, value] of Object.entries(encoded)) {
    if (value === null) predicates.push(`${quote(name)} IS NULL`);
    else {
      predicates.push(`${quote(name)} = @${name}`);
      parameters[name] = value;
    }
  }
  return { predicates, parameters };
}

function executeContextMaterialization(
  database: Database.Database,
  rootId: string,
  commitSeq: bigint
): SnapshotBarrier<ContextMaterializationSnapshot> {
  const normalizedRootId = requireRuntimeId(rootId);
  database.exec('BEGIN');
  try {
    const rootRepository = DOMAIN_REPOSITORIES.domain('ContextSequenceRoot');
    const rawRoot = database.prepare('SELECT * FROM context_sequence_root WHERE id = ?').get(normalizedRootId);
    if (!rawRoot) throw new Error(`ContextSequenceRoot ${normalizedRootId} does not exist.`);
    const root = rootRepository.codec.decode(rawRoot as Record<string, unknown>);
    const rootNodeId = nullableRuntimeId(root.root_node_id, 'ContextSequenceRoot.root_node_id');
    const tailNodeId = nullableRuntimeId(root.tail_node_id, 'ContextSequenceRoot.tail_node_id');
    const tailCount = nonNegativeSafeInteger(root.tail_segment_count, 'ContextSequenceRoot.tail_segment_count');
    const segmentCount = nonNegativeSafeInteger(root.segment_count, 'ContextSequenceRoot.segment_count');
    let records: ContextMaterializationRecord[] = [];
    if (rootNodeId === null) {
      if (tailNodeId !== null || tailCount !== 0 || segmentCount !== 0) {
        throw new Error(`ContextSequenceRoot ${normalizedRootId} has an invalid empty shape.`);
      }
    } else {
      const rootRecord = readContextRecord(database, rootNodeId);
      if (rootRecord.segment.segment_kind === 'compression') {
        if (rootRecord.node.parent_node_id !== null) {
          throw new Error(`Compression root ${normalizedRootId} summary node must not have a parent.`);
        }
        if ((tailCount === 0) !== (tailNodeId === null)) {
          throw new Error(`Compression root ${normalizedRootId} tail pointer/count mismatch.`);
        }
        const tail = tailNodeId === null ? [] : readContextChain(database, tailNodeId, tailCount);
        records = [rootRecord, ...tail];
        if (records.length !== segmentCount) {
          throw new Error(`Compression root ${normalizedRootId} segment_count mismatch.`);
        }
      } else {
        if (tailNodeId !== null || tailCount !== 0) {
          throw new Error(`Ordinary root ${normalizedRootId} must not carry a compression tail.`);
        }
        records = readContextChain(database, rootNodeId, segmentCount);
        if (records[0]?.node.parent_node_id !== null) {
          throw new Error(`Ordinary root ${normalizedRootId} chain does not terminate at NULL.`);
        }
      }
    }
    database.exec('COMMIT');
    return { snapshotCommitSeq: commitSeq.toString(), snapshot: { root, records } };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function attachContextContent(
  barrier: SnapshotBarrier<ContextMaterializationSnapshot>,
  casRootPath: string,
  cache: VerifiedContextCasCache
): {
  result: SnapshotBarrier<ContextContentMaterializationSnapshot>;
  transferList: ArrayBuffer[];
} {
  const rootPath = path.resolve(casRootPath);
  const unique = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const record of barrier.snapshot.records) {
    const metadata = record.contentObject;
    const id = requireRuntimeId(metadata.id);
    if (unique.has(id)) continue;
    const bytes = cache.read(metadata, rootPath);
    totalBytes += bytes.length;
    if (!Number.isSafeInteger(totalBytes)) throw new RangeError('Materialized Context bytes exceed the safe packed-buffer range.');
    unique.set(id, bytes);
  }
  const packed = new Uint8Array(totalBytes);
  const views = new Map<string, Uint8Array>();
  let offset = 0;
  for (const [id, bytes] of unique) {
    packed.set(bytes, offset);
    views.set(id, packed.subarray(offset, offset + bytes.length));
    offset += bytes.length;
  }
  return {
    result: {
      snapshotCommitSeq: barrier.snapshotCommitSeq,
      snapshot: {
        root: barrier.snapshot.root,
        records: barrier.snapshot.records.map((record) => ({
          ...record,
          content: views.get(requireRuntimeId(record.contentObject.id)) as Uint8Array
        }))
      }
    },
    transferList: packed.byteLength > 0 ? [packed.buffer] : []
  };
}

function contextCasIdentity(metadata: DomainRow): Omit<VerifiedContextCasCacheEntry, 'bytes'> {
  const id = requireRuntimeId(metadata.id);
  const sha256 = typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256)
    ? metadata.sha256
    : (() => { throw new Error(`ContentObject ${id} has an invalid sha256.`); })();
  const byteLength = typeof metadata.byte_length === 'bigint' && metadata.byte_length >= 0n
    ? metadata.byte_length
    : (() => { throw new Error(`ContentObject ${id} has an invalid byte length.`); })();
  const storageKey = `sha256/${sha256.slice(0, 2)}/${sha256}`;
  if (metadata.storage_key !== storageKey) throw new Error(`ContentObject ${id} storage key does not match sha256.`);
  return { id, sha256, byteLength, storageKey };
}

function assertSameContextCasIdentity(
  cached: VerifiedContextCasCacheEntry,
  current: Omit<VerifiedContextCasCacheEntry, 'bytes'>
): void {
  if (
    cached.sha256 !== current.sha256
    || cached.byteLength !== current.byteLength
    || cached.storageKey !== current.storageKey
  ) {
    throw new Error(`ContentObject ${current.id} metadata changed during one Runtime worker lifetime.`);
  }
}

function readVerifiedCasBytes(metadata: DomainRow, resolvedCasRootPath: string): Buffer {
  const id = requireRuntimeId(metadata.id);
  const sha256 = typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256)
    ? metadata.sha256
    : (() => { throw new Error(`ContentObject ${id} has an invalid sha256.`); })();
  const expectedKey = `sha256/${sha256.slice(0, 2)}/${sha256}`;
  if (metadata.storage_key !== expectedKey) throw new Error(`ContentObject ${id} storage key does not match sha256.`);
  if (!path.isAbsolute(resolvedCasRootPath)) throw new Error('CAS root must be resolved before verified reads.');
  // The path segments are derived only from a validated lowercase SHA-256, so no per-object resolve
  // or traversal check is needed on this 1000-record materialization hot path.
  const candidate = path.join(resolvedCasRootPath, 'sha256', sha256.slice(0, 2), sha256);
  const bytes = fs.readFileSync(candidate);
  if (typeof metadata.byte_length !== 'bigint' || BigInt(bytes.length) !== metadata.byte_length) {
    throw new Error(`ContentObject ${id} byte length mismatch.`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error(`ContentObject ${id} digest mismatch.`);
  }
  return bytes;
}

function readContextChain(
  database: Database.Database,
  startNodeId: string,
  count: number
): ContextMaterializationRecord[] {
  if (count <= 0) throw new Error('Context chain with a start node requires a positive segment count.');
  const rows = database.prepare(`
    WITH RECURSIVE chain(id, parent_node_id, segment_id, created_at, depth) AS (
      SELECT id, parent_node_id, segment_id, created_at, 1
        FROM context_sequence_node
       WHERE id = @startNodeId
      UNION ALL
      SELECT parent.id, parent.parent_node_id, parent.segment_id, parent.created_at, chain.depth + 1
        FROM context_sequence_node AS parent
        JOIN chain ON parent.id = chain.parent_node_id
       WHERE chain.depth < @segmentCount
    )
    SELECT chain.id AS node_id,
           chain.parent_node_id AS node_parent_node_id,
           chain.segment_id AS node_segment_id,
           chain.created_at AS node_created_at,
           segment.id AS segment_id,
           segment.content_object_id AS segment_content_object_id,
           segment.segment_kind AS segment_kind,
           segment.created_at AS segment_created_at,
           content.id AS content_id,
           content.content_type AS content_type,
           content.sha256 AS content_sha256,
           content.byte_length AS content_byte_length,
           content.storage_key AS content_storage_key,
           content.created_at AS content_created_at,
           chain.depth AS depth
      FROM chain
      JOIN context_segment AS segment ON segment.id = chain.segment_id
      JOIN content_object AS content ON content.id = segment.content_object_id
     ORDER BY chain.depth DESC
  `).all({ startNodeId, segmentCount: BigInt(count) }) as Array<Record<string, unknown>>;
  if (rows.length !== count) throw new Error(`Context chain expected ${count} nodes, found ${rows.length}.`);
  return decodeContextRecords(database, rows);
}

function readContextRecord(database: Database.Database, nodeId: string): ContextMaterializationRecord {
  const row = database.prepare(`
    SELECT node.id AS node_id,
           node.parent_node_id AS node_parent_node_id,
           node.segment_id AS node_segment_id,
           node.created_at AS node_created_at,
           segment.id AS segment_id,
           segment.content_object_id AS segment_content_object_id,
           segment.segment_kind AS segment_kind,
           segment.created_at AS segment_created_at,
           content.id AS content_id,
           content.content_type AS content_type,
           content.sha256 AS content_sha256,
           content.byte_length AS content_byte_length,
           content.storage_key AS content_storage_key,
           content.created_at AS content_created_at,
           1 AS depth
      FROM context_sequence_node AS node
      JOIN context_segment AS segment ON segment.id = node.segment_id
      JOIN content_object AS content ON content.id = segment.content_object_id
     WHERE node.id = ?
  `).get(nodeId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`ContextSequenceNode ${nodeId} does not exist or has missing content.`);
  return decodeContextRecords(database, [row])[0];
}

function decodeContextRecords(
  database: Database.Database,
  rows: Array<Record<string, unknown>>
): ContextMaterializationRecord[] {
  const messageSegmentIds = rows
    .filter((row) => row.segment_kind === 'message')
    .map((row) => requireRuntimeId(row.segment_id));
  const roles = new Map<string, string[]>();
  const modelSources = new Map<string, ContextModelSource | null>();
  for (let offset = 0; offset < messageSegmentIds.length; offset += 500) {
    const chunk = messageSegmentIds.slice(offset, offset + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const sourceRows = database.prepare(`
      SELECT DISTINCT source.segment_id AS segment_id, revision.role AS role,
             model_request.provider_id AS source_provider_id,
             model_request.model_id AS source_model_id
        FROM context_segment_source AS source
        JOIN message_revision AS revision
          ON revision.id = source.source_id
         AND revision.revision_seq = source.source_revision
        LEFT JOIN model_request_message_link AS model_link
          ON model_link.message_id = revision.message_id
         AND revision.revision_seq = 1
         AND revision.role = 'model'
        LEFT JOIN model_request
          ON model_request.id = model_link.model_request_id
       WHERE source.source_kind = 'message_revision'
         AND source.segment_id IN (${placeholders})
       ORDER BY source.segment_id, source.id
    `).all(...chunk) as Array<{
      segment_id: string;
      role: string;
      source_provider_id: string | null;
      source_model_id: string | null;
    }>;
    for (const source of sourceRows) {
      const segmentId = requireRuntimeId(source.segment_id);
      if (typeof source.role !== 'string' || source.role.length === 0) {
        throw new Error(`Message ContextSegment ${segmentId} has an invalid role.`);
      }
      const current = roles.get(segmentId) ?? [];
      if (!current.includes(source.role)) current.push(source.role);
      roles.set(segmentId, current);
      const modelSource = source.source_provider_id && source.source_model_id
        ? { providerId: source.source_provider_id, modelId: source.source_model_id }
        : null;
      const previousSource = modelSources.get(segmentId);
      if (previousSource === undefined) modelSources.set(segmentId, modelSource);
      else if (previousSource && (
        !modelSource
        || previousSource.providerId !== modelSource.providerId
        || previousSource.modelId !== modelSource.modelId
      )) modelSources.set(segmentId, null);
    }
  }
  return rows.map((row) => decodeContextRecord(
    row,
    roles.get(String(row.segment_id)) ?? [],
    modelSources.get(String(row.segment_id))
  ));
}

function decodeContextRecord(
  row: Record<string, unknown>,
  messageRoles: readonly string[],
  modelSource?: ContextModelSource | null
): ContextMaterializationRecord {
  const segmentKind = typeof row.segment_kind === 'string' ? row.segment_kind : '';
  let messageRole: string | null = null;
  if (segmentKind === 'message') {
    if (messageRoles.length !== 1) {
      throw new Error(`Message ContextSegment ${String(row.segment_id)} must resolve exactly one immutable MessageRevision role.`);
    }
    messageRole = messageRoles[0];
  }
  return {
    node: DOMAIN_REPOSITORIES.codec('ContextSequenceNode').decode({
      id: row.node_id,
      parent_node_id: row.node_parent_node_id,
      segment_id: row.node_segment_id,
      created_at: row.node_created_at
    }),
    segment: DOMAIN_REPOSITORIES.codec('ContextSegment').decode({
      id: row.segment_id,
      content_object_id: row.segment_content_object_id,
      segment_kind: row.segment_kind,
      created_at: row.segment_created_at
    }),
    contentObject: DOMAIN_REPOSITORIES.codec('ContentObject').decode({
      id: row.content_id,
      content_type: row.content_type,
      sha256: row.content_sha256,
      byte_length: row.content_byte_length,
      storage_key: row.content_storage_key,
      created_at: row.content_created_at
    }),
    messageRole,
    ...(modelSource ? { modelSource } : {})
  };
}

function nullableRuntimeId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string or NULL.`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be a non-negative safe SQLite INTEGER.`);
  }
  return Number(value);
}

function executeSnapshot(
  database: Database.Database,
  reads: RepositoryRead[],
  commitSeq: bigint
): SnapshotBarrier<Array<DomainRow | DomainRow[] | null>> {
  if (!Array.isArray(reads)) throw new TypeError('Snapshot reads must be an array.');
  database.exec('BEGIN');
  try {
    const snapshot = reads.map((read) => executeRead(database, read));
    database.exec('COMMIT');
    return { snapshotCommitSeq: commitSeq.toString(), snapshot };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function executeSnapshotAll(
  database: Database.Database,
  read: RepositoryListRead,
  commitSeq: bigint
): SnapshotBarrier<DomainRow[]> {
  if (read.orderBy?.column !== 'id' || read.orderBy.direction !== 'asc') {
    throw new TypeError('snapshotAll requires id ascending order.');
  }
  database.exec('BEGIN');
  try {
    const rows: DomainRow[] = [];
    let afterId = read.afterId;
    for (;;) {
      const page = executeRead(database, { ...read, ...(afterId ? { afterId } : {}) });
      if (!Array.isArray(page)) throw new TypeError('snapshotAll list did not return rows.');
      rows.push(...page);
      if (page.length < read.limit) break;
      const lastId = page[page.length - 1]?.id;
      if (typeof lastId !== 'string' || lastId.length === 0 || lastId === afterId) {
        throw new Error('snapshotAll pagination did not advance.');
      }
      afterId = lastId;
    }
    database.exec('COMMIT');
    return { snapshotCommitSeq: commitSeq.toString(), snapshot: rows };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function executeToolFactsSnapshot(
  database: Database.Database,
  toolCallIdInput: string,
  commitSeq: bigint
): SnapshotBarrier<ToolFactsSnapshot> {
  const toolCallId = requireRuntimeId(toolCallIdInput);
  database.exec('BEGIN');
  try {
    const toolCallRead = executeRead(
      database,
      DOMAIN_REPOSITORIES.domain('ToolCall').get(toolCallId)
    );
    if (Array.isArray(toolCallRead)) throw new TypeError('ToolCall fixed read returned a list.');
    const executionsRead = executeRead(
      database,
      DOMAIN_REPOSITORIES.domain('ToolExecution').list({
        where: { tool_call_id: toolCallId },
        limit: 2
      })
    );
    if (!Array.isArray(executionsRead)) throw new TypeError('ToolExecution fixed read did not return a list.');

    let turn: DomainRow | null = null;
    let leases: DomainRow[] = [];
    let conversation: DomainRow | null = null;
    if (toolCallRead) {
      const turnId = requireRuntimeId(toolCallRead.turn_id);
      const turnRead = executeRead(database, DOMAIN_REPOSITORIES.domain('Turn').get(turnId));
      if (Array.isArray(turnRead)) throw new TypeError('Turn fixed read returned a list.');
      turn = turnRead;
      const leasesRead = executeRead(
        database,
        DOMAIN_REPOSITORIES.domain('ExecutionLease').list({
          where: { turn_id: turnId },
          limit: 2
        })
      );
      if (!Array.isArray(leasesRead)) throw new TypeError('ExecutionLease fixed read did not return a list.');
      leases = leasesRead;
      if (turn) {
        const conversationId = requireRuntimeId(turn.conversation_id);
        const conversationRead = executeRead(
          database,
          DOMAIN_REPOSITORIES.domain('Conversation').get(conversationId)
        );
        if (Array.isArray(conversationRead)) throw new TypeError('Conversation fixed read returned a list.');
        conversation = conversationRead;
      }
    }
    database.exec('COMMIT');
    return {
      snapshotCommitSeq: commitSeq.toString(),
      snapshot: {
        toolCall: toolCallRead,
        executions: executionsRead,
        turn,
        leases,
        conversation
      }
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function executeProcessOutputRegistrationMismatches(
  database: Database.Database
): ProcessOutputRegistrationMismatch[] {
  const rows = database.prepare(`
    SELECT process.id AS process_id,
           CAST(process.retained_chunks AS TEXT) AS expected_chunks,
           CAST(COUNT(chunk.id) AS TEXT) AS registered_chunks,
           CAST(process.retained_bytes AS TEXT) AS expected_bytes,
           CAST(COALESCE(SUM(chunk.byte_length), 0) AS TEXT) AS registered_bytes
      FROM process
      LEFT JOIN process_output_chunk AS chunk ON chunk.process_id = process.id
     WHERE process.status IN ('exited', 'cancelled', 'timed_out', 'output_limit_exceeded')
     GROUP BY process.id, process.retained_chunks, process.retained_bytes
    HAVING COUNT(chunk.id) <> process.retained_chunks
        OR COALESCE(SUM(chunk.byte_length), 0) <> process.retained_bytes
        OR (process.retained_chunks > 0 AND MIN(chunk.chunk_seq) <> 1)
        OR (process.retained_chunks > 0 AND MAX(chunk.chunk_seq) <> process.retained_chunks)
     ORDER BY process.id ASC
  `).all() as Array<{
    process_id: string;
    expected_chunks: string;
    registered_chunks: string;
    expected_bytes: string;
    registered_bytes: string;
  }>;
  return rows.map((row) => ({
    processId: requireRuntimeId(row.process_id),
    expectedChunks: requireNonNegativeIntegerString(row.expected_chunks, 'Process.retained_chunks'),
    registeredChunks: requireNonNegativeIntegerString(row.registered_chunks, 'registered ProcessOutputChunk count'),
    expectedBytes: requireNonNegativeIntegerString(row.expected_bytes, 'Process.retained_bytes'),
    registeredBytes: requireNonNegativeIntegerString(row.registered_bytes, 'registered ProcessOutputChunk bytes')
  }));
}

function executeEffectReceiptReconciliationCandidates(
  database: Database.Database
): EffectReceiptReconciliationCandidate[] {
  const rows = database.prepare(`
    SELECT intent.id AS effect_intent_id, receipt.id AS effect_receipt_id
      FROM tool_call AS tool_call_row INDEXED BY ix_tool_call_02
      CROSS JOIN operation AS operation_row
      CROSS JOIN attempt AS attempt_row
      CROSS JOIN effect_intent AS intent
      CROSS JOIN effect_receipt AS receipt
     WHERE tool_call_row.status IN ('pending', 'executing', 'waiting_approval', 'waiting_answer')
       AND operation_row.tool_call_id = tool_call_row.id
       AND attempt_row.operation_id = operation_row.id
       AND intent.attempt_id = attempt_row.id
       AND receipt.attempt_id = attempt_row.id
       AND intent.dispatch_state = 'receipt_written'
       AND intent.effect_kind <> 'subagent_spawn'
       AND (
         operation_row.status IN ('pending', 'executing', 'waiting_answer')
         OR tool_call_row.status = 'executing'
       )
    UNION ALL
    SELECT intent.id AS effect_intent_id, receipt.id AS effect_receipt_id
      FROM operation AS operation_row INDEXED BY ix_operation_03
      CROSS JOIN attempt AS attempt_row
      CROSS JOIN effect_intent AS intent
      CROSS JOIN effect_receipt AS receipt
     WHERE operation_row.tool_call_id IS NULL
       AND operation_row.status IN ('pending', 'executing', 'waiting_answer')
       AND attempt_row.operation_id = operation_row.id
       AND intent.attempt_id = attempt_row.id
       AND receipt.attempt_id = attempt_row.id
       AND intent.dispatch_state = 'receipt_written'
       AND intent.effect_kind <> 'subagent_spawn'
     ORDER BY effect_intent_id ASC
  `).all() as Array<{ effect_intent_id: string; effect_receipt_id: string }>;
  return rows.map((row) => ({
    effectIntentId: requireRuntimeId(row.effect_intent_id),
    effectReceiptId: requireRuntimeId(row.effect_receipt_id)
  }));
}

function executeChildConversationOriginCandidates(
  database: Database.Database
): ChildConversationOriginCandidate[] {
  const rows = database.prepare(`
    SELECT child.id AS child_execution_id
      FROM child_execution AS child
      LEFT JOIN conversation_origin_link AS origin
        ON origin.conversation_id = child.child_conversation_id
     WHERE origin.id IS NULL
     ORDER BY child.id ASC
  `).all() as Array<{ child_execution_id: string }>;
  return rows.map((row) => ({ childExecutionId: requireRuntimeId(row.child_execution_id) }));
}

function executeChildProcessCleanupMaterializationCandidates(
  database: Database.Database
): ChildProcessCleanupMaterializationCandidate[] {
  const rows = database.prepare(`
    SELECT turn_link.id AS turn_link_id,
           turn_link.interruption_request_id AS interruption_request_id,
           turn_link.turn_id AS turn_id,
           source_link.id AS source_link_id,
           source_link.process_id AS process_id
      FROM child_interruption_turn_link AS turn_link
      JOIN process_completion_source_link AS source_link
        ON source_link.source_turn_id = turn_link.turn_id
      LEFT JOIN child_interruption_process_cleanup AS cleanup
        ON cleanup.interruption_request_id = turn_link.interruption_request_id
       AND cleanup.process_id = source_link.process_id
     WHERE cleanup.id IS NULL
     ORDER BY turn_link.id ASC, source_link.id ASC
  `).all() as Array<{
    turn_link_id: string;
    interruption_request_id: string;
    turn_id: string;
    source_link_id: string;
    process_id: string;
  }>;
  return rows.map((row) => ({
    turnLinkId: requireRuntimeId(row.turn_link_id),
    interruptionRequestId: requireRuntimeId(row.interruption_request_id),
    turnId: requireRuntimeId(row.turn_id),
    sourceLinkId: requireRuntimeId(row.source_link_id),
    processId: requireRuntimeId(row.process_id)
  }));
}

function executeRead(database: Database.Database, read: RepositoryRead): DomainRow | DomainRow[] | null {
  const repository = DOMAIN_REPOSITORIES.domain(read.domain);
  const schema = repository.schema;
  if (read.kind === 'get') {
    const row = database.prepare(`SELECT * FROM ${quote(schema.table)} WHERE id = ?`).get(requireRuntimeId(read.id));
    return row ? repository.codec.decode(row as Record<string, unknown>) : null;
  }
  if (!Number.isSafeInteger(read.limit) || read.limit <= 0 || read.limit > 1000) {
    throw new RangeError('Repository list limit must be an integer from 1 to 1000.');
  }
  const encodedWhere = repository.codec.encodeWhere(read.where ?? {});
  const predicates: string[] = [];
  const parameters: EncodedRow & { __after_id?: string; __limit?: bigint } = {};
  for (const [name, value] of Object.entries(encodedWhere)) {
    if (value === null) predicates.push(`${quote(name)} IS NULL`);
    else {
      predicates.push(`${quote(name)} = @${name}`);
      parameters[name] = value;
    }
  }
  const orderColumn = read.orderBy?.column ?? 'id';
  if (!repository.codec.hasColumn(orderColumn)) throw new Error(`${schema.repository} cannot order by ${orderColumn}.`);
  const direction = read.orderBy?.direction === 'desc' ? 'DESC' : 'ASC';
  if (read.afterId !== undefined) {
    if (orderColumn !== 'id' || direction !== 'ASC') throw new TypeError('Repository afterId pagination requires id ascending order.');
    parameters.__after_id = requireRuntimeId(read.afterId);
    predicates.push(`${quote('id')} > @__after_id`);
  }
  if (read.keyset) {
    if (read.afterId !== undefined) throw new TypeError('Cannot combine afterId and keyset cursors.');
    const column = repository.codec.column(read.keyset.column);
    if (!column || column.type === 'BLOB' || column.json || column.nullable || read.keyset.column !== orderColumn) throw new TypeError('Keyset requires its non-null scalar order column.');
    if (!['before', 'after'].includes(read.keyset.direction)) throw new TypeError('Keyset direction must be before or after.');
    const encoded = repository.codec.encodeWhere({ [column.name]: read.keyset.value });
    parameters.__keyset_value = encoded[column.name];
    parameters.__keyset_id = requireRuntimeId(read.keyset.id);
    const operator = read.keyset.direction === 'after' ? '>' : '<';
    predicates.push(`(${quote(column.name)} ${operator} @__keyset_value OR (${quote(column.name)} = @__keyset_value AND ${quote('id')} ${operator} @__keyset_id))`);
  }
  if (read.collaborationConversationId !== undefined) {
    if (schema.key !== 'CollaborationMessage') throw new TypeError('Mailbox scope is only valid for CollaborationMessage.');
    parameters.__mailbox_conversation = requireRuntimeId(read.collaborationConversationId);
    predicates.push(`(EXISTS (SELECT 1 FROM collaboration_message_source_link AS source WHERE source.message_id = collaboration_message.id AND source.conversation_id = @__mailbox_conversation) OR EXISTS (SELECT 1 FROM collaboration_message_target_link AS target WHERE target.message_id = collaboration_message.id AND target.conversation_id = @__mailbox_conversation))`);
  }
  parameters.__limit = BigInt(read.limit);
  const sql = `SELECT * FROM ${quote(schema.table)}${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY ${quote(orderColumn)} ${direction}${orderColumn === 'id' ? '' : `, id ${direction}`} LIMIT @__limit`;
  return (database.prepare(sql).all(parameters) as Array<Record<string, unknown>>).map((row) => repository.codec.decode(row));
}

function assertPublishedContentObject(row: EncodedRow, casRootPath: string): void {
  const digest = row.sha256;
  const storageKey = row.storage_key;
  const byteLength = row.byte_length;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('ContentObject.sha256 must be lowercase SHA-256.');
  const expectedKey = `sha256/${digest.slice(0, 2)}/${digest}`;
  if (storageKey !== expectedKey) throw new Error('ContentObject.storage_key does not match its digest.');
  if (typeof byteLength !== 'bigint' || byteLength < 0n) throw new Error('ContentObject.byte_length must be non-negative.');
  const absolutePath = path.resolve(casRootPath, ...expectedKey.split('/'));
  if (!absolutePath.startsWith(`${path.resolve(casRootPath)}${path.sep}`)) throw new Error('ContentObject CAS path escapes the active root.');
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || BigInt(stat.size) !== byteLength) throw new Error('ContentObject CAS file is missing or has the wrong length.');
}

function postMeasuredResponse(
  response: Extract<DatabaseWorkerResponse, { type: 'response' }>,
  enqueuedAtMs: number | undefined,
  receivedAtMs: number | undefined,
  transferList: readonly ArrayBuffer[] = []
): void {
  if (receivedAtMs === undefined || enqueuedAtMs === undefined || !Number.isFinite(enqueuedAtMs)) {
    post(response, transferList);
    return;
  }
  post({
    ...response,
    timing: {
      queueWaitMs: Math.max(0, receivedAtMs - enqueuedAtMs),
      executeDurationMs: Math.max(0, performance.now() - receivedAtMs)
    }
  }, transferList);
}

function post(message: DatabaseWorkerResponse, transferList: readonly ArrayBuffer[] = []): void {
  port.postMessage(message, transferList);
}

function requireParentPort(): NonNullable<typeof parentPort> {
  if (!parentPort) throw new Error('SQLite database worker requires parentPort.');
  return parentPort;
}

function serializeError(error: unknown): SerializedWorkerError {
  const value = error as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
  return {
    name: typeof value?.name === 'string' ? value.name : 'Error',
    message: typeof value?.message === 'string' ? value.message : String(error),
    ...(typeof value?.stack === 'string' ? { stack: value.stack } : {}),
    ...(typeof value?.code === 'string' ? { code: value.code } : {})
  };
}
