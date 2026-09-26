import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import {
  RUNTIME_KERNEL_EPOCH,
  type RootBinding
} from './contracts';
import {
  assertCurrentSchema,
  configureWriterConnection
} from './databaseSchema';
import {
  RUNTIME_DOMAIN_SCHEMAS,
  createRuntimeDomainIndexSql,
  createRuntimeDomainTableSql,
  domainSchemaDigest
} from './schema/domainManifest';
import { COLLABORATION_DOMAIN_SCHEMAS } from './schema/domainsCollaboration';
import { COLLABORATION_BOARD_DOMAIN_SCHEMAS } from './schema/domainsCollaborationBoard';
import type { RuntimeDomainSchema } from './schema/types';
import { migrateChildRuntimeDeliveryIntentLinks } from './runtimeDeliveryIntentLinkMigration';
import { assertRuntimeHostsOffline, withRuntimeMaintenance } from './runtimeHostControl';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import { toSqliteFilePath } from './sqliteFilePath';
import {
  RootAuthority,
  RootAuthorityError,
  parseHistoricalRootBinding,
  parseRootBinding,
  sameBindingIdentity,
  type HistoricalRootBinding
} from './rootAuthority';

export const PREVIOUS_RUNTIME_KERNEL_EPOCH = 3;
export const LATEST_PUBLISHED_RUNTIME_KERNEL_EPOCH = 4;
export const RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE = 'epoch-to-5-migration.json';
export const RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY = 'epoch-migration-backups';
const RETIRED_EPOCH_3_TO_4_JOURNAL_FILE = 'epoch-3-to-4-migration.json';

const MIGRATION_KIND = 'limcode-runtime-epoch-migration';
const MIGRATION_COMPLETION_KIND = 'limcode-runtime-epoch-migration-completion';
const EPOCH_3_ADDED_DOMAIN_KEYS = new Set([
  'ConversationAttachmentHandleLink',
  'AttachmentObservationLink',
  'CompressionBlockObservationLink',
  'RuntimeDeliveryIntentLink'
]);
const EPOCH_5_ADDED_DOMAIN_KEYS = new Set([
  ...COLLABORATION_DOMAIN_SCHEMAS,
  ...COLLABORATION_BOARD_DOMAIN_SCHEMAS
].map((schema) => schema.key));

export const PREVIOUS_RUNTIME_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = Object.freeze(
  RUNTIME_DOMAIN_SCHEMAS.filter((schema) =>
    !EPOCH_3_ADDED_DOMAIN_KEYS.has(schema.key) && !EPOCH_5_ADDED_DOMAIN_KEYS.has(schema.key))
);
export const EPOCH_4_RUNTIME_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = Object.freeze(
  RUNTIME_DOMAIN_SCHEMAS.filter((schema) => !EPOCH_5_ADDED_DOMAIN_KEYS.has(schema.key))
);
export const EPOCH_4_MISSING_DELIVERY_LINK_SCHEMAS: readonly RuntimeDomainSchema[] = Object.freeze(
  EPOCH_4_RUNTIME_DOMAIN_SCHEMAS.filter((schema) => schema.key !== 'RuntimeDeliveryIntentLink')
);

const PREVIOUS_MODEL_CONTEXT_PROJECTION_KEY = 'ModelContextProjection';
export const EPOCH_3_MODEL_CONTEXT_DETAIL_SCHEMA_DIGEST =
  '4c587475862e73a9bf2c172e29d92c047e0e60a674630ce5b54e2e921f00c760';
export const EPOCH_3_MODEL_CONTEXT_SUMMARY_SCHEMA_DIGEST =
  'f84996edbfcb6a9b62d9c42a5140cf279cf3d646e9a75872c52cbeb909c546a9';

export const PREVIOUS_RUNTIME_MANIFEST_VARIANT_CONTRACTS = Object.freeze([
  Object.freeze({
    id: 'epoch-3-v0.0.10-v0.0.12',
    modelContextProjectionClientMapping: 'detail' as const,
    modelContextProjectionSchemaDigest: EPOCH_3_MODEL_CONTEXT_DETAIL_SCHEMA_DIGEST
  }),
  Object.freeze({
    id: 'epoch-3-v0.0.13-v0.0.14',
    modelContextProjectionClientMapping: 'summary' as const,
    modelContextProjectionSchemaDigest: EPOCH_3_MODEL_CONTEXT_SUMMARY_SCHEMA_DIGEST
  })
]);

interface PreviousRuntimeManifestVariant {
  id: string;
  schemas: readonly RuntimeDomainSchema[];
  schemasByKey: ReadonlyMap<string, RuntimeDomainSchema>;
}

const PREVIOUS_RUNTIME_MANIFEST_VARIANTS: readonly PreviousRuntimeManifestVariant[] = Object.freeze(
  PREVIOUS_RUNTIME_MANIFEST_VARIANT_CONTRACTS.map((contract) => {
    const schemas = Object.freeze(PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.map((schema) =>
      schema.key === PREVIOUS_MODEL_CONTEXT_PROJECTION_KEY
        ? Object.freeze({ ...schema, client: contract.modelContextProjectionClientMapping })
        : schema
    ));
    return Object.freeze({
      id: contract.id,
      schemas,
      schemasByKey: new Map(schemas.map((schema) => [schema.key, schema]))
    });
  })
);

