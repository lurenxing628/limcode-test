import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { HistoricalRootBinding } from './rootAuthority';
import type { RuntimeDataSetSummary } from './runtimeDataSetContent';
import { copyRuntimeDataSetDatabase, copyRuntimeSqliteFiles, requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import type { VscodeRuntimeDataSetCandidate } from './vscodeRootAuthority';
import type { RelocatedWorkInventory } from './relocatedWorkInventory';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';

/**
 * Read-only facts of one data set from a private copy of its SQLite files, computed in a
 * short-lived worker thread so the extension host's main thread never copies into or scans a
 * database. Same POSIX lock rule as runtimeSnapshotAudit: only the private copy is ever opened, and
 * only by the worker. Never call this for a database this process has open: copying its files
 * opens and closes them, which releases this process's SQLite locks on them.
 */
export interface RuntimeDataSetFactsRequest {
  /** The checks opening it (or the exact published 3/4/5/6/7 upgrade) would perform; a failure rejects. */
  openable?: boolean;
  contentDigest?: boolean;
  summary?: boolean;
  /** The readable history (RuntimeDataSetHistoryIds), read from the tables themselves, in no particular order. */
  historyIds?: boolean;
  /**
   * Every body with where it is (RuntimeDataSetContentBodies): only a data set that proves copies
   * needs it; a copy's bodies are checked in the proving data set by that data set's own rows.
   */
  contentBodies?: boolean;
  /** The unfinished work a relocation carries away (see relocatedWorkInventory), from the same snapshot. */
  relocatedWork?: boolean;
}

/**
 * The rest of the history a person can see besides Conversations and MessageRevisions (清理备份,
 * L5): rows no Repository deletes, removed only with their Conversation (or never), so a merge
 * carries every one of them over with its id. Control-plane, context and delivery rows, and every
 * domain with a delete mutation, are not history in this sense. A table an older epoch did not have
 * (the collaboration domains before epoch 5) is read as empty.
 */
export const RUNTIME_HISTORY_RECORD_DOMAINS: ReadonlyArray<{ key: string; table: string }> = Object.freeze([
  { key: 'Turn', table: 'turn' },
  { key: 'TurnTermination', table: 'turn_termination' },
  { key: 'ToolCall', table: 'tool_call' },
  { key: 'ToolOutcome', table: 'tool_outcome' },
  { key: 'ToolModelResult', table: 'tool_model_result' },
  { key: 'ToolResultArtifact', table: 'tool_result_artifact' },
  { key: 'FileChangeSet', table: 'file_change_set' },
  { key: 'FileChangeSetMember', table: 'file_change_set_member' },
  { key: 'FileChangeDecision', table: 'file_change_decision' },
  { key: 'InteractionRequest', table: 'interaction_request' },
  { key: 'InteractionResponse', table: 'interaction_response' },
  { key: 'Process', table: 'process' },
  { key: 'ProcessOutputChunk', table: 'process_output_chunk' },
  { key: 'Attachment', table: 'attachment' },
  { key: 'AttachmentLink', table: 'attachment_link' },
  { key: 'CompressionBlock', table: 'compression_block' },
  { key: 'ChildExecution', table: 'child_execution' },
  { key: 'CollaborationMessage', table: 'collaboration_message' }
].map((entry) => Object.freeze(entry)));

// Checked when this module loads: each is a domain with that table, and no Repository deletes its rows.
for (const entry of RUNTIME_HISTORY_RECORD_DOMAINS) {
  const schema = RUNTIME_DOMAIN_SCHEMAS.find((candidate) => candidate.key === entry.key);
  if (!schema || schema.table !== entry.table || (schema.mutations as readonly string[]).includes('delete')) {
    throw new Error(`History record domain ${entry.key} is not an undeletable domain of table ${entry.table}.`);
  }
}

/**
 * The readable history of one database, read from the tables themselves: every Conversation and
 * MessageRevision id, the ids of the other history rows (RUNTIME_HISTORY_RECORD_DOMAINS, by domain
 * key), what is visible (every message not deleted, with its current revision) and every body
 * (ContentObject id; where each one is stored comes separately, see RuntimeDataSetContentBodies).
 */
export interface RuntimeDataSetHistoryIds {
  conversations: string[];
  messageRevisions: string[];
  records: Record<string, string[]>;
  /** [message id, its current-revision link id, the current revision id]. */
  visibleMessages: Array<[string, string, string]>;
  /** Content object ids. */
  contents: string[];
}

/** [content object id, CAS storage key, byte length as decimal text] of every body of a database. */
export type RuntimeDataSetContentBodies = Array<[string, string, string]>;

export interface RuntimeDataSetFacts {
  binding: HistoricalRootBinding;
  contentDigest?: string;
  summary?: RuntimeDataSetSummary;
  historyIds?: RuntimeDataSetHistoryIds;
  contentBodies?: RuntimeDataSetContentBodies;
  relocatedWork?: RelocatedWorkInventory;
}

/** @internal Worker protocol; plain data only. */
export interface RuntimeDataSetFactsWorkerData extends RuntimeDataSetFactsRequest {
  databasePath: string;
  binding: HistoricalRootBinding;
}

/** @internal */
export type RuntimeDataSetFactsWorkerResponse =
  | { ok: true; facts: Omit<RuntimeDataSetFacts, 'binding'> }
  | { ok: false; error: { name: string; message: string; code?: string } };

export class RuntimeDataSetFactsError extends Error {
  public constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'RuntimeDataSetFactsError';
  }
}

