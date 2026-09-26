import type Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import { RUNTIME_KERNEL_EPOCH, createRuntimeRootPaths, type RootBinding } from './contracts';
import { assertCurrentSchema } from './databaseSchema';
import { assertPublishedPreviousRuntimeEpochSnapshot } from './runtimeEpochMigration';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import { createRuntimeDataSetDatabaseSnapshot, requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import type { VscodeRuntimeDataSetCandidate } from './vscodeRootAuthority';

/** Why a data set cannot be opened or merged as it is; `code` is stable for records. */
export interface RuntimeDataSetPreflightProblem {
  code: string;
  message: string;
}

/** Human-facing facts of one data set, for choosing between data sets without reading UUIDs. */
export interface RuntimeDataSetSummary {
  /** Project folder names recorded in the data set, most conversations first. */
  projectNames: string[];
  conversationCount: number;
  /** Latest Conversation.updated_at, when any conversation exists. */
  lastActivityAt?: string;
}

/**
 * Read-only check that a data set can be opened (after the exact published 3/4 upgrade when
 * needed): recognized epoch, complete binding, and the same integrity and physical fingerprint
 * checks the upgrade or open would perform. A pending recovery window passes to its gate.
 * Nothing is written; the SQLite file is read through a private snapshot copy. Never call it for
 * a database this process has open: copying its files would release this process's POSIX locks.
 */
export async function preflightRuntimeDataSet(
  candidate: VscodeRuntimeDataSetCandidate
): Promise<RuntimeDataSetPreflightProblem | undefined> {
  const epoch = candidate.runtimeKernelEpoch;
  if (!candidate.dataSetId || epoch === undefined) return { code: 'runtime-data-set-empty', message: '这个历史库还没有数据。' };
  if (epoch !== 3 && epoch !== 4 && epoch !== RUNTIME_KERNEL_EPOCH) {
    return { code: 'runtime-data-set-epoch-unsupported', message: `这个历史库是不受支持的第 ${epoch} 代格式。` };
  }
  // An interrupted archive/cutover or root transition is an exact published recovery window: the
  // existing offline startup gate completes or rolls it back before anything opens, and judges it.
  if (candidate.requiresRecovery || await pathExists(createRuntimeRootPaths(candidate.runtimeDataRootPath).rootPendingPath)) {
    return undefined;
  }
  try {
    const binding = await requireCompleteRuntimeDataSet(candidate);
    const snapshot = await createRuntimeDataSetDatabaseSnapshot(candidate, binding);
    try {
      if (binding.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) {
        assertCurrentSchema(snapshot.database, binding as RootBinding);
        assertRuntimePhysicalSchemaFingerprint(snapshot.database, RUNTIME_DOMAIN_SCHEMAS);
      } else {
        await assertPublishedPreviousRuntimeEpochSnapshot(snapshot.database, binding);
      }
    } finally {
      await snapshot.close();
    }
  } catch (error) {
    return {
      code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'runtime-data-set-preflight-failed',
      message: `这个历史库的结构或完整性核验未通过：${error instanceof Error ? error.message : String(error)}`
    };
  }
  return undefined;
}

/**
 * Names, conversation count and last activity of a data set from a private snapshot copy. Older
 * formats without project links still report counts. Same POSIX lock rule as the preflight.
 */
export async function summarizeRuntimeDataSet(candidate: VscodeRuntimeDataSetCandidate): Promise<RuntimeDataSetSummary | undefined> {
  if (!candidate.dataSetId) return undefined;
  try {
    const binding = await requireCompleteRuntimeDataSet(candidate);
    const snapshot = await createRuntimeDataSetDatabaseSnapshot(candidate, binding);
    try {
      return readSummary(snapshot.database);
    } finally {
      await snapshot.close();
    }
  } catch {
    return undefined;
  }
}

export function readSummary(database: Database.Database): RuntimeDataSetSummary {
  const conversations = database.prepare(
    'SELECT COUNT(*) AS count, MAX(updated_at) AS last FROM conversation'
  ).get() as { count: bigint | number; last: string | null };
  let projectNames: string[] = [];
  if (hasTable(database, 'project_context') && hasTable(database, 'conversation_project_link')) {
    projectNames = (database.prepare(`
      SELECT project.name AS name, COUNT(link.id) AS uses
        FROM project_context AS project
        LEFT JOIN conversation_project_link AS link ON link.project_context_id = project.id
       GROUP BY project.id
       ORDER BY uses DESC, project.name ASC
       LIMIT 3
    `).all() as Array<{ name: string }>).map((row) => row.name).filter((name) => typeof name === 'string' && name.length > 0);
  }
  return {
    projectNames,
    conversationCount: Number(conversations.count),
    ...(conversations.last ? { lastActivityAt: conversations.last } : {})
  };
}

function hasTable(database: Database.Database, table: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