export type RuntimeEpochMigrationFaultPoint =
  | 'after-writer-fence'
  | 'before-backup'
  | 'after-backup'
  | 'after-database-commit'
  | 'after-pointer-publication';

export interface RuntimeEpochMigrationOptions {
  onFaultPoint?(point: RuntimeEpochMigrationFaultPoint): Promise<void> | void;
}

export interface RuntimeEpochMigrationResult {
  binding: RootBinding;
  migrated: boolean;
  previousEpoch?: 3 | 4;
  backupDirectoryName?: string;
  backupPath?: string;
}

interface RuntimeEpochMigrationJournal {
  kind: typeof MIGRATION_KIND;
  fromEpoch: typeof PREVIOUS_RUNTIME_KERNEL_EPOCH | typeof LATEST_PUBLISHED_RUNTIME_KERNEL_EPOCH;
  toEpoch: typeof RUNTIME_KERNEL_EPOCH;
  attemptId: string;
  state: 'fenced' | 'backed_up' | 'database_committed' | 'completed';
  backupDirectoryName: string;
  previousBinding: HistoricalRootBinding;
  nextBinding: RootBinding;
  databaseBackupSha256?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Read-only startup-gate preflight for the exact published epoch-3/4 predecessors and an
 * interrupted upgrade journal. Current roots without a journal stay on the ordinary attach path.
 */
export async function previousRuntimeEpochMigrationRequired(authority: RootAuthority): Promise<boolean> {
  const paths = authority.expectedPaths();
  const controlRoot = path.dirname(paths.dataRootPath);
  if (await readJournal(controlRoot)) return true;
  const initialPointer = await authority.readHistoricalPointerForCutover();
  return isSupportedPreviousEpoch(initialPointer?.runtimeKernelEpoch);
}

/**
 * Upgrades exact published epoch-3 or epoch-4 SQLite/CAS roots to epoch 5 before the Runtime
 * opens. Existing rows and CAS objects remain in place. A verified SQLite backup and durable
 * journal precede the single-transaction schema change. Epoch 3 and the exact epoch-4 predecessor
 * missing only RuntimeDeliveryIntentLink use the bounded Child continuation conversion. Unknown
 * epochs and drift are never guessed.
 *
 * The mutation holds the Runtime maintenance claim and requires every registered Host to be
 * offline; the read-only "not required" branch performs neither.
 */
export async function migratePreviousRuntimeEpochIfRequired(
  authority: RootAuthority,
  options: RuntimeEpochMigrationOptions = {}
): Promise<RuntimeEpochMigrationResult | undefined> {
  const paths = authority.expectedPaths();
  const controlRoot = path.dirname(paths.dataRootPath);
  const existingJournal = await readJournal(controlRoot);
  const initialPointer = await authority.readHistoricalPointerForCutover();
  if (
    !existingJournal
    && !isSupportedPreviousEpoch(initialPointer?.runtimeKernelEpoch)
  ) {
    return undefined;
  }

  return withRuntimeMaintenance(paths, async () => {
    await assertRuntimeHostsOffline(paths);
    await recoverRetiredEpoch3To4Boundary(authority, controlRoot);
    let journal = await readJournal(controlRoot);
    const previous = await authority.readHistoricalPointerForCutover();
    if (previous?.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) {
      const binding = await authority.current();
      if (journal) {
        if (!sameBindingIdentity(binding, journal.nextBinding)) {
          throw new RootAuthorityError(
            'runtime-epoch-migration-conflict',
            'Completed pointer does not match the epoch migration journal.'
          );
        }
        await verifyExistingBackup(controlRoot, journal);
        journal.state = 'completed';
        journal.updatedAt = new Date().toISOString();
        await writeJournal(controlRoot, journal);
        await finalizeJournal(controlRoot, journal);
      }
      return {
        binding,
        migrated: Boolean(journal),
        ...(journal ? {
          previousEpoch: journal.fromEpoch,
          backupDirectoryName: journal.backupDirectoryName,
          backupPath: backupRootPath(controlRoot, journal)
        } : {})
      };
    }
    if (!previous || !isSupportedPreviousEpoch(previous.runtimeKernelEpoch)) {
      throw new RootAuthorityError(
        'runtime-epoch-migration-unsupported',
        'The historical Runtime pointer is missing or is not an exact published epoch-3/4 predecessor.'
      );
    }

    if (!journal) await assertPreviousEpochRoot(previous);
    const next = await authority.stageInPlaceEpochMigration(previous);
    await fault(options, 'after-writer-fence');

    if (!journal) {
      const attemptId = randomUUID();
      journal = {
        kind: MIGRATION_KIND,
        fromEpoch: previous.runtimeKernelEpoch,
        toEpoch: RUNTIME_KERNEL_EPOCH,
        attemptId,
        state: 'fenced',
        backupDirectoryName: `${timestampSlug()}-${attemptId.slice(0, 8)}`,
        previousBinding: previous,
        nextBinding: next,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await writeJournal(controlRoot, journal);
    } else {
      assertJournalBindings(journal, previous, next);
    }

    const databaseState = inspectDatabaseBindingState(previous.paths.databasePath, previous, next);
    if (databaseState === 'previous') {
      await assertPreviousEpochRoot(previous);
      if (journal.state === 'fenced') {
        await fault(options, 'before-backup');
        journal.databaseBackupSha256 = await ensureDatabaseBackup(controlRoot, journal);
        journal.state = 'backed_up';
        journal.updatedAt = new Date().toISOString();
        await writeJournal(controlRoot, journal);
        await fault(options, 'after-backup');
      } else {
        await verifyExistingBackup(controlRoot, journal);
      }
      await migrateDatabase(previous.paths.databasePath, previous, next);
    } else if (databaseState === 'current') {
      if (journal.state === 'fenced') {
        throw new RootAuthorityError(
          'runtime-epoch-migration-conflict',
          'Runtime database is upgraded but the durable predecessor backup was never recorded.'
        );
      }
      await verifyExistingBackup(controlRoot, journal);
    } else {
      throw new RootAuthorityError(
        'runtime-epoch-migration-conflict',
        'Runtime database binding matches neither side of the epoch migration journal.'
      );
    }
    journal.state = 'database_committed';
    journal.updatedAt = new Date().toISOString();
    await writeJournal(controlRoot, journal);
    await fault(options, 'after-database-commit');

    const binding = await authority.commitInPlaceEpochMigration(previous, next);
    await fault(options, 'after-pointer-publication');
    journal.state = 'completed';
    journal.updatedAt = new Date().toISOString();
    await writeJournal(controlRoot, journal);
    await finalizeJournal(controlRoot, journal);
    return {
      binding,
      migrated: true,
      previousEpoch: previous.runtimeKernelEpoch as 3 | 4,
      backupDirectoryName: journal.backupDirectoryName,
      backupPath: backupRootPath(controlRoot, journal)
    };
  });
}

function isSupportedPreviousEpoch(epoch: number | undefined): epoch is 3 | 4 {
  return epoch === PREVIOUS_RUNTIME_KERNEL_EPOCH || epoch === LATEST_PUBLISHED_RUNTIME_KERNEL_EPOCH;
}

interface RetiredEpoch3To4Journal {
  state: 'fenced' | 'backed_up' | 'database_committed' | 'completed';
  backupDirectoryName: string;
  databaseBackupSha256?: string;
  previousBinding: HistoricalRootBinding;
  nextBinding: HistoricalRootBinding;
}

/**
 * A v0.0.15–0.0.21 process may have stopped inside its published 3→4 upgrade. Its pending
 * pointer cannot be mistaken for our 3/4→5 journal. Finish that exact durable boundary first:
 * an untouched epoch-3 database drops the old fence; an already-committed epoch-4 database
 * publishes its verified pending binding. Both then enter the ordinary exact upgrade below.
 */
async function recoverRetiredEpoch3To4Boundary(authority: RootAuthority, controlRoot: string): Promise<void> {
  const paths = authority.expectedPaths();
  const previous = await authority.readHistoricalPointerForCutover();
  if (previous?.runtimeKernelEpoch !== 3) return;
  const pendingValue = await readJsonIfExists(paths.rootPendingPath);
  const pending = pendingValue === undefined ? undefined : parseHistoricalRootBinding(pendingValue);
  const journalFile = path.join(controlRoot, RETIRED_EPOCH_3_TO_4_JOURNAL_FILE);
  const journal = await readRetiredEpoch3To4Journal(journalFile);
  if (pending?.runtimeKernelEpoch !== 4 && !journal) return;

  const expected: HistoricalRootBinding = {
    ...previous,
    rootGeneration: previous.rootGeneration + 1,
    pointerRevision: previous.pointerRevision + 1,
    runtimeKernelEpoch: 4
  };
  if ((pending && !historicalBindingsEqual(pending, expected))
    || (journal && (!historicalBindingsEqual(journal.previousBinding, previous)
      || !historicalBindingsEqual(journal.nextBinding, expected)))) {
    throw new RootAuthorityError(
      'runtime-retired-epoch-migration-conflict',
      'The retired epoch-3→4 pending pointer or journal does not match the old Runtime identity.'
    );
  }

  const database = new Database(toSqliteFilePath(paths.databasePath), { readonly: true, fileMustExist: true });
  let state: 'epoch3' | 'epoch4';
  try {
    database.defaultSafeIntegers(true);
    const row = database.prepare('SELECT * FROM root_binding WHERE singleton = 1').get() as
      | Record<string, unknown> | undefined;
    if (row && storedBindingMatches(row, previous)) {
      assertPreviousEpochDatabase(database, previous);
      state = 'epoch3';
    } else if (row && storedBindingMatches(row, expected)) {
      assertPreviousEpochDatabase(database, expected);
      state = 'epoch4';
    } else {
      throw new RootAuthorityError(
        'runtime-retired-epoch-migration-conflict',
        'The retired migration database matches neither its epoch-3 nor epoch-4 binding.'
      );
    }
  } finally { database.close(); }

  if (state === 'epoch3') {
    await assertPreviousEpochManifest(previous);
    if (journal?.databaseBackupSha256) await verifyRetiredEpoch3Backup(controlRoot, journal);
    await fs.rm(journalFile, { force: true });
    await fs.rm(paths.rootPendingPath, { force: true });
    await syncDirectory(controlRoot);
    return;
  }

  if (!journal || !pending || !journal.databaseBackupSha256) {
    throw new RootAuthorityError(
      'runtime-retired-epoch-migration-backup-missing',
      'The retired epoch-3→4 database committed without its verified predecessor backup.'
    );
  }
  await verifyRetiredEpoch3Backup(controlRoot, journal);
  await publishRetiredEpoch4Manifest(paths.runtimeEpochPath, previous, expected);
  await writeDurableJson(paths.rootPointerPath, expected);
  await fs.rm(paths.rootPendingPath, { force: true });
  await fs.rm(journalFile, { force: true });
  await syncDirectory(controlRoot);
}

async function readRetiredEpoch3To4Journal(file: string): Promise<RetiredEpoch3To4Journal | undefined> {
  const value = await readJsonIfExists(file);
  if (value === undefined) return undefined;
  const record = requireRecord(value, 'RetiredEpoch3To4Journal');
  const states = new Set(['fenced', 'backed_up', 'database_committed', 'completed']);
  if (record.kind !== MIGRATION_KIND || record.fromEpoch !== 3 || record.toEpoch !== 4
    || !states.has(String(record.state)) || typeof record.backupDirectoryName !== 'string'
    || !/^[0-9TZ-]+-[a-f0-9]{8}$/.test(record.backupDirectoryName)
    || (record.databaseBackupSha256 !== undefined
      && (typeof record.databaseBackupSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.databaseBackupSha256)))) {
    throw new RootAuthorityError('runtime-retired-epoch-migration-journal-invalid',
      'The retired epoch-3→4 migration journal is invalid.');
  }
  return {
    state: record.state as RetiredEpoch3To4Journal['state'],
    backupDirectoryName: record.backupDirectoryName,
    ...(typeof record.databaseBackupSha256 === 'string'
      ? { databaseBackupSha256: record.databaseBackupSha256 } : {}),
    previousBinding: parseHistoricalRootBinding(record.previousBinding),
    nextBinding: parseHistoricalRootBinding(record.nextBinding)
  };
}

async function verifyRetiredEpoch3Backup(controlRoot: string, journal: RetiredEpoch3To4Journal): Promise<void> {
  const directory = backupRootPath(controlRoot, journal);
  const file = path.join(directory, 'limcode.epoch-3.sqlite');
  if (!journal.databaseBackupSha256 || !await exists(file)) {
    throw new RootAuthorityError('runtime-retired-epoch-migration-backup-missing',
      'The retired epoch-3→4 predecessor backup is missing.');
  }
  const savedBinding = parseHistoricalRootBinding(await readJsonIfExists(
    path.join(directory, 'root-binding.epoch-3.json')));
  if (!historicalBindingsEqual(savedBinding, journal.previousBinding)) {
    throw new RootAuthorityError('runtime-retired-epoch-migration-backup-invalid',
      'The retired predecessor backup binding changed.');
  }
  try {
    verifyBackupDatabase(file, journal.previousBinding);
    if (await sha256File(file) !== journal.databaseBackupSha256) {
      throw new RootAuthorityError('runtime-retired-epoch-migration-backup-invalid',
        'The retired predecessor SQLite backup digest changed.');
    }
  } finally {
    await removeSqliteSidecars(file);
    await syncDirectory(directory);
  }
}

async function publishRetiredEpoch4Manifest(
  file: string, previous: HistoricalRootBinding, next: HistoricalRootBinding
): Promise<void> {
  const epoch = requireRecord(await readJsonIfExists(file), 'RetiredRuntimeEpochManifest');
  const matches = (binding: HistoricalRootBinding): boolean =>
    Object.keys(epoch).sort().join(',') === 'dataSetId,initializedAt,kind,rootGeneration,rootInstanceId,runtimeKernelEpoch'
    && epoch.kind === 'limcode-runtime-kernel-epoch'
    && typeof epoch.initializedAt === 'string' && epoch.initializedAt.length > 0
    && epoch.dataSetId === binding.dataSetId && epoch.rootInstanceId === binding.rootInstanceId
    && epoch.rootGeneration === binding.rootGeneration
    && epoch.runtimeKernelEpoch === binding.runtimeKernelEpoch;
  if (matches(next)) return;
  if (!matches(previous)) {
    throw new RootAuthorityError('runtime-retired-epoch-migration-epoch-invalid',
      'The retired epoch manifest matches neither side of the old upgrade.');
  }
  await writeDurableJson(file, {
    ...epoch, runtimeKernelEpoch: next.runtimeKernelEpoch,
    rootGeneration: next.rootGeneration, initializedAt: new Date().toISOString()
  });
}

async function assertPreviousEpochRoot(binding: HistoricalRootBinding): Promise<void> {
  await assertPreviousEpochManifest(binding);
  const casStat = await fs.stat(binding.paths.casRootPath).catch((error: unknown) => {
    throw new RootAuthorityError(
      'runtime-epoch-migration-cas-missing',
      `Historical Runtime CAS root cannot be read: ${binding.paths.casRootPath}`,
      error
    );
  });
  if (!casStat.isDirectory()) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-cas-missing',
      `Historical Runtime CAS root is not a directory: ${binding.paths.casRootPath}`
    );
  }
  assertPreviousEpochDatabaseFile(binding);
}