export async function readRuntimeDataSetFacts(
  candidate: VscodeRuntimeDataSetCandidate,
  request: RuntimeDataSetFactsRequest
): Promise<RuntimeDataSetFacts> {
  const binding = await requireCompleteRuntimeDataSet(candidate);
  const copy = await copyRuntimeDataSetDatabase(candidate, binding);
  try {
    const facts = await runWorker({
      databasePath: copy.databasePath,
      binding: JSON.parse(JSON.stringify(binding)) as HistoricalRootBinding,
      ...(request.openable ? { openable: true } : {}),
      ...(request.contentDigest ? { contentDigest: true } : {}),
      ...(request.summary ? { summary: true } : {}),
      ...(request.historyIds ? { historyIds: true } : {}),
      ...(request.contentBodies ? { contentBodies: true } : {}),
      ...(request.relocatedWork ? { relocatedWork: true } : {})
    });
    return { binding, ...facts };
  } finally {
    await copy.remove();
  }
}

/**
 * The same read-only facts of one SQLite backup file (not a data set) of a configuration root, whose
 * root_binding row must equal `binding` (the binding saved beside it). The copy counts only when the
 * file state (runtimeDataSetFileState) is the same before and after it; `files` is that state.
 */
export async function readRuntimeBackupFacts(
  input: { configurationRootPath: string; databasePath: string; binding: HistoricalRootBinding },
  request: RuntimeDataSetFactsRequest
): Promise<{ files: string; facts: Omit<RuntimeDataSetFacts, 'binding'> }> {
  const files = await runtimeDataSetFileState(input.databasePath);
  const copy = await copyRuntimeSqliteFiles(input.configurationRootPath, input.databasePath);
  try {
    const facts = await runWorker({
      databasePath: copy.databasePath,
      binding: JSON.parse(JSON.stringify(input.binding)) as HistoricalRootBinding,
      ...(request.openable ? { openable: true } : {}),
      ...(request.contentDigest ? { contentDigest: true } : {}),
      ...(request.summary ? { summary: true } : {}),
      ...(request.historyIds ? { historyIds: true } : {})
    });
    if (await runtimeDataSetFileState(input.databasePath) !== files) {
      throw new RuntimeDataSetFactsError('备份文件在读取期间发生了变化。', 'runtime-backup-changed-while-reading');
    }
    return { files, facts };
  } finally {
    await copy.remove();
  }
}

/**
 * The same read-only facts of a private copy the caller made and removes (for instance a foreign
 * history root's, copied after its dev:ino checks), whose root_binding row must equal `binding`.
 * Only the copy is opened, and only by the worker.
 */
export async function readRuntimeCopyFacts(
  copyDatabasePath: string,
  binding: HistoricalRootBinding,
  request: Pick<RuntimeDataSetFactsRequest, 'contentDigest' | 'summary' | 'historyIds'>
): Promise<Omit<RuntimeDataSetFacts, 'binding'>> {
  return runWorker({
    databasePath: path.resolve(copyDatabasePath),
    binding: JSON.parse(JSON.stringify(binding)) as HistoricalRootBinding,
    ...(request.contentDigest ? { contentDigest: true } : {}),
    ...(request.summary ? { summary: true } : {}),
    ...(request.historyIds ? { historyIds: true } : {})
  });
}

/** Exact state of a database and its WAL file: any rewrite, copy or restore changes it. */
export async function runtimeDataSetFileState(databasePath: string): Promise<string> {
  const describe = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const database = describe(await fs.stat(databasePath, { bigint: true }));
  let wal = 'absent';
  try { wal = describe(await fs.stat(`${databasePath}-wal`, { bigint: true })); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return `db=${database};wal=${wal}`;
}

/** Bytes of the database and its WAL in a state of {@link runtimeDataSetFileState}; undefined for any other text. */
export function runtimeDataSetFileStateBytes(files: string): number | undefined {
  const match = /^db=\d+:\d+:(\d+):\d+:\d+;wal=(?:absent|\d+:\d+:(\d+):\d+:\d+)$/.exec(files);
  return match ? Number(match[1]) + Number(match[2] ?? 0) : undefined;
}

function runWorker(data: RuntimeDataSetFactsWorkerData): Promise<Omit<RuntimeDataSetFacts, 'binding'>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(path.join(__dirname, 'runtimeDataSetFactsWorker.js'), { workerData: data });
    worker.once('message', (message: RuntimeDataSetFactsWorkerResponse) => {
      settled = true;
      if (message.ok) resolve(message.facts);
      else reject(new RuntimeDataSetFactsError(message.error.message, message.error.code));
    });
    worker.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`历史库读取线程异常退出（退出码 ${code}）。`));
    });
  });
}