async function assertPreviousEpochManifest(binding: HistoricalRootBinding): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8')) as unknown;
  } catch (error) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-epoch-invalid',
      `Historical Runtime manifest cannot be read: ${binding.paths.runtimeEpochPath}`,
      error
    );
  }
  const record = requireRecord(value, 'RuntimeEpochManifest');
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [
    'kind',
    'runtimeKernelEpoch',
    'dataSetId',
    'rootInstanceId',
    'rootGeneration',
    'initializedAt'
  ].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || record.kind !== 'limcode-runtime-kernel-epoch'
    || record.runtimeKernelEpoch !== binding.runtimeKernelEpoch
    || record.dataSetId !== binding.dataSetId
    || record.rootInstanceId !== binding.rootInstanceId
    || record.rootGeneration !== binding.rootGeneration
    || typeof record.initializedAt !== 'string'
    || record.initializedAt.length === 0
  ) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-epoch-invalid',
      'Historical Runtime manifest does not match its RootBinding.'
    );
  }
}

function assertPreviousEpochDatabaseFile(binding: HistoricalRootBinding): void {
  const database = new Database(toSqliteFilePath(binding.paths.databasePath), { readonly: true, fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    assertPreviousEpochDatabase(database, binding);
  } finally {
    database.close();
  }
}

function assertPreviousEpochDatabase(
  database: Database.Database,
  binding: HistoricalRootBinding
): readonly RuntimeDomainSchema[] {
  const quickCheck = database.pragma('quick_check') as Array<{ quick_check: string }>;
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new RootAuthorityError(
      'runtime-epoch-migration-integrity',
      'Historical Runtime SQLite quick_check failed.'
    );
  }
  assertStoredBinding(database, binding);
  const schemas = previousSchemas(database, binding.runtimeKernelEpoch);

  try {
    assertRuntimePhysicalSchemaFingerprint(database, schemas, {
      label: `Epoch-${binding.runtimeKernelEpoch} Runtime physical`
    });
  } catch (error) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-schema-mismatch',
      error instanceof Error ? error.message : 'Historical Runtime physical DDL fingerprint mismatch.',
      error
    );
  }

  const rows = database.prepare(
    'SELECT * FROM schema_manifest ORDER BY domain_key'
  ).all() as Array<Record<string, unknown>>;
  assertPublishedPreviousEpochManifest(rows, binding.runtimeKernelEpoch, schemas);

  const violations = database.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-integrity',
      `Historical Runtime database has ${violations.length} foreign key violations.`
    );
  }
  return schemas;
}

async function migrateDatabase(
  file: string,
  previous: HistoricalRootBinding,
  next: RootBinding
): Promise<void> {
  const database = new Database(toSqliteFilePath(file), { fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    configureWriterConnection(database);
    const predecessorSchemas = assertPreviousEpochDatabase(database, previous);
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      const previousKeys = new Set(predecessorSchemas.map((schema) => schema.key));
      const added = RUNTIME_DOMAIN_SCHEMAS.filter((schema) => !previousKeys.has(schema.key));
      for (const schema of added) {
        database.exec(createRuntimeDomainTableSql(schema));
        schema.indexes.forEach((index, ordinal) =>
          database.exec(createRuntimeDomainIndexSql(schema, index, ordinal))
        );
      }
      if (!previousKeys.has('RuntimeDeliveryIntentLink')) {
        await migrateChildRuntimeDeliveryIntentLinks(database, previous.paths.casRootPath);
      }
      replaceSchemaManifest(database);
      const update = database.prepare(`
        UPDATE root_binding
           SET root_generation = @rootGeneration,
               pointer_revision = @pointerRevision,
               runtime_kernel_epoch = @runtimeKernelEpoch
         WHERE singleton = 1
           AND data_set_id = @dataSetId
           AND root_instance_id = @rootInstanceId
           AND root_generation = @previousRootGeneration
           AND pointer_revision = @previousPointerRevision
           AND runtime_kernel_epoch = @previousEpoch
      `).run({
        rootGeneration: BigInt(next.rootGeneration),
        pointerRevision: BigInt(next.pointerRevision),
        runtimeKernelEpoch: BigInt(next.runtimeKernelEpoch),
        dataSetId: previous.dataSetId,
        rootInstanceId: previous.rootInstanceId,
        previousRootGeneration: BigInt(previous.rootGeneration),
        previousPointerRevision: BigInt(previous.pointerRevision),
        previousEpoch: BigInt(previous.runtimeKernelEpoch)
      });
      if (update.changes !== 1) {
        throw new RootAuthorityError(
          'runtime-epoch-migration-binding-mismatch',
          'Historical Runtime root_binding compare-and-swap failed.'
        );
      }
      const violations = database.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new RootAuthorityError(
          'runtime-epoch-migration-integrity',
          `Upgraded Runtime has ${violations.length} foreign key violations.`
        );
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      database.pragma('foreign_keys = ON');
    }
    assertCurrentSchema(database, next);
    database.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-failed',
      'Historical Runtime SQLite migration failed.',
      error
    );
  } finally {
    database.close();
  }
}

function replaceSchemaManifest(database: Database.Database): void {
  database.exec('DELETE FROM schema_manifest');
  const insert = database.prepare(`
    INSERT INTO schema_manifest (
      domain_key, table_name, schema_owner, repository_name, codec_name,
      mutations_json, client_mapping, delete_policy, reset_policy, indexes_json,
      schema_digest, runtime_kernel_epoch
    ) VALUES (
      @domainKey, @tableName, @schemaOwner, @repositoryName, @codecName,
      @mutationsJson, @clientMapping, @deletePolicy, @resetPolicy, @indexesJson,
      @schemaDigest, @runtimeKernelEpoch
    )
  `);
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    insert.run({
      domainKey: schema.key,
      tableName: schema.table,
      schemaOwner: schema.schemaOwner,
      repositoryName: schema.repository,
      codecName: schema.codec,
      mutationsJson: JSON.stringify(schema.mutations),
      clientMapping: schema.client,
      deletePolicy: schema.deletePolicy,
      resetPolicy: schema.resetPolicy,
      indexesJson: JSON.stringify(schema.indexes),
      schemaDigest: domainSchemaDigest(schema),
      runtimeKernelEpoch: BigInt(RUNTIME_KERNEL_EPOCH)
    });
  }
}

function inspectDatabaseBindingState(
  file: string,
  previous: HistoricalRootBinding,
  next: RootBinding
): 'previous' | 'current' | 'unknown' {
  const database = new Database(toSqliteFilePath(file), { readonly: true, fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    const row = database.prepare(
      'SELECT * FROM root_binding WHERE singleton = 1'
    ).get() as Record<string, unknown> | undefined;
    if (!row) return 'unknown';
    if (storedBindingMatches(row, previous)) return 'previous';
    if (storedBindingMatches(row, next)) {
      assertCurrentSchema(database, next);
      return 'current';
    }
    return 'unknown';
  } finally {
    database.close();
  }
}

async function ensureDatabaseBackup(
  controlRoot: string,
  journal: RuntimeEpochMigrationJournal
): Promise<string> {
  const backupRoot = backupRootPath(controlRoot, journal);
  await ensureSecureDirectory(backupRoot);
  await writeDurableJson(
    path.join(backupRoot, `root-binding.epoch-${journal.fromEpoch}.json`),
    journal.previousBinding
  );
  const previousEpoch = JSON.parse(
    await fs.readFile(journal.previousBinding.paths.runtimeEpochPath, 'utf8')
  ) as unknown;
  await writeDurableJson(
    path.join(backupRoot, `runtime-kernel-epoch.epoch-${journal.fromEpoch}.json`),
    previousEpoch
  );
  const destination = path.join(backupRoot, `limcode.epoch-${journal.fromEpoch}.sqlite`);
  const temporary = `${destination}.${process.pid}.tmp`;
  if (!await exists(destination)) {
    await fs.rm(temporary, { force: true });
    await removeSqliteSidecars(temporary);
    const source = new Database(
      toSqliteFilePath(journal.previousBinding.paths.databasePath),
      { readonly: true, fileMustExist: true }
    );
    try {
      try {
        await source.backup(toSqliteFilePath(temporary));
      } catch (error) {
        throw runtimeEpochBackupError('create', temporary, error);
      }
    } finally {
      source.close();
    }
    await fs.chmod(temporary, 0o600);
    try {
      verifyBackupDatabase(temporary, journal.previousBinding);
    } finally {
      await removeSqliteSidecars(temporary);
    }
    await fs.rename(temporary, destination);
    await syncDirectory(backupRoot);
  }
  try {
    verifyBackupDatabase(destination, journal.previousBinding);
    return await sha256File(destination);
  } finally {
    await removeSqliteSidecars(destination);
    await syncDirectory(backupRoot);
  }
}

async function verifyExistingBackup(
  controlRoot: string,
  journal: RuntimeEpochMigrationJournal
): Promise<void> {
  const destination = path.join(
    backupRootPath(controlRoot, journal),
    `limcode.epoch-${journal.fromEpoch}.sqlite`
  );
  if (!journal.databaseBackupSha256 || !await exists(destination)) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-backup-missing',
      'Epoch migration backup is missing.'
    );
  }
  try {
    verifyBackupDatabase(destination, journal.previousBinding);
    if (await sha256File(destination) !== journal.databaseBackupSha256) {
      throw new RootAuthorityError(
        'runtime-epoch-migration-backup-invalid',
        'Epoch migration backup digest changed.'
      );
    }
  } finally {
    await removeSqliteSidecars(destination);
    await syncDirectory(path.dirname(destination));
  }
}

function verifyBackupDatabase(file: string, previous: HistoricalRootBinding): void {
  const database = new Database(toSqliteFilePath(file), { readonly: true, fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    assertPreviousEpochDatabase(database, previous);
  } finally {
    database.close();
  }
}

function runtimeEpochBackupError(stage: string, file: string, cause: unknown): RootAuthorityError {
  const code = typeof (cause as { code?: unknown } | null)?.code === 'string'
    ? `; SQLite code ${(cause as { code: string }).code}`
    : '';
  return new RootAuthorityError(
    'runtime-epoch-migration-backup-failed',
    `Runtime SQLite backup ${stage} failed${code}; path length ${file.length}.`,
    cause
  );
}

async function removeSqliteSidecars(file: string): Promise<void> {
  await Promise.all([
    fs.rm(`${file}-wal`, { force: true }),
    fs.rm(`${file}-shm`, { force: true })
  ]);
}

async function finalizeJournal(
  controlRoot: string,
  journal: RuntimeEpochMigrationJournal
): Promise<void> {
  const backupRoot = backupRootPath(controlRoot, journal);
  await writeDurableJson(
    path.join(backupRoot, 'epoch-migration-journal.completed.json'),
    journal
  );
  await writeDurableJson(path.join(backupRoot, 'epoch-migration-completion.json'), {
    kind: MIGRATION_COMPLETION_KIND,
    attemptId: journal.attemptId,
    fromEpoch: journal.fromEpoch,
    toEpoch: journal.toEpoch,
    previousBinding: journal.previousBinding,
    nextBinding: journal.nextBinding,
    databaseBackupSha256: journal.databaseBackupSha256,
    completedAt: new Date().toISOString()
  });
  await fs.rm(journalPath(controlRoot), { force: true });
  await syncDirectory(controlRoot);
}

async function readJournal(
  controlRoot: string
): Promise<RuntimeEpochMigrationJournal | undefined> {
  const value = await readJsonIfExists(journalPath(controlRoot));
  if (value === undefined) return undefined;
  const record = requireRecord(value, 'RuntimeEpochMigrationJournal');
  const states = new Set(['fenced', 'backed_up', 'database_committed', 'completed']);
  if (
    record.kind !== MIGRATION_KIND
    || !isSupportedPreviousEpoch(record.fromEpoch as number)
    || record.toEpoch !== RUNTIME_KERNEL_EPOCH
    || typeof record.attemptId !== 'string'
    || !states.has(String(record.state))
    || typeof record.backupDirectoryName !== 'string'
    || !/^[0-9TZ-]+-[a-f0-9]{8}$/.test(record.backupDirectoryName)
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
  ) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-journal-invalid',
      'Runtime epoch migration journal is invalid.'
    );
  }
  const previousBinding = parseHistoricalRootBinding(record.previousBinding);
  const nextBinding = parseRootBinding(record.nextBinding);
  if (
    previousBinding.runtimeKernelEpoch !== record.fromEpoch
    || nextBinding.runtimeKernelEpoch !== record.toEpoch
    || previousBinding.dataSetId !== nextBinding.dataSetId
    || previousBinding.rootInstanceId !== nextBinding.rootInstanceId
    || nextBinding.rootGeneration !== previousBinding.rootGeneration + 1
    || nextBinding.pointerRevision !== previousBinding.pointerRevision + 1
    || JSON.stringify(previousBinding.paths) !== JSON.stringify(nextBinding.paths)
  ) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-journal-invalid',
      'Runtime epoch migration journal binding chain is invalid.'
    );
  }
  return {
    kind: MIGRATION_KIND,
    fromEpoch: record.fromEpoch as RuntimeEpochMigrationJournal['fromEpoch'],
    toEpoch: RUNTIME_KERNEL_EPOCH,
    attemptId: record.attemptId,
    state: record.state as RuntimeEpochMigrationJournal['state'],
    backupDirectoryName: record.backupDirectoryName,
    previousBinding,
    nextBinding,
    ...(typeof record.databaseBackupSha256 === 'string'
      ? { databaseBackupSha256: record.databaseBackupSha256 }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function writeJournal(
  controlRoot: string,
  journal: RuntimeEpochMigrationJournal
): Promise<void> {
  await writeDurableJson(journalPath(controlRoot), journal);
}

function assertJournalBindings(
  journal: RuntimeEpochMigrationJournal,
  previous: HistoricalRootBinding,
  next: RootBinding
): void {
  if (
    journal.fromEpoch !== previous.runtimeKernelEpoch
    || journal.toEpoch !== next.runtimeKernelEpoch
    || !historicalBindingsEqual(journal.previousBinding, previous)
    || !sameBindingIdentity(journal.nextBinding, next)
  ) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-conflict',
      'Runtime epoch migration journal binding identity changed.'
    );
  }
}

function assertStoredBinding(
  database: Database.Database,
  expected: HistoricalRootBinding
): void {
  const row = database.prepare(
    'SELECT * FROM root_binding WHERE singleton = 1'
  ).get() as Record<string, unknown> | undefined;
  if (!row || !storedBindingMatches(row, expected)) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-binding-mismatch',
      'Historical Runtime database RootBinding does not match its pointer.'
    );
  }
}

function storedBindingMatches(
  row: Record<string, unknown>,
  expected: HistoricalRootBinding
): boolean {
  return row.data_root_path === expected.paths.dataRootPath
    && row.database_path === expected.paths.databasePath
    && row.cas_root_path === expected.paths.casRootPath
    && row.root_pointer_path === expected.paths.rootPointerPath
    && row.root_pending_path === expected.paths.rootPendingPath
    && row.runtime_epoch_path === expected.paths.runtimeEpochPath
    && row.data_set_id === expected.dataSetId
    && row.root_instance_id === expected.rootInstanceId
    && row.root_generation === BigInt(expected.rootGeneration)
    && row.pointer_revision === BigInt(expected.pointerRevision)
    && row.runtime_kernel_epoch === BigInt(expected.runtimeKernelEpoch);
}

function assertPublishedPreviousEpochManifest(
  rows: Array<Record<string, unknown>>, epoch: number, schemas: readonly RuntimeDomainSchema[]
): void {
  if (rows.length !== schemas.length) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-schema-mismatch',
      `Epoch-${epoch} schema manifest domain count is invalid.`
    );
  }
  if (epoch === LATEST_PUBLISHED_RUNTIME_KERNEL_EPOCH) {
    const byKey = new Map(schemas.map((schema) => [schema.key, schema]));
    const mismatch = rows.find((row) => {
      const schema = byKey.get(requireText(row.domain_key, 'schema_manifest.domain_key'));
      return !schema || !manifestMatches(row, schema, epoch);
    });
    if (!mismatch) return;
    throw new RootAuthorityError(
      'runtime-epoch-migration-schema-mismatch',
      `Epoch-${epoch} schema manifest mismatch for ${String(mismatch.domain_key)}.`
    );
  }
  for (const variant of PREVIOUS_RUNTIME_MANIFEST_VARIANTS) {
    if (rows.every((row) => {
      const key = requireText(row.domain_key, 'schema_manifest.domain_key');
      const schema = variant.schemasByKey.get(key);
      return Boolean(schema && manifestMatches(row, schema, PREVIOUS_RUNTIME_KERNEL_EPOCH));
    })) return;
  }
  const mismatch = rows.find((row) => {
    const key = requireText(row.domain_key, 'schema_manifest.domain_key');
    return PREVIOUS_RUNTIME_MANIFEST_VARIANTS.every((variant) => {
      const schema = variant.schemasByKey.get(key);
      return !schema || !manifestMatches(row, schema, PREVIOUS_RUNTIME_KERNEL_EPOCH);
    });
  });
  const key = mismatch
    ? requireText(mismatch.domain_key, 'schema_manifest.domain_key')
    : '<mixed-published-variants>';
  throw new RootAuthorityError(
    'runtime-epoch-migration-schema-mismatch',
    `Historical Runtime schema manifest mismatch for ${key}.`
  );
}

function previousSchemas(database: Database.Database, epoch: number): readonly RuntimeDomainSchema[] {
  if (epoch === PREVIOUS_RUNTIME_KERNEL_EPOCH) return PREVIOUS_RUNTIME_DOMAIN_SCHEMAS;
  if (epoch === LATEST_PUBLISHED_RUNTIME_KERNEL_EPOCH) {
    const count = (database.prepare('SELECT COUNT(*) AS count FROM schema_manifest').get() as { count: bigint }).count;
    if (count === BigInt(EPOCH_4_RUNTIME_DOMAIN_SCHEMAS.length)) return EPOCH_4_RUNTIME_DOMAIN_SCHEMAS;
    if (count === BigInt(EPOCH_4_MISSING_DELIVERY_LINK_SCHEMAS.length)) {
      return EPOCH_4_MISSING_DELIVERY_LINK_SCHEMAS;
    }
  }
  throw new RootAuthorityError('runtime-epoch-migration-unsupported', `Unsupported Runtime epoch ${epoch}.`);
}

function manifestMatches(
  row: Record<string, unknown>,
  schema: RuntimeDomainSchema,
  epoch: number
): boolean {
  return row.table_name === schema.table
    && row.schema_owner === schema.schemaOwner
    && row.repository_name === schema.repository
    && row.codec_name === schema.codec
    && row.mutations_json === JSON.stringify(schema.mutations)
    && row.client_mapping === schema.client
    && row.delete_policy === schema.deletePolicy
    && row.reset_policy === schema.resetPolicy
    && row.indexes_json === JSON.stringify(schema.indexes)
    && row.schema_digest === domainSchemaDigest(schema)
    && row.runtime_kernel_epoch === BigInt(epoch);
}

function historicalBindingsEqual(
  left: HistoricalRootBinding,
  right: HistoricalRootBinding
): boolean {
  return left.dataSetId === right.dataSetId
    && left.rootInstanceId === right.rootInstanceId
    && left.rootGeneration === right.rootGeneration
    && left.pointerRevision === right.pointerRevision
    && left.runtimeKernelEpoch === right.runtimeKernelEpoch
    && JSON.stringify(left.paths) === JSON.stringify(right.paths);
}

function journalPath(controlRoot: string): string {
  return path.join(controlRoot, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE);
}

function backupRootPath(
  controlRoot: string,
  journal: Pick<RuntimeEpochMigrationJournal, 'backupDirectoryName'>
): string {
  return path.join(
    controlRoot,
    RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
    journal.backupDirectoryName
  );
}

async function writeDurableJson(file: string, value: unknown): Promise<void> {
  await ensureSecureDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
  await syncDirectory(path.dirname(file));
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function syncDirectory(directory: string): Promise<void> {
  await syncDirectoryDurably(directory);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fault(
  options: RuntimeEpochMigrationOptions,
  point: RuntimeEpochMigrationFaultPoint
): Promise<void> {
  await options.onFaultPoint?.(point);
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`);
  return value;
}

if (RUNTIME_KERNEL_EPOCH !== 5) {
  throw new Error('The published epoch-3/4 migration is valid only for epoch 5.');
}

if (PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.length !== 87) {
  throw new Error(
    `Historical Runtime migration contract must contain 87 domains, found ${PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.length}.`
  );
}

if (EPOCH_4_RUNTIME_DOMAIN_SCHEMAS.length !== 91
  || EPOCH_4_MISSING_DELIVERY_LINK_SCHEMAS.length !== 90
  || EPOCH_5_ADDED_DOMAIN_KEYS.size !== 16) {
  throw new Error('Epoch-4 to epoch-5 migration domain set changed.');
}

for (const variant of PREVIOUS_RUNTIME_MANIFEST_VARIANTS) {
  if (variant.schemas.length !== PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.length) {
    throw new Error(`Historical Runtime published manifest variant ${variant.id} has an invalid domain count.`);
  }
  const modelContextProjection = variant.schemasByKey.get(PREVIOUS_MODEL_CONTEXT_PROJECTION_KEY);
  const contract = PREVIOUS_RUNTIME_MANIFEST_VARIANT_CONTRACTS.find((candidate) => candidate.id === variant.id);
  if (
    !modelContextProjection
    || !contract
    || modelContextProjection.client !== contract.modelContextProjectionClientMapping
    || domainSchemaDigest(modelContextProjection) !== contract.modelContextProjectionSchemaDigest
  ) {
    throw new Error(`Historical Runtime published manifest variant ${variant.id} fingerprint changed.`);
  }
}
