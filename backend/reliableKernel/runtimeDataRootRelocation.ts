import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { isPathBelow, isPathInside, isSamePath } from '../capabilities/filesystem/pathContainment';
import {
  DATA_ROOT_BACKUPS_DIR, DATA_ROOT_RESET_PENDING_FILE, INDEX_FILE, RECORDS_DIR,
  REGISTERED_STORAGE_ROOT_DIRS, REGISTERED_STORAGE_ROOT_FILES
} from '../capabilities/vscodeStorage/constants';
import { createRuntimeRootPaths, ROOT_BINDING_POINTER_FILE, RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import { PROCESS_SPOOL_DIRECTORY } from './processProtocol';
import type { HistoricalRootBinding } from './rootAuthority';
import { classifyRecordedProcess, ownProcessStartIdentity } from './runtimeClaimPrimitives';
import { initializeEmptyRuntimeRoot, RuntimeDatabase } from './runtimeDatabase';
import {
  copyRuntimeDataSetIntoEmptyRoot, ensureRuntimeDataSetCopyCurrent, type RuntimeDataSetCopyOptions, type RuntimeDataSetCopyReceipt
} from './runtimeDataSetBulkCopy';
import {
  mergeRuntimeDataSetIntoDatabase, precopyRuntimeDataSetCas, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY,
  RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS, RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY, type RuntimeDataSetCasPrecopy,
  type RuntimeDataSetCasVerification, type RuntimeDataSetMergeOptions,
  type RuntimeDataSetMergeResult
} from './runtimeDataSetMerge';
import { readRuntimeDataSetFacts } from './runtimeDataSetFacts';
import { summarizeRuntimeDataSet } from './runtimeDataSetPreflight';
import { parseRelocatedWorkInventory, type RelocatedWorkInventory } from './relocatedWorkInventory';
import {
  readRuntimeDataSetMergeLedger, runtimeDataSetConversationsMergedFrom, runtimeDataSetLastMerge, runtimeDataSetMergeClosures,
  runtimeDataSetMergeLedgerRecordFile, sameRuntimeDataSetFingerprint, sameRuntimeDataSetIdentity, withRuntimeDataSetMergeClosures,
  type RuntimeDataSetFingerprint
} from './runtimeDataSetMergeLedger';
import {
  readRuntimeDeletedConversations, readRuntimeIdentityAliases, recordRuntimeDeletedConversations, RUNTIME_DELETED_CONVERSATIONS_DIRECTORY,
  RUNTIME_IDENTITY_ALIASES_DIRECTORY, runtimeMergeIdentityName, type RuntimeIdentityContinuation, type RuntimeMergeIdentity
} from './runtimeMergeTombstones';
import { RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY } from './runtimeEpochMigration';
import {
  assertRuntimeHostsOffline, isRuntimeHostsActiveError, listActiveRuntimeHosts, withRuntimeDataRootAdmission, withRuntimeMaintenance
} from './runtimeHostControl';
import type { RelocationDigestWorkerResponse } from './runtimeDataRootRelocationWorker';
import { auditRuntimeSnapshot } from './runtimeSnapshotAudit';
import { copyRuntimeDataSetDatabase, requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import {
  assertConfigurationRootRuntimesOffline, createVscodeRootAuthority, inspectVscodeRuntimeDataSets, listVscodeRuntimeArchiveDirectories,
  markVscodeRuntimeDataSetKept, resolveVscodeRuntimeDataRoot, resolveVscodeRuntimeDataSet, resolveVscodeRuntimeDataSetScopeRoot,
  resolveVscodeRuntimeMergeLedgerRoot, selectVscodeRuntimeDataSet, VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN, VSCODE_RUNTIME_CONTROL_DIRECTORY,
  VSCODE_RUNTIME_MERGE_LEDGER_DIRECTORY,
  VSCODE_RUNTIME_SELECTION_FILE, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, type VscodeRuntimeDataSetCandidate, type VscodeRuntimeDataSetInspection
} from './vscodeRootAuthority';

/**
 * Data-root relocation: moves this installation's LimCode data directory (configuration root) to
 * another directory. A RootBinding stores absolute paths and is checked field by field, so the
 * directory is never copied as a whole: the target gets its own fresh Runtime root, the selected
 * data set is merged into it by the historical-merge engine in migration mode (every row through
 * ordinary Repository inserts, CAS objects verified), the configuration entries are copied (or
 * merged into an existing LimCode directory), and only then is the data-root pointer switched.
 *
 * Phases (the caller orchestrates windows and the pointer):
 * 1. plan: read-only checks, sizes per disk, row counts;
 * 2. stage (online): the staging record and the receiving root in the target, then the CAS
 *    pre-copy while every window keeps working;
 * 3. complete (exclusive, every Host of both directories offline): configuration, merge, other data
 *    sets, selection, completion record, then the caller's pointer switch.
 *
 * Every change in the target is written to a durable journal before it is made. A failure (or a
 * crash, found later through the staging record of a dead owner) is undone from that journal: the
 * entries this relocation created are removed, replaced configuration files and an existing
 * receiving database are put back from the relocation's own backups. The old directory's data is
 * never modified by the move; deleting it later is a separate, explicitly confirmed step that only
 * removes what the completion record proves was carried over unchanged.
 */

/** Relocation state kept in the target directory (never in the old one). */
export const DATA_ROOT_RELOCATION_MARKER_FILE = '.limcode-data-root-relocation.json';
/** Identity of a LimCode data directory; the data-root pointer records it (see assertDataRootAvailable). */
export const DATA_ROOT_IDENTITY_FILE = '.limcode-data-root-identity.json';
/** Replaced configuration versions, the journal and database backups of each relocation. */
export const DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY = '.limcode-relocation-backups';
/**
 * Left in the old directory when its data moved: an installation that still uses that directory
 * (the pointer is kept per installation) learns where the data went, and the work that moved is not
 * resumed there (see DataRootMovedNotice.carriedWork). The old directory's only guard, so it is
 * written durably before the pointer switches (a relocation that cannot write it is undone) and
 * removed by that relocation's undo, which puts back the one that was there before (an earlier
 * relocation away from that directory); one that cannot be understood keeps the directory closed.
 */
export const DATA_ROOT_MOVED_NOTICE_FILE = '.limcode-data-root-moved.json';
/** A folder that already holds other files receives LimCode data only in its own sub-folder. */
export const DATA_ROOT_RELOCATION_SUBFOLDER = 'LimCode';
/** Global rules and skills live directly in the data directory (rulesCatalog, skillCatalog). */
export const DATA_ROOT_GLOBAL_ENTRIES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', 'skills'];

const MARKER_KIND = 'limcode-data-root-relocation';
/** A data set of the old directory that stays there because the target already has one with its id. */
const NAME_TAKEN_REASON = '新数据目录里已有同名历史库';
const MOVED_NOTICE_KIND = 'limcode-data-root-moved';
/** In a relocation's work directory: the moved notice its source had before it wrote its own (put back by its undo). */
const EARLIER_MOVED_NOTICE_FILE = 'moved-notice-before.json';
const IDENTITY_KIND = 'limcode-data-root-identity';
const JOURNAL_FILE = 'journal.jsonl';
const CONFIGURATION_BACKUP_DIRECTORY = 'configuration';
const DATABASE_BACKUP_PREFIX = 'database-';
/** Archives of "归档并重置" (VscodeReliableKernelCutoverCoordinator), one per scope root. */
const RESET_ARCHIVES_DIRECTORY = '.limcode-runtime-backups';
const RESET_ARCHIVE_NAME = new RegExp(`^${VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN}$`);
const CONTROL_ROOT_BACKUP_DIRECTORIES: readonly string[] = [
  RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY, RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY, RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY
];
const RUNTIME_ENTRY_NAMES: readonly string[] = [
  VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, VSCODE_RUNTIME_SELECTION_FILE
];
const CONFIGURATION_ENTRIES: readonly string[] = [...REGISTERED_STORAGE_ROOT_DIRS, ...REGISTERED_STORAGE_ROOT_FILES, ...DATA_ROOT_GLOBAL_ENTRIES];
/** LimCode's own bookkeeping at the top of a data directory; removed only with its last data set. */
const METADATA_ENTRIES: readonly string[] = [
  VSCODE_RUNTIME_SELECTION_FILE, VSCODE_RUNTIME_MERGE_LEDGER_DIRECTORY, DATA_ROOT_IDENTITY_FILE,
  DATA_ROOT_RELOCATION_MARKER_FILE, DATA_ROOT_RESET_PENDING_FILE, DATA_ROOT_MOVED_NOTICE_FILE
];
/** Files operating systems drop into any directory; they do not make a directory "used". */
const IGNORABLE_ENTRY_NAMES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
/** This extension's data-root pointer (in VS Code's own storage directory) and its lock: never user files. */
const GLOBAL_STATUS_FILE = '.limcode-global-status.json';
/** Every top-level name a LimCode data directory itself may hold (anything else is a file of the user). */
const LIMCODE_TOP_LEVEL_NAMES: ReadonlySet<string> = new Set([
  ...RUNTIME_ENTRY_NAMES, ...CONFIGURATION_ENTRIES, ...METADATA_ENTRIES,
  DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, DATA_ROOT_BACKUPS_DIR, RESET_ARCHIVES_DIRECTORY
]);
const CLOUD_SYNC_SEGMENT = /^(onedrive.*|dropbox|icloud ?drive|iclouddrive|mobile documents|cloudstorage|google ?drive|googledrive|my drive|box|box sync|pcloud ?drive|nutstore|坚果云|百度网盘|baidunetdisk|baidusyncdisk|seafile|nextcloud|owncloud|synologydrive|mega|yandex\.disk)$/i;
/** Free space kept beyond the estimate on every disk involved. */
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
/** Debug captures of a data set, below its Runtime data root (see debugCapture/files). */
const DEBUG_CAPTURES_PATH: readonly string[] = ['diagnostics', 'debug-captures'];
/** Allocation units a copy of the CAS objects is measured at (FAT/exFAT use up to 1 MiB clusters). */
const CLUSTER_SIZES: readonly number[] = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];
/** Linux statfs types of filesystems without hard links (msdos/vfat, exFAT): CAS objects are copied. */
const NO_HARD_LINK_FILESYSTEMS: ReadonlySet<number> = new Set([0x4d44, 0x2011bab0]);
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * Temporary copies named with their owner's process id (see sweepDataRootRelocationLeftovers).
 * `relocation-count` copies are only what earlier builds left: the row count copies nothing now.
 */
const OWNED_TEMPORARY_DIRECTORY = /^limcode-(?:runtime-history|merge-precopy|relocation-count)-(\d+)-/;
const OWNED_STAGING_FILE = /^(?:merge-precopy|relocation-count)-(\d+)-[0-9a-f-]{36}\.sqlite(?:-wal|-shm|-journal)?$/;
/** Names of earlier builds without an owner: removed only once clearly abandoned. */
const UNOWNED_TEMPORARY_DIRECTORY = /^limcode-(?:runtime-history|merge-precopy)-[A-Za-z0-9]{6}$/;
const UNOWNED_STAGING_FILE = new RegExp(`^merge-precopy-${UUID_PATTERN}\\.sqlite(?:-wal|-shm|-journal)?$`);
const UNOWNED_LEFTOVER_AGE_MS = 24 * 60 * 60_000;

export class DataRootRelocationError extends Error {
  public constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'DataRootRelocationError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * 'unreadable': a read failed with an error that usually passes (a network drive that hiccups), so
 * only retrying makes sense; 'inaccessible': any other read error (no permission, a path that became
 * a file), which retrying will not fix; 'relocating': a relocation into it has not finished and its
 * process is alive or cannot be judged (or its undo cannot run right now); 'relocation-undoing':
 * one failed and its live process is undoing it (or its undo stopped); 'unpublished': a
 * relocation of another installation copied its data in but never switched to it, and its process
 * is gone (the user decides: undo it, or do not open the directory now); 'moved-work': a relocation
 * carried unfinished work away and the user did not decide yet; 'moved-work-unsettled': that work
 * could not all be settled at this open (it stays consented; the next open settles it again);
 * 'moved-notice-invalid': its moved notice is there but cannot be understood (never taken for none).
 */
export type DataRootUnavailableReason = 'missing' | 'not-directory' | 'empty' | 'mismatch' | 'unreadable' | 'inaccessible' | 'relocating'
  | 'relocation-undoing' | 'unpublished' | 'moved-work' | 'moved-work-unsettled' | 'moved-notice-invalid';

/** Read errors that usually pass by themselves (see DataRootUnavailableReason 'unreadable'). */
const TRANSIENT_READ_ERRORS: ReadonlySet<string> = new Set([
  'EIO', 'ETIMEDOUT', 'EAGAIN', 'EBUSY', 'EINTR', 'ECONNRESET', 'ECONNABORTED', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH'
]);

/** A configured data directory that is missing, empty or another one (an unmounted drive, a lost share). */
export class DataRootUnavailableError extends Error {
  public readonly code = 'data-root-unavailable';

  public constructor(public readonly dataRootPath: string, public readonly reason: DataRootUnavailableReason, cause?: unknown) {
    // A relocation's own explanation (e.g. why an unfinished one could not be undone yet) is part of it.
    super(dataRootUnavailableMessage(dataRootPath, reason, cause instanceof DataRootRelocationError ? cause.message : undefined));
    this.name = 'DataRootUnavailableError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export type DataRootRelocationTarget =
  /** Missing or empty: a fresh root under the current data set's id. */
  | { kind: 'empty' }
  /** Other files of the user: only a sub-folder of it can receive the data. */
  | { kind: 'occupied'; entries: string[]; suggestedPath: string }
  /** LimCode data created at this very path: the selected data set there receives the merge. */
  | { kind: 'limcode'; receivingId: string; dataSetIds: string[] }
  /**
   * LimCode data copied here from elsewhere (its RootBindings name another path): renamed aside
   * as a whole (`<name>.limcode-copied-<time>`, never deleted or merged), then a fresh root.
   * `sameDataSet`: an older copy of the current data set itself.
   */
  | { kind: 'copied'; sameDataSet: boolean; message: string }
  /** Not usable as a data directory at all. */
  | { kind: 'invalid'; message: string };

export interface DataRootRelocationDataSet {
  id: string;
  dataSetId: string;
  rootInstanceId: string;
  /** SQLite database and WAL. */
  databaseBytes: number;
  casBytes: number;
  /** CAS bytes as allocated on disk (blocks), for a copy to another disk. */
  casAllocatedBytes: number;
  /** CAS bytes a copy would allocate with each of CLUSTER_SIZES as allocation unit. */
  casClusterBytes?: number[];
  /** Rows over every Runtime domain; undefined when the data set could not be read. */
  rows?: number;
}

export interface DataRootRelocationSpace {
  /** User-facing description of what is written there. */
  label: string;
  path: string;
  requiredBytes: number;
  freeBytes?: number;
}

export interface DataRootRelocationPlan {
  sourceRootPath: string;
  targetRootPath: string;
  target: DataRootRelocationTarget;
  /** `rows`: counted only when merging into an existing data set (its one-transaction bound). */
  current: DataRootRelocationDataSet & { rows?: number };
  /** Other data sets of the old directory; `leaveBehind` names why one stays there. */
  others: Array<DataRootRelocationDataSet & { leaveBehind?: string }>;
  /** Data sets of the old directory that cannot even be inspected; they stay there. */
  unreadable: Array<{ id: string; reason: string }>;
  configurationBytes: number;
  /** Configuration entries of the old directory that are copied (registered, rules, skills). */
  configurationEntries: string[];
  /** Estimated bytes per disk (a disk used for several purposes appears once). */
  space: DataRootRelocationSpace[];
  sameDevice: boolean;
  /** CAS objects are hard-linked (same disk and a filesystem with hard links), not copied. */
  hardLinks: boolean;
  /**
   * The target holds an unfinished relocation (a crashed one, or one from this same directory that
   * completed without switching the pointer and is unchanged since): it is undone first.
   */
  undoesEarlierAttempt: boolean;
  /** The relocation cannot start; each entry is a user-facing Chinese sentence. */
  problems: string[];
  /** Shown before confirmation; the relocation may still proceed. */
  warnings: string[];
  /**
   * Work an earlier relocation carried away from this directory that is not settled here yet (see
   * inspectEarlierMovedWork): moved on once more it would run in both new directories. The
   * relocation goes ahead only once it is settled (DataRootRelocationOptions.settleEarlierMovedWork).
   */
  earlierMovedWork?: DataRootEarlierMovedWork;
}

/** See DataRootRelocationPlan.earlierMovedWork. */
export interface DataRootEarlierMovedWork {
  /** The earlier relocation whose moved notice this directory keeps, and where it moved the data. */
  relocationId: string;
  targetRootPath: string;
  dataSets: DataRootEarlierMovedDataSet[];
}

export interface DataRootEarlierMovedDataSet {
  id: string;
  dataSetId: string;
  state: 'pending' | 'consented';
  /** It cannot be inspected now: it may hold that work, and it cannot be settled either. */
  unreadable?: true;
  /** For people: its project folder names, else which kind of library it is. */
  label: string;
  /** The Conversations with that work, as the earlier relocation's inventory named them. */
  conversations: Array<{ conversationId: string; title: string }>;
}

export interface StagedDataRootRelocation {
  plan: DataRootRelocationPlan;
  relocationId: string;
  startedAt: string;
  receiving: { id: string; runtimeDataRootPath: string; binding: HistoricalRootBinding };
  /** The current data set's CAS pre-copy, with the verified objects' file identities (skipped when unchanged). */
  precopied: RuntimeDataSetCasPrecopy;
  /** Other data sets already copied whole into fresh roots of the target while every window kept working. */
  precopiedOthers: Record<string, PrecopiedDataSet>;
  /** Where the relocation found the target before it first changed it (see DataRootRelocationTargetAnchor). */
  anchor: DataRootRelocationTargetAnchor;
}

/**
 * The directories the relocation found before it first changed the target, as `<device>:<inode>`:
 * the target's parent and, when the target existed and stays in place, the target itself. The
 * pointer's in-progress record carries it: a later attempt that finds no record in the target tells
 * "undone, or never written" (the same directories) from "not visible right now" (e.g. the drive of
 * a mount point is not connected, a drive letter changed).
 */
export interface DataRootRelocationTargetAnchor {
  parent: string;
  target?: string;
}

/** Another data set copied whole into a fresh root of the target during stage. */
export interface PrecopiedDataSet {
  receipt: RuntimeDataSetCopyReceipt;
  /** The topmost directory stage created for it (every directory of it is at or below). */
  createdPath: string;
}

export interface DataRootRelocationResult {
  targetRootPath: string;
  /** Where LimCode data copied into the target from elsewhere was kept (renamed aside). */
  copiedDataMovedTo?: string;
  merged: RuntimeDataSetMergeResult;
  configuration: { copiedFiles: number; replacedFiles: number; backupPath?: string };
  others: {
    migrated: string[];
    /** Already merged into the current data set and unchanged since: carried by it. */
    covered: string[];
    leftBehind: Array<{ id: string; reason: string }>;
  };
}

export interface DataRootRelocationOptions extends Pick<RuntimeDataSetMergeOptions, 'linkFile'> {
  onProgress?(message: string): void;
  /** Cancels the online pre-copy (stage); the exclusive phase does not observe it. */
  signal?: AbortSignal;
  /** The installation that moves the data, named in the old directory's moved notice (none: no notice). */
  movedBy?: DataRootMovedNotice['installation'];
  /**
   * The installation that starts the relocation (its own storage directory), recorded in the
   * target's record: only it confirms, finalizes or redoes that relocation there.
   */
  installation?: string;
  /**
   * After `publish` failed: whether the data-root pointer provably did not switch to this
   * relocation (the caller reads it again). Only then is the relocation undone right there, both
   * admissions still held; otherwise it stays as it is for the caller (see completeDataRootRelocation).
   */
  pointerUnchanged?(): Promise<boolean>;
  /**
   * Settles, before anything moves, the work an earlier relocation carried away from data set `id`
   * of the old directory and that is not settled there yet (DataRootRelocationPlan.earlierMovedWork;
   * the user chose so when confirming, which is the consent); throws when not all of it could be.
   * Without it such work refuses the relocation.
   */
  settleEarlierMovedWork?(dataSet: { id: string; dataSetId: string }): Promise<void>;
}

/** See DATA_ROOT_MOVED_NOTICE_FILE. */
export interface DataRootMovedNotice {
  targetRootPath: string;
  relocationId: string;
  movedAt: string;
  /** `id`: the installation's own storage directory (where its data-root pointer lives); `label` for people. */
  installation: { id: string; label: string };
  /**
   * Unfinished work the relocation carried to the new directory unchanged, per data set that moved.
   * In the old directory it must not simply resume (it would run twice): a data set's work is
   * settled (closed as aborted) when it is opened there, only after the user chose to keep using
   * the old directory ("回到旧目录", or "在这里继续" when opening it); `settlement` says how far that got.
   */
  carriedWork?: DataRootCarriedWork;
}

/** See DataRootMovedNotice.carriedWork. */
export interface DataRootCarriedWork {
  /** Each data set that moved with unfinished work; settled on its own when it is opened in the old directory. */
  dataSets: DataRootCarriedDataSet[];
}

export interface DataRootCarriedDataSet {
  /** Its id in the old directory ('default', 'workspace:…') and its identity when it moved. */
  id: string;
  dataSetId: string;
  /** What would run again there (see relocatedWorkInventory), computed on the snapshot that moved. */
  inventory: RelocatedWorkInventory;
  settlement: DataRootCarriedWorkSettlement;
}

export type DataRootCarriedWorkSettlement =
  | { state: 'pending' }
  /**
   * The user chose to keep using the old directory: settled at its next open before anything runs.
   * It stays consented until an open settles all of it: after a crash, and after an open that could
   * not settle everything (`left`: what that open left and why; the open failed and nothing ran).
   */
  | { state: 'consented'; at: string; by: string; left?: DataRootCarriedWorkLeft }
  /** Settled, all of it (by the installation `by`); never again. */
  | { state: 'settled'; at: string; by: string; result: DataRootCarriedWorkResult };

/** What the settlement closed, per kind (see relocatedWorkSettlement's counts). */
export interface DataRootCarriedWorkResult {
  counts: Record<string, number>;
}

/** What an open could not settle; while anything is left the old directory does not open. */
export interface DataRootCarriedWorkLeft {
  at: string;
  by: string;
  items: DataRootCarriedWorkLeftItem[];
}

export interface DataRootCarriedWorkLeftItem {
  conversationId: string;
  /** The Conversation's title when it was recorded. */
  title: string;
  /** What it is (RelocatedWorkItemList of relocatedWorkSettlement). */
  list: string;
  id: string;
  /** 'live': a live window runs or holds it; the others as relocatedWorkSettlement reports them. */
  why: 'live' | 'failed' | 'needs_human' | 'rounds_exhausted';
  detail: string;
}

/** What the pointer switch records: the identity of the new data directory. */
export interface DataRootRelocationPublication {
  dataRootId: string;
}

interface RelocationOwner {
  processId: number;
  processStartIdentity?: string;
}

type TargetState =
  | { kind: 'empty' }
  | { kind: 'copied'; sameDataSet: boolean }
  | { kind: 'limcode'; receivingId: string; dataSetIds: string[] };

interface MigratedDataSet {
  id: string;
  dataSetId: string;
  rootInstanceId: string;
  /** Content of the old directory's data set when it was carried over. */
  fingerprint: RuntimeDataSetFingerprint;
  /** Carried by this data set of the target (merged into the current one earlier). */
  mergedInto?: string;
  /**
   * Conversations the merge into the receiving data set left out because the user had deleted them
   * there (runtimeMergeTombstones): they exist only here, so this data set is never offered for deletion.
   */
  skippedConversations?: number;
}

interface CopiedConfiguration {
  entry: string;
  /** Tree digest of the old directory's entry when it was copied. */
  digest: string;
}

interface RelocationMarker {
  kind: typeof MARKER_KIND;
  /**
   * 'staging' → 'complete' (everything copied, pointer not switched yet) → 'published' (the
   * initiating installation switched its pointer; written by it right after) → 'finalized' (it
   * opened the new directory and removed the journal and the undo copies). Only a staging or
   * complete record is ever undone; a complete one only when the pointer provably did not switch.
   * 'undoing' is written before an undo touches anything: a complete record needs it, so every
   * later attempt continues its undo; a staging record (undone anyway) gets it too, best effort, so
   * that everyone can tell a failed relocation being undone from one still running. 'held': an undo
   * found the receiving data set changed since the relocation (someone else wrote there) and
   * stopped without touching anything; it is never undone automatically again (see `held`).
   */
  state: 'staging' | 'complete' | 'published' | 'finalized' | 'undoing' | 'held';
  relocationId: string;
  sourceRootPath: string;
  /** The directory this record describes; a record copied along with a directory describes another one and is ignored. */
  targetRootPath: string;
  startedAt: string;
  owner: RelocationOwner;
  /** The initiating installation (see DataRootRelocationOptions.installation). */
  installation?: string;
  /** Top-level entries of the target before the relocation touched it (never removed by an undo). */
  preexisting: string[];
  createdDirectory: boolean;
  /** The target as the plan found it; a later attempt after an undo classifies it the same way. */
  targetState: TargetState;
  receivingId: string;
  /** Completion record of an earlier relocation into this directory, put back by an undo. */
  previous?: RelocationMarker;
  /** Copied LimCode data that was in the target, renamed aside here (renamed back by an undo). */
  movedAside?: string;
  completedAt?: string;
  migrated?: MigratedDataSet[];
  configuration?: CopiedConfiguration[];
  leftBehind?: Array<{ id: string; reason: string }>;
  /** The receiving data set right after completion: an unswitched relocation is redone only while unchanged. */
  receivingFingerprint?: RuntimeDataSetFingerprint;
  /** The user went back to the old directory afterwards: this record no longer proves anything about it. */
  invalidatedAt?: string;
  /** Why the undo was held (state 'held'); the relocation's backups stay in its work directory. */
  held?: { at: string; reason: string };
  publishedAt?: string;
  finalizedAt?: string;
}

type JournalEntry =
  /** Created by this relocation (the topmost new path); an undo removes it. */
  | { op: 'entry'; path: string }
  /** An existing file or link; its previous version is at `backup` (relative to the work directory). */
  | { op: 'replace'; path: string; backup: string }
  /**
   * The existing receiving database; its offline copy is at `backup`, taken while its content was
   * `before`; `stamp`: the copy's files (see fileStamp), to tell a restore interrupted halfway from
   * one someone wrote into since.
   */
  | { op: 'database'; path: string; backup: string; before: RuntimeDataSetFingerprint; stamp: { database: string; wal?: string } }
  /**
   * The receiving data set right after the relocation wrote it (nothing to undo by itself): an undo
   * goes ahead only while the data set is still exactly this, or still `before`, so it never
   * overwrites or removes what anyone wrote there since.
   */
  | { op: 'received'; path: string; fingerprint: RuntimeDataSetFingerprint }
  /**
   * Written right before the merge into an existing receiving data set commits: the rows its one
   * transaction inserts. An undo that finds the data set neither `before` nor `received` (e.g. killed
   * between the commit and the 'received' entry) still goes ahead when removing exactly these rows
   * gives back `before`: nobody else wrote there.
   */
  | { op: 'merging'; path: string; inserted: Array<[domain: string, id: string]> }
  /** An existing directory: an undo removes every entry of it that is not in `keep`. */
  | { op: 'children'; path: string; keep: string[] };

const cleanupStates = new WeakMap<object, boolean>();

/**
 * Whether a failed stage or completion already undid its changes in the target (undefined: the
 * failure happened before anything in the target was ours to undo).
 */
export function dataRootRelocationCleanupState(error: unknown): 'cleaned' | 'not-cleaned' | undefined {
  if (!error || typeof error !== 'object' || !cleanupStates.has(error)) return undefined;
  return cleanupStates.get(error) ? 'cleaned' : 'not-cleaned';
}

function recordCleanup(error: unknown, cleaned: boolean): void {
  if (error && typeof error === 'object') cleanupStates.set(error, cleaned);
}

// ---------------------------------------------------------------------------------------------
// Availability and identity

/**
 * Startup guard. A configured data directory must exist and be the one the pointer recorded: with
 * `expectedRootId` its identity file must carry that id, otherwise it must at least hold LimCode's
 * own structure. An empty or missing directory is an unmounted drive or a lost share far more often
 * than a new directory, and opening it would silently create an empty history there. Nothing is
 * created or written.
 */
export async function assertDataRootAvailable(dataRootPath: string, expectedRootId?: string): Promise<void> {
  const root = path.resolve(dataRootPath);
  let info;
  try {
    info = await fs.stat(root);
  } catch (error) {
    throw new DataRootUnavailableError(root, isMissing(error) ? 'missing' : readFailureReason(error), error);
  }
  if (!info.isDirectory()) throw new DataRootUnavailableError(root, 'not-directory');
  let structure: boolean;
  let identity: string | undefined;
  try {
    structure = await hasLimCodeStructure(root);
    identity = await readDataRootIdentity(root);
  } catch (error) {
    throw new DataRootUnavailableError(root, readFailureReason(error), error);
  }
  if (expectedRootId !== undefined) {
    if (identity === expectedRootId) return;
    throw new DataRootUnavailableError(root, identity !== undefined || structure ? 'mismatch' : 'empty');
  }
  if (!structure) throw new DataRootUnavailableError(root, 'empty');
}

/**
 * The identity recorded in a data directory: undefined when it has none (or a file that is not one).
 * A read that fails for another reason (a network drive that hiccups) throws: it proves nothing
 * either way and must never be taken for a different directory.
 */
export async function readDataRootIdentity(root: string): Promise<string | undefined> {
  let text: string;
  try { text = await fs.readFile(path.join(path.resolve(root), DATA_ROOT_IDENTITY_FILE), 'utf8'); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return undefined; }
  const record = value as { kind?: unknown; rootId?: unknown } | null;
  return record?.kind === IDENTITY_KIND && typeof record.rootId === 'string' && /^[0-9a-f-]{36}$/.test(record.rootId)
    ? record.rootId : undefined;
}

/**
 * The identity of a LimCode data directory the pointer is about to name; written once, only into a
 * directory that already holds LimCode's structure.
 */
export async function ensureDataRootIdentity(root: string): Promise<string> {
  const resolved = path.resolve(root);
  const existing = await readDataRootIdentity(resolved);
  if (existing) return existing;
  if (!await hasLimCodeStructure(resolved)) {
    throw new DataRootRelocationError('data-root-not-limcode', `这个目录里没有 LimCode 数据：${resolved}`);
  }
  const rootId = randomUUID();
  await writeJsonDurably(path.join(resolved, DATA_ROOT_IDENTITY_FILE), { kind: IDENTITY_KIND, rootId, createdAt: new Date().toISOString() });
  return rootId;
}

/**
 * LimCode's own Runtime structure, never a bare name or settings alone: the Runtime selection file, a
 * RootBinding pointer of a Runtime root, or the identity file. Settings (record stores, llm.json) are written by any
 * configuration save, even onto an unmounted drive's mount point, so they prove nothing.
 */
async function hasLimCodeStructure(root: string): Promise<boolean> {
  const isFile = async (file: string): Promise<boolean> => (await lstatOrUndefined(file))?.isFile() === true;
  if (await isFile(path.join(root, VSCODE_RUNTIME_SELECTION_FILE)) || await isFile(path.join(root, DATA_ROOT_IDENTITY_FILE))) return true;
  // A RootBinding pointer is only written by initializing a Runtime root, never by a stray mkdir -p.
  if (await isFile(path.join(root, VSCODE_RUNTIME_CONTROL_DIRECTORY, ROOT_BINDING_POINTER_FILE))) return true;
  const scopes = path.join(root, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, 'scopes');
  // Only a missing scopes directory is empty; a read that fails otherwise throws (see readFailureReason).
  const keys = await fs.readdir(scopes).catch((error: unknown) => {
    if (isMissing(error)) return [] as string[];
    throw error;
  });
  for (const key of keys) {
    if (await isFile(path.join(scopes, key, VSCODE_RUNTIME_CONTROL_DIRECTORY, ROOT_BINDING_POINTER_FILE))) return true;
  }
  return false;
}

/** The directory is one LimCode can open (used before offering to go back or switch to it). */
export async function inspectDataRootForReturn(dataRootPath: string): Promise<{ usable: boolean; message?: string }> {
  try {
    await assertDataRootAvailable(dataRootPath);
    const unfinished = await unfinishedRelocationOwner(dataRootPath);
    if (unfinished === 'running' || unfinished === 'undoing' || unfinished === 'unpublished') {
      const reason = unfinished === 'running' ? 'relocating' : unfinished === 'undoing' ? 'relocation-undoing' : 'unpublished';
      return { usable: false, message: dataRootUnavailableMessage(path.resolve(dataRootPath), reason) };
    }
    const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: dataRootPath });
    if (inspection.problems.some((problem) => problem.message.includes('RootBinding 不一致'))) {
      return { usable: false, message: '这个目录里的 LimCode 数据是从别的位置拷贝过来的，不能直接打开。' };
    }
    const selected = inspection.candidates.find((candidate) => candidate.selected);
    if (!selected?.dataSetId) return { usable: false, message: '这个目录里没有可以打开的当前历史库。' };
    return { usable: true };
  } catch (error) {
    return { usable: false, message: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// Plan

/**
 * Read-only relocation plan. `sourceDatabase` is this window's open Runtime of the current data set
 * (its rows are counted on its worker's reader connection in one read transaction, nothing copied);
 * without it the data set must be closed in this process. Checked again (without measuring) when staging.
 */
export async function planDataRootRelocation(input: {
  sourceRootPath: string;
  targetRootPath: string;
  sourceDatabase?: RuntimeDatabase;
  /** The installation that plans it (see DataRootRelocationOptions.installation). */
  installation?: string;
}): Promise<DataRootRelocationPlan> {
  const sourceRootPath = path.resolve(input.sourceRootPath);
  const targetRootPath = path.resolve(input.targetRootPath);
  const problems: string[] = [];
  const warnings: string[] = [];
  const placement = await placementProblems(input.targetRootPath, sourceRootPath, targetRootPath);
  problems.push(...placement);
  const cloud = targetRootPath.split(/[\\/]+/).find((segment) => CLOUD_SYNC_SEGMENT.test(segment));
  if (cloud) {
    warnings.push(`新数据目录看起来在云同步目录里（${cloud}）。同步软件在 LimCode 写入时复制数据库文件可能导致数据损坏，建议选择不同步的本地目录。`);
  }

  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: sourceRootPath });
  const currentCandidate = requireCurrentCandidate(inspection.candidates);
  const currentBinding = await requireCompleteRuntimeDataSet(currentCandidate);
  const currentSize = await measureDataSet(currentBinding);
  const current: DataRootRelocationPlan['current'] = { ...identityOf(currentCandidate), ...currentSize };
  const others: DataRootRelocationPlan['others'] = [];
  for (const candidate of inspection.candidates) {
    if (candidate.selected || !candidate.dataSetId || !candidate.rootInstanceId) continue;
    let binding: HistoricalRootBinding;
    try { binding = await requireCompleteRuntimeDataSet(candidate); }
    catch (error) {
      others.push({ ...identityOf(candidate), databaseBytes: 0, casBytes: 0, casAllocatedBytes: 0, leaveBehind: `无法读取：${errorMessage(error)}` });
      continue;
    }
    const size = await measureDataSet(binding);
    // Nothing is copied or opened for the others: an older format stays (it is upgraded where it is),
    // and one a window has open (another installation, an old version) stays too.
    const leaveBehind = candidate.requiresRecovery || candidate.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH
      ? '这个历史库需要先在旧目录里打开一次（完成升级或恢复）'
      : (await listActiveRuntimeHosts(createRuntimeRootPaths(candidate.runtimeDataRootPath)).catch(() => [])).length > 0 ? DATA_SET_IN_USE_REASON : undefined;
    others.push({ ...identityOf(candidate), ...size, ...(leaveBehind ? { leaveBehind } : {}) });
  }
  const unreadable = inspection.problems.map((problem) => ({ id: problem.id, reason: `无法读取：${problem.message}` }));
  // Moved on once more, work an earlier relocation carried away and not settled here would run twice.
  let earlierMovedWork: DataRootEarlierMovedWork | undefined;
  try {
    earlierMovedWork = await inspectEarlierMovedWork(sourceRootPath, inspection);
  } catch (error) {
    problems.push(`无法确认上一次迁移迁走的任务在这里都已收尾（${errorMessage(error)}），为免它们再被迁走、执行两次，这次不迁移。`);
  }
  if (earlierMovedWork?.dataSets.some((item) => item.unreadable)) problems.push(...describeEarlierMovedWork(earlierMovedWork));
  for (const problem of inspection.problems) {
    warnings.push(`旧目录里有一个无法读取的历史库不会被迁移，仍留在旧目录：${problem.message}`);
  }
  // Listed by directory, not by data set: a scope whose data set was deleted keeps its archives too.
  const archives = await countResetArchives(sourceRootPath);
  if (archives > 0) {
    warnings.push(`旧目录里有 ${archives} 份“归档并重置”留下的归档（含当时的对话）。归档不会迁移，留在旧目录；迁移之后它们列在“历史与存储管理 → 外来历史库”里，核验通过的可以只读查看；删除旧目录时默认保留。`);
  }
  const configurationEntries: string[] = [];
  let configurationBytes = 0;
  let configurationAllocated = 0;
  for (const name of CONFIGURATION_ENTRIES) {
    // The same test as the copy (transferConfiguration): a file, a directory or a link (copied as a link).
    if (!isConfigurationEntry(await lstatOrUndefined(path.join(sourceRootPath, name)))) continue;
    const measured = await measureTree(path.join(sourceRootPath, name));
    configurationEntries.push(name);
    configurationBytes += measured.bytes;
    configurationAllocated += measured.allocated;
  }

  // A target that is the old directory itself (or inside or above it) is not inspected at all.
  const classified = placement.length > 0
    ? { target: { kind: 'invalid' as const, message: placement[0] }, undoes: false }
    : await classifyTarget(targetRootPath, sourceRootPath, currentCandidate.dataSetId, input.installation);
  const target: DataRootRelocationTarget = classified.target;
  if (target.kind === 'invalid' && placement.length === 0) problems.push(target.message);
  if (target.kind === 'copied') {
    warnings.push(target.message);
    const offline = await targetOfflineProblem(targetRootPath);
    if (offline) problems.push(offline);
  }
  if (target.kind === 'occupied') {
    problems.push(`所选文件夹里已有其它文件（${target.entries.length} 项），LimCode 只能放在其中新建的子文件夹里：${target.suggestedPath}`);
  }
  if (target.kind === 'limcode') {
    warnings.push('新数据目录里已有 LimCode 数据：当前历史会合并进去（同一条记录内容不同时整体取消，两边都不改）；设置按记录合并，同一项以当前在用的为准，被替换的旧版本放进新目录的备份文件夹。');
    const taken = new Set(target.dataSetIds);
    for (const other of others) {
      if (!other.leaveBehind && taken.has(other.id)) other.leaveBehind = NAME_TAKEN_REASON;
    }
    const offline = await targetOfflineProblem(targetRootPath);
    if (offline) problems.push(offline);
  }
  if (classified.undoes) warnings.push('新数据目录里有上次没有完成的迁移，开始前会先把它撤销。');
  if (target.kind === 'empty' || target.kind === 'limcode' || target.kind === 'copied') {
    // Carried along in the exclusive phase (planMergeRecordsCarry): what cannot be read refuses now.
    try {
      const receiving = target.kind === 'limcode' ? await resolveVscodeRuntimeDataSet({ globalStoragePath: targetRootPath }, target.receivingId) : undefined;
      await planMergeRecordsCarry(sourceRootPath, targetRootPath, [
        { from: mergeIdentity(current), ...(receiving ? { to: mergeIdentity(receiving) } : {}) },
        ...others.filter((other) => !other.leaveBehind).map((other) => ({ from: mergeIdentity(other) }))
      ], { relocationId: 'plan', at: new Date().toISOString(), movedAside: target.kind === 'copied' });
    } catch (error) {
      problems.push(errorMessage(error));
    }
  }
  for (const other of others) {
    if (other.leaveBehind) warnings.push(`旧目录里的历史库 ${other.id} 不会迁移，仍留在旧目录：${other.leaveBehind}。`);
  }
  const globals = configurationEntries.filter((name) => DATA_ROOT_GLOBAL_ENTRIES.includes(name));
  if (globals.length > 0) warnings.push(`全局规则和技能（${globals.join('、')}）会一起复制到新目录。`);

  const writable = await writableProblem(targetRootPath);
  if (writable) problems.push(writable);
  const spaceEstimate = await estimateSpace({
    sourceRootPath, targetRootPath, currentBinding, current, others, configurationAllocated, target
  });
  let spaceShort = false;
  for (const space of spaceEstimate.space) {
    if (space.freeBytes !== undefined && space.freeBytes < space.requiredBytes) {
      spaceShort = true;
      problems.push(`${space.label}所在磁盘剩余 ${formatBytes(space.freeBytes)}，迁移过程中大约需要 ${formatBytes(space.requiredBytes)}（${space.path}）。`);
    }
  }
  if (target.kind === 'limcode' && !spaceShort) {
    // Into an existing data set the move is one merge transaction whose memory grows with the rows
    // (a fresh root is written in batches instead); refused here, before any window is involved.
    // Counted only here, after the space check, and without copying the database.
    try {
      current.rows = await countRows(currentCandidate, currentBinding, input.sourceDatabase);
    } catch (error) {
      problems.push(isDiskFull(error)
        ? `统计当前历史库的记录数时磁盘空间不足（${errorMessage(error)}），请先腾出空间再迁移。`
        : `无法统计当前历史库的记录数：${errorMessage(error)}`);
    }
    if (current.rows !== undefined && current.rows > RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS) {
      problems.push(`新数据目录里已有 LimCode 数据，当前历史库要一次合并进去；它的数据较多（约 ${current.rows} 行记录，合并一次最多 ${RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS} 行），当前版本暂不能迁移到这个目录；旧目录不受影响，可以继续使用。可以改选一个空文件夹。`);
    }
  }
  return {
    sourceRootPath, targetRootPath, target, current, others, unreadable, configurationBytes, configurationEntries,
    space: spaceEstimate.space, sameDevice: spaceEstimate.sameDevice, hardLinks: spaceEstimate.hardLinks, undoesEarlierAttempt: classified.undoes, problems, warnings,
    ...(earlierMovedWork ? { earlierMovedWork } : {})
  };
}

/**
 * The work an earlier relocation carried away from this directory (its moved notice) that is not
 * settled here yet, per data set still here as it was: one reset or replaced since holds none of it,
 * one deleted since is gone with it, and one that cannot be inspected now counts (`unreadable`). A
 * relocation from here would carry that work once more (it would run in both new directories) and
 * its new notice would replace the one that keeps it from running here. A notice that cannot be
 * read or understood throws: nothing about that work is known then.
 */
export async function inspectEarlierMovedWork(root: string, known?: VscodeRuntimeDataSetInspection): Promise<DataRootEarlierMovedWork | undefined> {
  const read = await inspectDataRootMovedNotice(root);
  if ('invalid' in read) throw new DataRootRelocationError('data-root-moved-notice-invalid', `当前数据目录里的“数据已迁走”标记读不懂：${read.invalid}`);
  if (!('notice' in read) || !read.notice.carriedWork) return undefined;
  const inspection = known ?? await inspectVscodeRuntimeDataSets({ globalStoragePath: root });
  const dataSets: DataRootEarlierMovedDataSet[] = [];
  for (const item of read.notice.carriedWork.dataSets) {
    if (item.settlement.state === 'settled') continue;
    const candidate = inspection.candidates.find((entry) => entry.id === item.id);
    const unreadable = !candidate && inspection.problems.some((problem) => problem.id === item.id
      || (problem.id === 'workspace-scopes' && item.id.startsWith('workspace:')) || (problem.id === 'default' && item.id === 'default'));
    if (!unreadable && candidate?.dataSetId !== item.dataSetId) continue;
    const summary = candidate ? await summarizeRuntimeDataSet(candidate).catch(() => undefined) : undefined;
    dataSets.push({
      id: item.id, dataSetId: item.dataSetId, state: item.settlement.state,
      ...(unreadable ? { unreadable: true as const } : {}),
      label: summary?.projectNames.length ? summary.projectNames.join('、') : item.id === 'default' ? '默认历史库' : '旧工作区历史',
      conversations: item.inventory.conversations.map((conversation) => ({ conversationId: conversation.conversationId, title: conversation.title }))
    });
  }
  return dataSets.length > 0 ? { relocationId: read.notice.relocationId, targetRootPath: read.notice.targetRootPath, dataSets } : undefined;
}

/** For people: which libraries still hold such work, why that stops a relocation, and what to do. */
export function describeEarlierMovedWork(work: DataRootEarlierMovedWork): string[] {
  const conversations = (item: DataRootEarlierMovedDataSet): string => {
    const titles = item.conversations.slice(0, 3).map((conversation) => `“${conversation.title || conversation.conversationId}”`).join('、');
    return `${item.conversations.length} 个对话（${titles}${item.conversations.length > 3 ? ' 等' : ''}）`;
  };
  return [
    `这些历史库里还有上一次迁移到 ${work.targetRootPath} 时迁走、但这里还没收尾的任务；再迁移一次它们会跟着迁走，在两个新目录里各执行一次：`,
    ...work.dataSets.map((item) => `历史库“${item.label}”${item.unreadable ? '（现在读不出来，无法收尾）' : ''}：${conversations(item)}`),
    work.dataSets.some((item) => item.unreadable)
      ? '读不出来的历史库要等它能读了才能收尾；在这之前不能迁移。'
      : '可以在迁移确认框里选“先把这些任务按中止收尾，再迁移”；也可以先在这里打开它们（“历史与存储管理”里切换为当前历史库，打开时会先收尾），再迁移。'
  ];
}

/** Such work the confirmation did not name: another relocation's notice, or a data set it did not list. */
function unconfirmedEarlierMovedWork(earlier: DataRootEarlierMovedWork | undefined, confirmed: DataRootEarlierMovedWork | undefined): boolean {
  if (!earlier) return false;
  const named = new Set((confirmed?.dataSets ?? []).map((item) => `${item.id}\0${item.dataSetId}`));
  return earlier.relocationId !== confirmed?.relocationId || earlier.dataSets.some((item) => !named.has(`${item.id}\0${item.dataSetId}`));
}

async function placementProblems(rawTarget: string, sourceRootPath: string, targetRootPath: string): Promise<string[]> {
  const problems: string[] = [];
  if (!path.isAbsolute(rawTarget.trim())) problems.push('新数据目录必须是绝对路径。');
  const sourceReal = await realPathOfNearestExisting(sourceRootPath);
  const targetReal = await realPathOfNearestExisting(targetRootPath);
  if (isSamePath(sourceRootPath, targetRootPath) || isSamePath(sourceReal, targetReal)) {
    problems.push('新数据目录就是当前数据目录。');
  } else if (isPathInside(sourceRootPath, targetRootPath) || isPathInside(sourceReal, targetReal)) {
    problems.push('新数据目录不能放在当前数据目录里面。');
  } else if (isPathInside(targetRootPath, sourceRootPath) || isPathInside(targetReal, sourceReal)) {
    problems.push('新数据目录不能是当前数据目录的上级目录。');
  }
  return problems;
}

function requireCurrentCandidate(candidates: readonly VscodeRuntimeDataSetCandidate[]): VscodeRuntimeDataSetCandidate {
  const selected = candidates.filter((candidate) => candidate.selected);
  if (selected.length !== 1 || !selected[0].dataSetId || !selected[0].rootInstanceId) {
    throw new DataRootRelocationError('data-root-relocation-no-current', '当前数据目录没有选定的历史库，无法迁移。');
  }
  return selected[0];
}

function identityOf(candidate: VscodeRuntimeDataSetCandidate): { id: string; dataSetId: string; rootInstanceId: string } {
  return { id: candidate.id, dataSetId: candidate.dataSetId!, rootInstanceId: candidate.rootInstanceId! };
}

/** One walk of the data set's Runtime directory: database, CAS (logical and allocated). */
async function measureDataSet(binding: HistoricalRootBinding): Promise<Pick<DataRootRelocationDataSet, 'databaseBytes' | 'casBytes' | 'casAllocatedBytes' | 'casClusterBytes'>> {
  const database = path.resolve(binding.paths.databasePath);
  const databaseFiles = new Set([database, `${database}-wal`]);
  const cas = path.resolve(binding.paths.casRootPath);
  const result = { databaseBytes: 0, casBytes: 0, casAllocatedBytes: 0, casClusterBytes: CLUSTER_SIZES.map(() => 0) };
  await walkSizes(path.resolve(binding.paths.dataRootPath), (file, info) => {
    if (databaseFiles.has(file)) result.databaseBytes += info.size;
    else if (isPathInside(cas, file)) {
      result.casBytes += info.size;
      result.casAllocatedBytes += allocatedBytes(info);
      CLUSTER_SIZES.forEach((cluster, index) => { result.casClusterBytes[index] += Math.ceil(info.size / cluster) * cluster; });
    }
  });
  return result;
}

/**
 * Rows over every Runtime domain: the open database of this window counts them on its own reader
 * connection (nothing is copied); a database no window of this process has open is counted in a
 * worker on a private copy in the system temporary directory.
 */
async function countRows(candidate: VscodeRuntimeDataSetCandidate, binding: HistoricalRootBinding, sourceDatabase?: RuntimeDatabase): Promise<number> {
  if (sourceDatabase) return sourceDatabase.countDomainRows();
  const request = { binding: binding as unknown as RootBinding, measure: true, integrity: false } as const;
  const copy = await copyRuntimeDataSetDatabase(candidate, binding);
  try {
    return (await auditRuntimeSnapshot(copy.databasePath, request)).size!.rows;
  } finally {
    await copy.remove();
  }
}

/**
 * Space per disk (a disk used for several purposes is checked once for their sum):
 * - target: the new database twice (the database itself, and the Backup API copy the batched copy's
 *   final verification reads, one data set at a time; its WAL stays about one batch), CAS as allocated when copied
 *   across disks (hard links on the same disk), configuration; an existing receiving database is
 *   backed up twice (the relocation's own undo copy and the merge backup);
 * - temporary directory: one private database copy at a time (audits, fingerprints);
 * - old directory: the Backup API staging copy of the current database during the CAS pre-copy.
 */
async function estimateSpace(input: {
  sourceRootPath: string;
  targetRootPath: string;
  currentBinding: HistoricalRootBinding;
  current: DataRootRelocationDataSet;
  others: DataRootRelocationPlan['others'];
  configurationAllocated: number;
  target: DataRootRelocationTarget;
}): Promise<{ space: DataRootRelocationSpace[]; sameDevice: boolean; hardLinks: boolean }> {
  const targetProbe = await nearestExisting(input.targetRootPath);
  const sourceProbe = path.dirname(path.resolve(input.currentBinding.paths.dataRootPath));
  const temporaryProbe = os.tmpdir();
  const deviceOf = async (probe: string | undefined): Promise<number | undefined> => {
    if (!probe) return undefined;
    try { return (await fs.stat(probe)).dev; } catch { return undefined; }
  };
  const targetDevice = await deviceOf(targetProbe);
  const sourceDevice = await deviceOf(sourceProbe);
  const temporaryDevice = await deviceOf(temporaryProbe);
  const sameDevice = targetDevice !== undefined && targetDevice === sourceDevice;
  const targetFilesystem = targetProbe ? await fs.statfs(targetProbe).catch(() => undefined) : undefined;
  // FAT/exFAT (USB sticks) have no hard links: the merge falls back to copying every object.
  const hardLinks = sameDevice && !(process.platform === 'linux' && targetFilesystem && NO_HARD_LINK_FILESYSTEMS.has(Number(targetFilesystem.type)));
  // A copy allocates whole clusters of the target's filesystem (up to 1 MiB on exFAT).
  const clusterIndex = targetFilesystem ? CLUSTER_SIZES.findIndex((cluster) => cluster >= Number(targetFilesystem.bsize)) : -1;
  const copiedCas = (dataSet: DataRootRelocationDataSet): number => !targetFilesystem ? dataSet.casAllocatedBytes
    : Math.max(dataSet.casAllocatedBytes, dataSet.casClusterBytes?.[clusterIndex === -1 ? CLUSTER_SIZES.length - 1 : clusterIndex] ?? 0);
  const moving = [input.current, ...input.others.filter((other) => !other.leaveBehind)];
  let targetBytes = input.configurationAllocated;
  for (const dataSet of moving) targetBytes += 2 * dataSet.databaseBytes + (hardLinks ? 0 : copiedCas(dataSet));
  if (input.target.kind === 'limcode') {
    const receiving = await resolveVscodeRuntimeDataSet({ globalStoragePath: input.targetRootPath }, input.target.receivingId).catch(() => undefined);
    if (receiving) targetBytes += 2 * await databaseBytesOf(receiving.runtimeDataRootPath);
  }
  const largestDatabase = Math.max(0, ...moving.map((dataSet) => dataSet.databaseBytes));
  const needs: Array<{ device: number | undefined; label: string; path: string; bytes: number }> = [
    { device: targetDevice, label: '新数据目录', path: targetProbe ?? input.targetRootPath, bytes: targetBytes },
    { device: temporaryDevice, label: '临时目录', path: temporaryProbe, bytes: largestDatabase },
    { device: sourceDevice, label: '旧数据目录', path: sourceProbe, bytes: input.current.databaseBytes }
  ];
  const grouped = new Map<string, DataRootRelocationSpace>();
  for (const need of needs) {
    const key = need.device === undefined ? `path:${need.path}` : `device:${need.device}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.requiredBytes += need.bytes;
      existing.label = `${existing.label}、${need.label}`;
      continue;
    }
    let freeBytes: number | undefined;
    try {
      const stats = await fs.statfs(need.path);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch { /* free space unknown on this filesystem: the copy itself fails cleanly */ }
    grouped.set(key, {
      label: need.label, path: need.path, requiredBytes: need.bytes + FREE_SPACE_MARGIN_BYTES,
      ...(freeBytes !== undefined ? { freeBytes } : {})
    });
  }
  return { space: [...grouped.values()], sameDevice, hardLinks };
}

async function databaseBytesOf(runtimeDataRootPath: string): Promise<number> {
  let bytes = 0;
  for (const suffix of ['', '-wal']) {
    bytes += (await lstatOrUndefined(path.join(runtimeDataRootPath, `limcode.sqlite${suffix}`)))?.size ?? 0;
  }
  return bytes;
}

async function classifyTarget(
  targetRootPath: string,
  sourceRootPath: string,
  currentDataSetId: string | undefined,
  installation?: string
): Promise<{ target: DataRootRelocationTarget; undoes: boolean }> {
  let info;
  try {
    info = await fs.lstat(targetRootPath);
  } catch (error) {
    if (isMissing(error)) return { target: { kind: 'empty' }, undoes: false };
    return { target: { kind: 'invalid', message: `无法读取新数据目录：${errorMessage(error)}` }, undoes: false };
  }
  if (info.isSymbolicLink()) return { target: { kind: 'invalid', message: '新数据目录不能是符号链接，请直接选择它指向的目录。' }, undoes: false };
  if (!info.isDirectory()) return { target: { kind: 'invalid', message: '新数据目录的位置上已经有一个文件。' }, undoes: false };
  let marker: RelocationMarker | undefined;
  try { marker = await readMarker(targetRootPath); }
  catch (error) { return { target: { kind: 'invalid', message: `无法读取新数据目录里的迁移记录：${errorMessage(error)}` }, undoes: false }; }
  const leftover = marker ? await unfinishedRelocation(targetRootPath, marker, sourceRootPath, installation) : 'none';
  if (leftover === 'foreign') {
    return {
      target: { kind: 'invalid', message: '新数据目录里有另一个 LimCode 安装没有生效的迁移（数据已复制进来，但那个安装没有切换过去，它的进程也已结束）。请先在那个安装里打开一次 LimCode 让它撤销，或在这里打开这个目录时选择撤销。' },
      undoes: false
    };
  }
  if (leftover === 'running') {
    return { target: { kind: 'invalid', message: '另一个 LimCode 窗口正在向这个目录迁移数据（或无法确认上次迁移的进程已经结束），请稍后再试。' }, undoes: false };
  }
  if (leftover === 'undoing') {
    return { target: { kind: 'invalid', message: '另一个 LimCode 窗口向这个目录的迁移没有成功，正在撤销它在这里的改动（或撤销停下了、还没做完），撤销完成后才能迁移到这里，请稍后再试。' }, undoes: false };
  }
  if (leftover === 'undo' && marker) {
    // Classified as it was before that attempt; staging undoes the attempt first.
    const state = marker.targetState;
    return {
      target: state.kind === 'limcode' ? { ...state }
        : state.kind === 'copied' ? { kind: 'copied', sameDataSet: state.sameDataSet, message: copiedMessage(targetRootPath, state.sameDataSet) }
          : { kind: 'empty' },
      undoes: true
    };
  }
  const names = (await fs.readdir(targetRootPath))
    .filter((name) => !IGNORABLE_ENTRY_NAMES.has(name) && !isClaimName(name) && !isGlobalStatusName(name));
  if (names.length === 0) return { target: { kind: 'empty' }, undoes: false };
  if (!names.some((name) => RUNTIME_ENTRY_NAMES.includes(name))) {
    return { target: { kind: 'occupied', entries: names.sort(), suggestedPath: await suggestSubfolder(targetRootPath) }, undoes: false };
  }
  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: targetRootPath });
  if (inspection.problems.some((problem) => problem.message.includes('RootBinding 不一致'))) {
    // Copied data among other files of the user: renaming the folder would move those too.
    const foreign = [];
    for (const name of names) if (!LIMCODE_TOP_LEVEL_NAMES.has(name) && !await isTransientEntry(targetRootPath, name)) foreign.push(name);
    if (foreign.length > 0) {
      return { target: { kind: 'occupied', entries: names.sort(), suggestedPath: await suggestSubfolder(targetRootPath) }, undoes: false };
    }
    const sameDataSet = currentDataSetId !== undefined && (await copiedDataSetIds(targetRootPath)).includes(currentDataSetId);
    return { target: { kind: 'copied', sameDataSet, message: copiedMessage(targetRootPath, sameDataSet) }, undoes: false };
  }
  if (inspection.problems.length > 0) {
    return { target: { kind: 'invalid', message: `新数据目录里的 LimCode 历史库无法读取：${inspection.problems[0].message}` }, undoes: false };
  }
  const selected = inspection.candidates.filter((candidate) => candidate.selected);
  if (selected.length !== 1 || !selected[0].dataSetId) {
    return { target: { kind: 'invalid', message: '新数据目录里有 LimCode 历史库，但没有选定当前库；请先在那里打开一次 LimCode，或换一个空目录。' }, undoes: false };
  }
  // Only a current-epoch root receives rows through the current Repository codecs.
  if (selected[0].requiresRecovery || selected[0].runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
    return { target: { kind: 'invalid', message: '新数据目录里的当前历史库需要先在那里打开一次完成升级或恢复，才能接收迁移。' }, undoes: false };
  }
  return {
    target: { kind: 'limcode', receivingId: selected[0].id, dataSetIds: inspection.candidates.filter((item) => item.dataSetId).map((item) => item.id) },
    undoes: false
  };
}

/**
 * An earlier relocation in the target that must be undone before this one: a staging (or undoing)
 * record whose owner is gone, or a completion of this installation from this same directory whose
 * pointer switch never happened (not confirmed 'published', its journal still there) and whose
 * receiving data set is unchanged since. 'running': its owner lives (or cannot be judged) and it is
 * not confirmed yet. 'foreign': another installation's completion that was never confirmed, owner
 * gone: that installation (or the user, when opening the directory) decides about it.
 */
async function unfinishedRelocation(
  target: string,
  marker: RelocationMarker,
  sourceRootPath: string,
  installation?: string
): Promise<'none' | 'running' | 'undoing' | 'undo' | 'foreign'> {
  // Someone else wrote into the target since: never undone automatically (see undoRelocation).
  if (marker.state === 'held' || marker.state === 'published' || marker.state === 'finalized') return 'none';
  // An undo that was interrupted is always finished, whoever interrupted it (still behind the receiving check).
  if (marker.state === 'staging' || marker.state === 'undoing') {
    if (ownerState(marker.owner) === 'dead') return 'undo';
    return marker.state === 'undoing' ? 'undoing' : 'running';
  }
  // Complete, not confirmed: its owner may still switch the pointer.
  if (ownerState(marker.owner) !== 'dead') return 'running';
  if (marker.invalidatedAt) return 'none';
  if (marker.installation !== installation) return 'foreign';
  if (!isSamePath(path.resolve(marker.sourceRootPath), sourceRootPath)) return 'none';
  if (!await pathExists(journalPath(target, marker.relocationId)) || !marker.receivingFingerprint) return 'none';
  try {
    const receiving = await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, marker.receivingId);
    return sameRuntimeDataSetFingerprint(marker.receivingFingerprint, await dataSetFingerprint(receiving)) ? 'undo' : 'none';
  } catch {
    return 'none';
  }
}

function copiedMessage(targetRootPath: string, sameDataSet: boolean): string {
  const aside = `${path.basename(targetRootPath)}.limcode-copied-<时间>`;
  return sameDataSet
    ? `新数据目录里是当前历史的一份旧拷贝（从别处复制过来的）。迁移时它会整体改名为“${aside}”保留在旁边，不合并、不删除；当前历史照常迁入。`
    : `新数据目录里是从别处拷贝过来的另一份 LimCode 数据。迁移时它会整体改名为“${aside}”保留在旁边，不合并、不删除；之后它列在“历史与存储管理 → 外来历史库”里，核验通过的可以只读查看，也可以合并进当前库，或者把它放回原来的位置后在那里打开。`;
}

/** Data-set ids named by the RootBindings of a copied data directory (read as plain JSON). */
async function copiedDataSetIds(root: string): Promise<string[]> {
  const pointers = [path.join(root, VSCODE_RUNTIME_CONTROL_DIRECTORY, ROOT_BINDING_POINTER_FILE)];
  const scopes = path.join(root, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, 'scopes');
  for (const key of await fs.readdir(scopes).catch(() => [] as string[])) {
    pointers.push(path.join(scopes, key, VSCODE_RUNTIME_CONTROL_DIRECTORY, ROOT_BINDING_POINTER_FILE));
  }
  const ids: string[] = [];
  for (const pointer of pointers) {
    try {
      const value = JSON.parse(await fs.readFile(pointer, 'utf8')) as { dataSetId?: unknown };
      if (typeof value.dataSetId === 'string') ids.push(value.dataSetId);
    } catch { /* not a readable binding */ }
  }
  return ids;
}

async function suggestSubfolder(targetRootPath: string): Promise<string> {
  for (let index = 1; index < 10; index += 1) {
    const candidate = path.join(targetRootPath, index === 1 ? DATA_ROOT_RELOCATION_SUBFOLDER : `${DATA_ROOT_RELOCATION_SUBFOLDER}-${index}`);
    const info = await lstatOrUndefined(candidate);
    if (!info) return candidate;
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const names = (await fs.readdir(candidate).catch(() => ['?'])).filter((name) => !IGNORABLE_ENTRY_NAMES.has(name));
    if (names.length === 0 || names.some((name) => RUNTIME_ENTRY_NAMES.includes(name))) return candidate;
  }
  return path.join(targetRootPath, `${DATA_ROOT_RELOCATION_SUBFOLDER}-${timestampSlug()}`);
}

async function targetOfflineProblem(targetRootPath: string): Promise<string | undefined> {
  try {
    await assertConfigurationRootRuntimesOffline(targetRootPath);
    return undefined;
  } catch {
    return '新数据目录正被其它 LimCode 窗口使用（可能是另一个 VS Code 或 code-server），请先关闭它们再迁移。';
  }
}

// ---------------------------------------------------------------------------------------------
// Stage

/**
 * Online phase: the staging record, the journal and the receiving root in the target (under the
 * target's admission), then the CAS pre-copy of the current data set without any lock while every
 * window keeps working (anything written meanwhile is transferred again inside the exclusive merge).
 * `sourceDatabase` is this window's open Runtime of the current data set; the source is read
 * through its SQLite Backup API, never by copying its files.
 */
export async function stageDataRootRelocation(
  planned: DataRootRelocationPlan,
  sourceDatabase: RuntimeDatabase | undefined,
  options: DataRootRelocationOptions & {
    /** The id the caller recorded as in progress (the data-root pointer's record), so a crash can be undone. */
    relocationId?: string;
    /**
     * Called once right before the first change to the target, with where it was found: the caller
     * records it with its in-progress record (see DataRootRelocationTargetAnchor). A failure stops
     * the relocation before anything in the target changed.
     */
    beforeTargetChange?(anchor: DataRootRelocationTargetAnchor): Promise<void>;
  } = {}
): Promise<StagedDataRootRelocation> {
  const target = planned.targetRootPath;
  const relocationId = options.relocationId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const { plan, receiving, anchor } = await withRuntimeDataRootAdmission(target, async () => {
    const plan = await revalidatePlan(planned, options.installation);
    const earlier = await readMarker(target);
    if (earlier && await unfinishedRelocation(target, earlier, plan.sourceRootPath, options.installation) === 'undo') {
      const blocked = await targetOfflineProblem(target);
      if (blocked) throw new DataRootRelocationError('data-root-relocation-target-busy', blocked);
      options.onProgress?.('正在撤销上次没有完成的迁移');
      await undoRelocation(target, earlier);
    }
    const previous = plan.target.kind === 'copied' ? undefined : await readMarker(target);
    if (previous && !isCompleted(previous) && previous.state !== 'held') {
      throw new DataRootRelocationError('data-root-relocation-concurrent', '另一个 LimCode 窗口正在向这个目录迁移数据，请稍后再试。');
    }
    const anchor = await targetAnchor(target, plan.target.kind !== 'copied' && await pathExists(target));
    await options.beforeTargetChange?.(anchor);
    let movedAside: string | undefined;
    if (plan.target.kind === 'copied') {
      // A window may still be using the copy (e.g. of another installation): never pull it away.
      const blocked = await targetOfflineProblem(target);
      if (blocked) throw new DataRootRelocationError('data-root-relocation-target-busy', blocked);
      // The caller's in-progress record (relocation id) exists already, and the new name carries
      // that id: the next startup finds the copy again even when this process dies right here.
      movedAside = movedAsidePath(target, relocationId);
      await fs.rename(target, movedAside);
    }
    let marker: RelocationMarker | undefined;
    try {
      if (movedAside) await syncDirectoryDurably(path.dirname(target));
      const createdDirectory = !await pathExists(target);
      await fs.mkdir(target, { recursive: true });
      const preexisting = (await fs.readdir(target)).sort();
      const targetState: TargetState = plan.target.kind === 'limcode'
        ? { kind: 'limcode', receivingId: plan.target.receivingId, dataSetIds: [...plan.target.dataSetIds] }
        : plan.target.kind === 'copied' ? { kind: 'copied', sameDataSet: plan.target.sameDataSet } : { kind: 'empty' };
      marker = {
        kind: MARKER_KIND, state: 'staging', relocationId, sourceRootPath: plan.sourceRootPath, targetRootPath: target, startedAt, owner: currentOwner(),
        ...(options.installation ? { installation: options.installation } : {}),
        preexisting, createdDirectory, targetState,
        receivingId: plan.target.kind === 'limcode' ? plan.target.receivingId : plan.current.id,
        ...(previous ? { previous: withoutPrevious(previous) } : {}),
        ...(movedAside ? { movedAside } : {})
      };
      await writeMarker(target, marker);
      const journal = await RelocationJournal.create(target, relocationId);
      return { plan, receiving: await prepareReceivingRoot(plan, journal), anchor };
    } catch (error) {
      const staging = marker;
      const undo = staging ? () => undoRelocation(target, staging)
        : movedAside ? () => restoreMovedAside(target, movedAside!) : async () => undefined;
      recordCleanup(error, await undo().then(() => true, (undoError: unknown) => {
        console.error('[LimCode] 撤销迁移准备失败。', undoError);
        return false;
      }));
      throw error;
    }
  });
  try {
    // Other data sets first: their hard links would otherwise change the ctime of objects shared
    // with the current data set after its pre-copy recorded them.
    const precopiedOthers = await precopyOthers(plan, relocationId, receiving.id, options);
    options.onProgress?.('正在预先复制正文文件');
    const precopied = await precopyRuntimeDataSetCas({ globalStoragePath: plan.sourceRootPath }, {
      candidateId: plan.current.id, expectedDataSetId: plan.current.dataSetId, expectedRootInstanceId: plan.current.rootInstanceId
    }, { configurationRootPath: target, binding: receiving.binding }, {
      ...(options.linkFile ? { linkFile: options.linkFile } : {}),
      ...(sourceDatabase ? { sourceDatabase } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    });
    return { plan, relocationId, startedAt, receiving, precopied, precopiedOthers, anchor };
  } catch (error) {
    recordCleanup(error, await abandonStagedDataRootRelocation({ plan, relocationId, anchor }).then(() => true, (undoError: unknown) => {
      console.error('[LimCode] 撤销迁移准备失败。', undoError);
      return false;
    }));
    throw error;
  }
}

/** The plan still holds (same current data set, same kind of target); nothing is measured again. */
async function revalidatePlan(planned: DataRootRelocationPlan, installation?: string): Promise<DataRootRelocationPlan> {
  const problems = await placementProblems(planned.targetRootPath, planned.sourceRootPath, planned.targetRootPath);
  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: planned.sourceRootPath });
  const current = requireCurrentCandidate(inspection.candidates);
  const { target } = await classifyTarget(planned.targetRootPath, planned.sourceRootPath, current.dataSetId, installation);
  if (target.kind === 'limcode') {
    const offline = await targetOfflineProblem(planned.targetRootPath);
    if (offline) problems.push(offline);
  }
  if (target.kind === 'invalid') problems.push(target.message);
  if (problems.length > 0) throw new DataRootRelocationError('data-root-relocation-precondition', problems.join('\n'));
  const unplanned = unconfirmedEarlierMovedWork(await inspectEarlierMovedWork(planned.sourceRootPath, inspection), planned.earlierMovedWork);
  if (current.id !== planned.current.id || current.dataSetId !== planned.current.dataSetId || unplanned
    || current.rootInstanceId !== planned.current.rootInstanceId || !isDeepStrictEqual(target, planned.target)) {
    throw new DataRootRelocationError('data-root-relocation-changed', '确认之后当前历史库或新数据目录发生了变化，请重新开始迁移。');
  }
  return planned;
}

async function prepareReceivingRoot(plan: DataRootRelocationPlan, journal: RelocationJournal): Promise<StagedDataRootRelocation['receiving']> {
  const target = plan.targetRootPath;
  if (plan.target.kind === 'limcode') {
    const candidate = await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, plan.target.receivingId);
    return { id: candidate.id, runtimeDataRootPath: candidate.runtimeDataRootPath, binding: await requireCompleteRuntimeDataSet(candidate) };
  }
  // A fresh root under the same id the current data set has in the old directory.
  const runtimeDataRootPath = await createDataSetRoot(target, plan.current.id, journal);
  const authority = createVscodeRootAuthority({ runtimeDataRootPath, configurationRootPath: target });
  const binding = await withRuntimeMaintenance(authority.expectedPaths(), () => initializeEmptyRuntimeRoot(authority));
  return { id: plan.current.id, runtimeDataRootPath, binding };
}

/** Journals the new data set's directories (the topmost one that does not exist yet). */
async function createDataSetRoot(target: string, id: string, journal: RelocationJournal): Promise<string> {
  const scopeRoot = resolveVscodeRuntimeDataSetScopeRoot(target, id);
  const runtimeDataRootPath = resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot });
  await journal.recordCreation(path.relative(target, path.dirname(runtimeDataRootPath)));
  return runtimeDataRootPath;
}

/**
 * Undoes what an abandoned relocation did in the target (e.g. the windows could not be closed);
 * only while its record is still ours. A staging (or interrupted undoing) record is undone; a
 * complete one only with `pointerUnchanged`: the caller read the data-root pointer after the
 * failure and it did not switch to this relocation (otherwise the relocation may have taken effect
 * and is never undone). A published or finalized one never. `anchor`: where the relocation found
 * the target (see DataRootRelocationTargetAnchor); a target that is not visible right now is never
 * taken for undone.
 */
export async function abandonStagedDataRootRelocation(
  staged: { plan: { targetRootPath: string }; relocationId: string; anchor?: DataRootRelocationTargetAnchor },
  options: { pointerUnchanged?: boolean } = {}
): Promise<void> {
  const target = path.resolve(staged.plan.targetRootPath);
  // Read first without a claim: no claim file is ever left beside a target that is not there.
  const found = await readMarker(target);
  if (!found || found.relocationId !== staged.relocationId) await assertTargetVisible(target, staged.anchor);
  await withRuntimeDataRootAdmission(target, async () => {
    const marker = await readMarker(target);
    if (!marker || marker.relocationId !== staged.relocationId) {
      // An undo removes the record right before the copied data comes back to its place: when that
      // last step failed, the copy is still beside it and is put back here (or the failure says where it is).
      const aside = await findMovedAside(target, staged.relocationId);
      if (aside) await restoreMovedAside(target, aside);
      return;
    }
    if (marker.state === 'published' || marker.state === 'finalized') {
      throw new DataRootRelocationError('data-root-relocation-published', '这次迁移已经生效（数据目录已切换到新目录），不会撤销。');
    }
    if (marker.state === 'complete' && !options.pointerUnchanged) {
      throw new DataRootRelocationError('data-root-relocation-unconfirmed',
        '新数据目录里已有这次迁移的完成记录，无法确认数据目录没有切换过去，所以没有撤销；下次启动时会再判断。');
    }
    if (await hasDatabaseRestore(target, marker)) {
      const blocked = await targetOfflineProblem(target);
      if (blocked) throw new DataRootRelocationError('data-root-relocation-target-busy', blocked);
    }
    await undoRelocation(target, marker);
  });
}

// ---------------------------------------------------------------------------------------------
// Complete

/**
 * Exclusive phase. Call while holding the old directory's configuration admission after every
 * Host of its current data set went offline (this window's own Runtime included). `publish`
 * switches the data-root pointer; it runs last, after the completion record and the old directory's
 * moved notice (`options.movedBy`; not written: a failure like any other). A failure before it
 * undoes the relocation in the target from its journal right there (both admissions still held,
 * and only while no Host has the target open); `dataRootRelocationCleanupState(error)` tells
 * whether that undo succeeded. A failure of `publish` itself is undone only when
 * `options.pointerUnchanged` proves the pointer did not switch (it may have switched before the
 * failure); otherwise nothing is undone ('not-cleaned') and the caller reads the pointer again and
 * either treats the relocation as done or abandons it with that proof (abandonStagedDataRootRelocation). Once
 * `publish` returned, the record is confirmed 'published' (best effort: the initiating installation
 * confirms it when it opens the new directory otherwise).
 */
export async function completeDataRootRelocation(
  staged: StagedDataRootRelocation,
  publish: (publication: DataRootRelocationPublication) => Promise<void>,
  options: DataRootRelocationOptions = {}
): Promise<DataRootRelocationResult> {
  const { plan } = staged;
  const source = plan.sourceRootPath;
  const target = plan.targetRootPath;
  const sourcePaths = { globalStoragePath: source };
  return withRuntimeDataRootAdmission(source, () => withRuntimeDataRootAdmission(target, async () => {
    const staging = await readMarker(target);
    if (staging?.state !== 'staging' || staging.relocationId !== staged.relocationId) {
      throw new DataRootRelocationError('data-root-relocation-lost', '新数据目录里的迁移准备记录不见了（可能已被另一个窗口清理），本次不迁移。');
    }
    const journal = RelocationJournal.open(target, staged.relocationId);
    /** The record as the target has it now (what an undo starts from). */
    let written: RelocationMarker = staging;
    let completed: RelocationMarker;
    let dataRootId: string;
    let outcome: Omit<DataRootRelocationResult, 'targetRootPath'>;
    let carried: DataRootCarriedDataSet[] = [];
    try {
      await settleEarlierMovedWork(plan, options);
      const current = await resolveVscodeRuntimeDataSet(sourcePaths, plan.current.id);
      // Only the data sets that move must be offline; another one still in use stays behind.
      await assertRuntimeHostsOffline(createRuntimeRootPaths(current.runtimeDataRootPath));
      const busyTarget = await targetOfflineProblem(target);
      if (busyTarget) throw new DataRootRelocationError('data-root-relocation-target-busy', busyTarget);
      if (!current.selected || current.dataSetId !== plan.current.dataSetId || current.rootInstanceId !== plan.current.rootInstanceId) {
        throw new DataRootRelocationError('data-root-relocation-changed', '迁移期间当前历史库发生了变化，本次不迁移。');
      }
      options.onProgress?.('正在核对当前历史库');
      const { fingerprint: currentFingerprint, work: currentWork } = await dataSetFingerprintWithWork(current);
      options.onProgress?.('正在复制设置、全局规则和技能');
      const configuration = await transferConfiguration(source, target, journal);
      options.onProgress?.('正在迁移当前历史库');
      if (plan.target.kind === 'limcode') {
        options.onProgress?.('正在为新目录的当前历史库做撤销副本');
        await backupReceivingDatabase(target, staged.receiving, journal);
        await journalMergeBackups(target, staged.receiving.runtimeDataRootPath, journal);
      }
      const merged = await mergeInto(sourcePaths, target, plan.current, staged.receiving.runtimeDataRootPath,
        { ...options, signal: undefined, progressLabel: '正在迁移当前历史库' }, plan.target.kind !== 'limcode', journal, staged.precopied.verification);
      // What the relocation left in the receiving data set: an undo later goes ahead only while it is unchanged.
      options.onProgress?.('正在核对新目录');
      const receivingFingerprint = await dataSetFingerprint(await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, staged.receiving.id));
      await journal.append({ op: 'received', path: path.relative(target, staged.receiving.runtimeDataRootPath), fingerprint: receivingFingerprint });
      await copyDebugCaptures(current.runtimeDataRootPath, staged.receiving.runtimeDataRootPath, target, journal);
      const others = await migrateOthers(staged, current, journal, options);
      // After the merges (they read the receiving data set's own deletion records): what merges into the
      // data sets here must never bring back, and whose continuation each changed identity is.
      options.onProgress?.('正在带上删除记录、合并记录和身份延续');
      const moved = await Promise.all(others.result.migrated.map(async (id): Promise<ContinuedIdentity> => {
        const other = plan.others.find((item) => item.id === id)!;
        const copy = await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, id);
        return { from: mergeIdentity(other), to: mergeIdentity(copy) };
      }));
      const carry = await planMergeRecordsCarry(source, target, [{ from: mergeIdentity(current), to: mergeIdentity(receivingFingerprint) }, ...moved],
        { relocationId: staged.relocationId, at: new Date().toISOString() });
      await applyMergeRecordsCarry(target, carry, journal);
      await verifyMergeRecordsCarry(source, target, carry);
      // Only what really moved: the current data set and the others copied now (not those merged earlier or left behind).
      carried = [{ ...identityOf(current), work: currentWork }, ...others.carried]
        .filter((item) => item.work.conversations.length > 0)
        .map((item) => ({ id: item.id, dataSetId: item.dataSetId, inventory: item.work, settlement: { state: 'pending' } }));
      const leftBehind = [...others.result.leftBehind, ...plan.unreadable.filter((item) => !others.result.leftBehind.some((left) => left.id === item.id))];
      if (plan.target.kind !== 'limcode') {
        await journal.recordCreation(VSCODE_RUNTIME_SELECTION_FILE);
        await selectVscodeRuntimeDataSet({ globalStoragePath: target }, staged.receiving.id);
      }
      await journal.recordCreation(DATA_ROOT_IDENTITY_FILE);
      dataRootId = await ensureDataRootIdentity(target);
      completed = {
        ...staging, state: 'complete', completedAt: new Date().toISOString(),
        migrated: [{
          ...identityOf(current), fingerprint: currentFingerprint,
          ...(merged.skippedConversations ? { skippedConversations: merged.skippedConversations } : {})
        }, ...others.migrated],
        configuration: configuration.copied,
        leftBehind,
        receivingFingerprint
      };
      await writeMarker(target, completed);
      written = completed;
      if (options.movedBy) {
        // Before the pointer switches: once it did, the old directory has it (see DataRootMovedNotice).
        // Not written: the relocation fails and is undone like any other failure before the switch.
        // A notice already there (an earlier relocation away from it) is kept for that undo to put back.
        options.onProgress?.('正在旧目录里记下数据已迁走');
        const noticePath = path.join(source, DATA_ROOT_MOVED_NOTICE_FILE);
        const earlier = await readTextIfPresent(noticePath);
        if (earlier !== undefined) await writeTextDurably(path.join(workDirectory(target, staged.relocationId), EARLIER_MOVED_NOTICE_FILE), earlier);
        await writeJsonDurably(noticePath, {
          kind: MOVED_NOTICE_KIND, targetRootPath: target, relocationId: staged.relocationId, movedAt: new Date().toISOString(),
          installation: options.movedBy,
          ...(carried.length > 0 ? { carriedWork: { dataSets: carried } } : {})
        });
      }
      outcome = {
        ...(staging.movedAside ? { copiedDataMovedTo: staging.movedAside } : {}),
        merged,
        configuration: {
          copiedFiles: configuration.copiedFiles, replacedFiles: configuration.replacedFiles,
          ...(configuration.replacedFiles > 0 ? { backupPath: journal.configurationBackupPath } : {})
        },
        others: { ...others.result, leftBehind }
      };
    } catch (error) {
      // Still under both admissions since this attempt began, and the staging record kept every
      // window from opening the target before: nobody else wrote there. A Host that has the target
      // open anyway (an old version) keeps its database untouched.
      options.onProgress?.('正在撤销本次迁移在新目录里的改动');
      recordCleanup(error, await undoAfterFailure(target, written).then(() => true, (undoError: unknown) => {
        console.error('[LimCode] 迁移失败后撤销新数据目录里的改动时出错。', undoError);
        return false;
      }));
      throw error;
    }
    try {
      await publish({ dataRootId });
    } catch (error) {
      const unchanged = await (options.pointerUnchanged?.() ?? Promise.resolve(false)).catch(() => false);
      if (unchanged) {
        options.onProgress?.('正在撤销本次迁移在新目录里的改动');
        recordCleanup(error, await undoAfterFailure(target, completed).then(() => true, (undoError: unknown) => {
          console.error('[LimCode] 切换指针失败后撤销新数据目录里的改动时出错。', undoError);
          return false;
        }));
      } else {
        recordCleanup(error, false);
      }
      throw error;
    }
    // The pointer switched: from here on nothing is undone. The confirmation and the cleanup are best effort.
    await writeMarker(target, { ...completed, state: 'published', publishedAt: new Date().toISOString() })
      .catch((error: unknown) => console.warn('[LimCode] 在新目录记下迁移已生效失败，下次打开新目录时补记。', error));
    await fs.rm(path.join(target, DATA_ROOT_MOVED_NOTICE_FILE), { force: true })
      .catch((error: unknown) => console.warn('[LimCode] 清除新目录里过时的“数据已迁走”标记失败。', error));
    return { targetRootPath: target, ...outcome };
  }));
}

/**
 * First in the exclusive phase, under the old directory's admission and before the target changes
 * any further: work an earlier relocation carried away from here and not settled here must not move
 * on. It is settled through the caller (the user chose so when confirming, which is the consent for
 * data sets not consented yet), each data set as at its open; anything left fails the relocation
 * (undone like any failure before the switch), and so does such work without that choice.
 */
async function settleEarlierMovedWork(plan: DataRootRelocationPlan, options: DataRootRelocationOptions): Promise<void> {
  const source = plan.sourceRootPath;
  const earlier = await inspectEarlierMovedWork(source);
  if (!earlier) return;
  const refuse = (work: DataRootEarlierMovedWork, cause?: unknown): DataRootRelocationError => new DataRootRelocationError(
    'data-root-relocation-earlier-moved-work', describeEarlierMovedWork(work).join('\n'), cause);
  if (!options.settleEarlierMovedWork || earlier.dataSets.some((item) => item.unreadable)) throw refuse(earlier);
  // Choosing to settle consents to what the confirmation named, not to what turned up since.
  if (unconfirmedEarlierMovedWork(earlier, plan.earlierMovedWork)) {
    throw new DataRootRelocationError('data-root-relocation-changed', '确认之后当前目录里又有了确认框没有列出的、上一次迁移迁走还没收尾的任务，本次不迁移；请重新开始迁移。');
  }
  options.onProgress?.('正在把上一次迁走、这里还没收尾的任务按中止收尾');
  const pending = earlier.dataSets.filter((item) => item.state === 'pending').map((item) => item.id);
  if (pending.length > 0) await consentToDataRootMovedWork(source, earlier.relocationId, options.installation ?? 'data-root-relocation', pending);
  for (const item of earlier.dataSets) {
    try {
      await options.settleEarlierMovedWork({ id: item.id, dataSetId: item.dataSetId });
    } catch (error) {
      throw new DataRootRelocationError('data-root-relocation-earlier-moved-work',
        `上一次迁移到 ${earlier.targetRootPath} 时迁走、这里还没收尾的任务没能全部收尾（历史库“${item.label}”：${errorMessage(error)}），这次不迁移；可以稍后重试。`, error);
    }
  }
  const left = await inspectEarlierMovedWork(source);
  if (left) throw refuse(left);
}

/**
 * The undo right after a failed completion: only while the target still shows this relocation's
 * record (a drive that just went away shows none: nothing is taken for undone), and not while a
 * Host has the target open and its database would be restored.
 */
async function undoAfterFailure(target: string, staging: RelocationMarker): Promise<void> {
  if ((await readMarker(target))?.relocationId !== staging.relocationId) {
    throw new DataRootRelocationError('data-root-relocation-target-invisible',
      `新数据目录里看不到这次迁移的记录（${target}；例如所在的盘刚刚断开），没有撤销；进行中记录保留，接上后会再撤销。`);
  }
  if (await hasDatabaseRestore(target, staging)) {
    const blocked = await targetOfflineProblem(target);
    if (blocked) throw new DataRootRelocationError('data-root-relocation-target-busy', blocked);
  }
  await undoRelocation(target, staging, { verified: true });
}

/**
 * Debug captures of the data set (<data root>/diagnostics/debug-captures, one directory per run)
 * move with it: a run the receiving data set does not have is copied (verified) and journaled.
 */
async function copyDebugCaptures(fromDataRoot: string, toDataRoot: string, target: string, journal: RelocationJournal): Promise<number> {
  const from = path.join(fromDataRoot, ...DEBUG_CAPTURES_PATH);
  const runs = (await fs.readdir(from, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  })).filter((entry) => entry.isDirectory() && !isTransientName(entry.name)).map((entry) => entry.name).sort();
  if (runs.length === 0) return 0;
  const to = path.join(toDataRoot, ...DEBUG_CAPTURES_PATH);
  const created = !await pathExists(to);
  if (created) {
    await journal.recordCreation(path.relative(target, to));
    await fs.mkdir(to, { recursive: true });
  }
  const state: TransferState = { journal, targetRoot: target, copiedFiles: 0, replacedFiles: 0, hashes: new Map() };
  let copied = 0;
  for (const run of runs) {
    const destination = path.join(to, run);
    if (await pathExists(destination)) continue;
    if (!created) await journal.append({ op: 'entry', path: path.relative(target, destination) });
    await copyTree(path.join(from, run), destination, state);
    copied += 1;
  }
  await syncDirectoryDurably(to);
  return copied;
}

/**
 * `freshRoot`: the receiving root was created by this relocation and is still empty, so the data
 * set is copied into it in batches (copyRuntimeDataSetIntoEmptyRoot; the caller holds the target's
 * admission and undoes the whole root on failure). An existing receiving data set gets one merge
 * transaction (bounded by the plan's row check).
 */
async function mergeInto(
  sourcePaths: { globalStoragePath: string },
  target: string,
  dataSet: { id: string; dataSetId: string; rootInstanceId: string },
  runtimeDataRootPath: string,
  options: DataRootRelocationOptions & { progressLabel?: string },
  freshRoot: boolean,
  journal: RelocationJournal,
  casVerification?: RuntimeDataSetCasVerification
): Promise<RuntimeDataSetMergeResult> {
  const input = { candidateId: dataSet.id, expectedDataSetId: dataSet.dataSetId, expectedRootInstanceId: dataSet.rootInstanceId };
  if (freshRoot) {
    return copyResult(await copyRuntimeDataSetIntoEmptyRoot(sourcePaths, input, { configurationRootPath: target, runtimeDataRootPath },
      copyOptions(options, casVerification)));
  }
  const authority = createVscodeRootAuthority({ runtimeDataRootPath, configurationRootPath: target });
  return withRuntimeMaintenance(authority.expectedPaths(), async () => {
    const database = await RuntimeDatabase.open(authority, { hostBootId: `data-root-relocation-${randomUUID()}` });
    try {
      // The rows the one transaction inserts are journaled before it commits (see JournalEntry 'merging').
      const relative = path.relative(target, runtimeDataRootPath);
      // Its one transaction commits durably (synchronous = FULL) before the relocation records it complete.
      return await mergeRuntimeDataSetIntoDatabase(sourcePaths, input, { configurationRootPath: target, database }, {
        migration: true, ...(options.linkFile ? { linkFile: options.linkFile } : {}),
        beforeCommit: (inserted) => journal.append({ op: 'merging', path: relative, inserted: inserted.map(([domain, id]) => [domain, id]) })
      });
    } finally {
      await database.close();
    }
  });
}

/** Batched-copy options of a relocation step: cancellation and a progress line per batch (at most twice a second). */
function copyOptions(
  options: DataRootRelocationOptions & { progressLabel?: string },
  casVerification?: RuntimeDataSetCasVerification
): RuntimeDataSetCopyOptions {
  let written = 0;
  let reportedAt = 0;
  return {
    ...(options.linkFile ? { linkFile: options.linkFile } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(casVerification ? { casVerification } : {}),
    ...(options.onProgress && options.progressLabel ? {
      onBatch: (batch) => {
        written += batch.rows;
        const now = Date.now();
        if (now - reportedAt < 500) return;
        reportedAt = now;
        options.onProgress!(`${options.progressLabel}（已写入 ${written} 行）`);
      }
    } : {})
  };
}

function copyResult(receipt: RuntimeDataSetCopyReceipt): RuntimeDataSetMergeResult {
  return {
    candidateId: receipt.candidateId, sourceDataSetId: receipt.source.dataSetId, targetDataSetId: receipt.target.dataSetId,
    insertedRows: receipt.rows, reusedRows: 0, insertedConversations: receipt.insertedConversations, ...receipt.cas, recoveredCommit: false,
    ...(receipt.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: receipt.upgradedFromEpoch } : {})
  };
}

/**
 * Online part of moving the other data sets: each one that will move gets a fresh root in the
 * target (journaled) and is copied whole while every window keeps working; the exclusive phase keeps
 * the copy when the source's files are unchanged and redoes it otherwise. One that cannot be copied
 * now (in use by an old window, an unreadable state) is simply tried again in the exclusive phase.
 */
async function precopyOthers(
  plan: DataRootRelocationPlan,
  relocationId: string,
  receivingId: string,
  options: DataRootRelocationOptions
): Promise<Record<string, PrecopiedDataSet>> {
  const target = plan.targetRootPath;
  const sourcePaths = { globalStoragePath: plan.sourceRootPath };
  const taken = new Set(plan.target.kind === 'limcode' ? plan.target.dataSetIds : []);
  taken.add(receivingId);
  const ledger = await readRuntimeDataSetMergeLedger(sourcePaths).catch(() => new Map());
  const journal = RelocationJournal.open(target, relocationId);
  const receipts: Record<string, PrecopiedDataSet> = {};
  for (const [index, other] of plan.others.entries()) {
    if (other.leaveBehind || taken.has(other.id)) continue;
    const record = ledger.get(other.id);
    const lastMerge = record ? runtimeDataSetLastMerge(record) : undefined;
    // Probably carried by the current data set (confirmed by fingerprint in the exclusive phase).
    if (lastMerge && sameRuntimeDataSetIdentity(lastMerge.target, plan.current)) continue;
    const label = `正在预先复制其它历史库（${index + 1}/${plan.others.length}）`;
    options.onProgress?.(label);
    // In use by a window (another installation, an old version): copied later if it is free by then.
    if (await dataSetInUse(sourcePaths, other.id)) continue;
    const runtimeDataRootPath = resolveVscodeRuntimeDataRoot({ globalStoragePath: resolveVscodeRuntimeDataSetScopeRoot(target, other.id) });
    let created: string | undefined;
    try {
      receipts[other.id] = await withRuntimeDataRootAdmission(target, async () => {
        if (await pathExists(path.dirname(runtimeDataRootPath))) throw new Error('新数据目录里已有这个历史库的目录');
        created = await firstMissingAncestor(target, path.dirname(runtimeDataRootPath));
        await createDataSetRoot(target, other.id, journal);
        await initializeFreshRoot(target, runtimeDataRootPath);
        const receipt = await copyRuntimeDataSetIntoEmptyRoot(sourcePaths, {
          candidateId: other.id, expectedDataSetId: other.dataSetId, expectedRootInstanceId: other.rootInstanceId
        }, { configurationRootPath: target, runtimeDataRootPath }, copyOptions({ ...options, progressLabel: label }));
        return { receipt, createdPath: created ?? path.dirname(runtimeDataRootPath) };
      });
    } catch (error) {
      if (created) await removeCreatedDataSetRoot(target, runtimeDataRootPath, created);
      if (options.signal?.aborted) throw error;
      console.warn(`[LimCode] 预先复制历史库 ${other.id} 未完成，独占阶段再迁移：${relocationReason(error)}`);
    }
  }
  return receipts;
}

/**
 * Removes a data set root this relocation created in the target: its control directory, then every
 * directory up to `createdPath` (the topmost one created for it) that is now empty. A parent shared
 * with another data set created meanwhile stays.
 */
async function removeCreatedDataSetRoot(target: string, runtimeDataRootPath: string, createdPath: string): Promise<void> {
  const top = path.resolve(createdPath);
  let directory = path.dirname(path.resolve(runtimeDataRootPath));
  if (!isPathBelow(path.resolve(target), top) || (directory !== top && !isPathBelow(top, directory))) {
    throw new Error(`Refusing to remove ${directory} outside ${top}.`);
  }
  await fs.rm(directory, { recursive: true, force: true });
  while (directory !== top) {
    directory = path.dirname(directory);
    try { await fs.rmdir(directory); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
      throw error;
    }
  }
}

async function initializeFreshRoot(target: string, runtimeDataRootPath: string): Promise<void> {
  const authority = createVscodeRootAuthority({ runtimeDataRootPath, configurationRootPath: target });
  await withRuntimeMaintenance(authority.expectedPaths(), () => initializeEmptyRuntimeRoot(authority));
}

/**
 * The merge engine's own backup of the receiving data set is written into its control root during
 * the merge: journaled before, so an undo removes it however far the merge got.
 */
async function journalMergeBackups(target: string, runtimeDataRootPath: string, journal: RelocationJournal): Promise<void> {
  const directory = path.join(path.dirname(path.resolve(runtimeDataRootPath)), RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY);
  const existing = await fs.readdir(directory).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (existing === undefined) await journal.recordCreation(path.relative(target, directory));
  else await journal.append({ op: 'children', path: path.relative(target, directory), keep: existing.sort() });
}

/**
 * An offline copy of an existing receiving database (every Host of the target is offline and this
 * process has it closed), journaled before the merge: an undo puts it back.
 */
async function backupReceivingDatabase(target: string, receiving: StagedDataRootRelocation['receiving'], journal: RelocationJournal): Promise<void> {
  const databasePath = path.resolve(receiving.binding.paths.databasePath);
  const journalFile = await lstatOrUndefined(`${databasePath}-journal`);
  if (journalFile && journalFile.size > 0) {
    throw new DataRootRelocationError('data-root-relocation-target-recovery', '新数据目录里的当前历史库有未完成的恢复，请先在那里打开一次 LimCode。');
  }
  const before = await dataSetFingerprint(await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, receiving.id));
  const name = `${DATABASE_BACKUP_PREFIX}${createHash('sha256').update(receiving.id).digest('hex').slice(0, 16)}`;
  const destination = path.join(journal.workDirectory, name);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(temporary, { recursive: true });
  try {
    for (const suffix of ['', '-wal']) {
      const from = `${databasePath}${suffix}`;
      if (!await pathExists(from)) continue;
      await copyDurably(from, path.join(temporary, `limcode.sqlite${suffix}`));
    }
    await syncDirectoryDurably(temporary);
    await fs.rename(temporary, destination);
    await syncDirectoryDurably(journal.workDirectory);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  const database = await fileStamp(path.join(destination, 'limcode.sqlite'));
  const wal = await fileStamp(path.join(destination, 'limcode.sqlite-wal'));
  if (!database) throw new DataRootRelocationError('data-root-relocation-backup', `新数据目录里当前历史库的迁移前副本没有写成：${destination}`);
  await journal.append({ op: 'database', path: path.relative(target, databasePath), backup: name, before, stamp: { database, ...(wal ? { wal } : {}) } });
}

/**
 * Every other data set of the old directory becomes its own data set under the same id in the
 * target, recorded as kept so it is never merged automatically there. One merged into the current
 * data set earlier and unchanged since is carried by it and not copied again. One that cannot move
 * (too large, unreadable, in use by an old window, an id already taken) stays in the old directory.
 */
async function migrateOthers(
  staged: StagedDataRootRelocation,
  current: VscodeRuntimeDataSetCandidate,
  journal: RelocationJournal,
  options: DataRootRelocationOptions
): Promise<{ result: DataRootRelocationResult['others']; migrated: MigratedDataSet[]; carried: Array<ReturnType<typeof identityOf> & { work: RelocatedWorkInventory }> }> {
  const { plan } = staged;
  const target = plan.targetRootPath;
  const sourcePaths = { globalStoragePath: plan.sourceRootPath };
  const result: DataRootRelocationResult['others'] = { migrated: [], covered: [], leftBehind: [] };
  const migrated: MigratedDataSet[] = [];
  const carried: Array<ReturnType<typeof identityOf> & { work: RelocatedWorkInventory }> = [];
  const taken = new Set(plan.target.kind === 'limcode' ? plan.target.dataSetIds : []);
  taken.add(staged.receiving.id);
  const ledger = await readRuntimeDataSetMergeLedger(sourcePaths).catch(() => new Map());
  for (const [index, other] of plan.others.entries()) {
    if (other.leaveBehind || taken.has(other.id)) {
      result.leftBehind.push({ id: other.id, reason: other.leaveBehind ?? '新数据目录里已有同名历史库' });
      continue;
    }
    options.onProgress?.(`正在迁移其它历史库（${index + 1}/${plan.others.length}）`);
    const runtimeDataRootPath = resolveVscodeRuntimeDataRoot({ globalStoragePath: resolveVscodeRuntimeDataSetScopeRoot(target, other.id) });
    const precopied = staged.precopiedOthers[other.id];
    // Everything created for this data set (by stage, or below) is removed on any failure: no partly
    // written or unmarked root may stay behind to be taken for a data set of the new directory.
    let created: string | undefined = precopied?.createdPath;
    try {
      const candidate = await resolveVscodeRuntimeDataSet(sourcePaths, other.id);
      if (candidate.dataSetId !== other.dataSetId || candidate.rootInstanceId !== other.rootInstanceId) {
        throw new Error('确认之后这个历史库发生了变化');
      }
      if (await dataSetInUse(sourcePaths, other.id)) throw new Error(DATA_SET_IN_USE_REASON);
      const { fingerprint, work } = await dataSetFingerprintWithWork(candidate);
      const record = ledger.get(other.id);
      const lastMerge = record ? runtimeDataSetLastMerge(record) : undefined;
      if (lastMerge && sameRuntimeDataSetIdentity(lastMerge.target, current) && sameRuntimeDataSetFingerprint(lastMerge.source, fingerprint)) {
        if (precopied) await removeCreatedDataSetRoot(target, runtimeDataRootPath, precopied.createdPath);
        migrated.push({ ...identityOf(candidate), fingerprint, mergedInto: current.id });
        result.covered.push(other.id);
        continue;
      }
      if (precopied) {
        // Copied while the windows kept working: kept when the source files are unchanged, else
        // the fresh root is emptied and the data set copied again now. Any failure removes every
        // directory stage created for it (below, through `created`).
        await ensureRuntimeDataSetCopyCurrent(sourcePaths, precopied.receipt, async () => {
          await fs.rm(path.dirname(runtimeDataRootPath), { recursive: true, force: true });
          await initializeFreshRoot(target, runtimeDataRootPath);
        }, copyOptions({ ...options, signal: undefined, progressLabel: `正在迁移其它历史库（${index + 1}/${plan.others.length}）` }));
      } else {
        if (await pathExists(path.dirname(runtimeDataRootPath))) throw new Error('新数据目录里已有这个历史库的目录');
        created = await firstMissingAncestor(target, path.dirname(runtimeDataRootPath));
        await createDataSetRoot(target, other.id, journal);
        await initializeFreshRoot(target, runtimeDataRootPath);
        await mergeInto(sourcePaths, target, other, runtimeDataRootPath,
          { ...options, signal: undefined, progressLabel: `正在迁移其它历史库（${index + 1}/${plan.others.length}）` }, true, journal);
      }
      await copyDebugCaptures(candidate.runtimeDataRootPath, runtimeDataRootPath, target, journal);
      await markVscodeRuntimeDataSetKept(await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, other.id));
      migrated.push({ ...identityOf(candidate), fingerprint });
      carried.push({ ...identityOf(candidate), work });
      result.migrated.push(other.id);
    } catch (error) {
      result.leftBehind.push({ id: other.id, reason: relocationReason(error) });
      if (created) {
        await removeCreatedDataSetRoot(target, runtimeDataRootPath, created).catch((removeError: unknown) => {
          console.error(`[LimCode] 删除新目录里未迁成的历史库 ${other.id} 失败。`, removeError);
          throw removeError;
        });
      }
    }
  }
  return { result, migrated, carried };
}

const DATA_SET_IN_USE_REASON = '这个历史库正被其它 LimCode 窗口使用（可能是另一个安装或旧版本），这次不迁移，留在旧目录（删除旧目录时也会保留）';

/** A data set of the old directory with an online Host (any installation, any version with a liveness record). */
async function dataSetInUse(sourcePaths: { globalStoragePath: string }, id: string): Promise<boolean> {
  const candidate = await resolveVscodeRuntimeDataSet(sourcePaths, id);
  return (await listActiveRuntimeHosts(createRuntimeRootPaths(candidate.runtimeDataRootPath))).length > 0;
}

/** Why another data set stays behind, in the relocation's words (the merge engine's speak of later merges). */
function relocationReason(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (isRuntimeHostsActiveError(error) || code === 'runtime-hosts-active' || code === 'runtime-legacy-owner-active') return DATA_SET_IN_USE_REASON;
  return errorMessage(error);
}

async function firstMissingAncestor(root: string, target: string): Promise<string | undefined> {
  const relative = path.relative(root, target).split(path.sep);
  for (let index = 1; index <= relative.length; index += 1) {
    const candidate = path.join(root, ...relative.slice(0, index));
    if (!await pathExists(candidate)) return candidate;
  }
  return undefined;
}

/** Content identity of a data set, read from a private copy in a worker; nothing is written anywhere. */
async function dataSetFingerprint(candidate: VscodeRuntimeDataSetCandidate): Promise<RuntimeDataSetFingerprint> {
  return fingerprintOf(await readRuntimeDataSetFacts(candidate, { contentDigest: true }));
}

/** The fingerprint and the unfinished work a relocation carries away, both from one private snapshot (never the live file). */
async function dataSetFingerprintWithWork(candidate: VscodeRuntimeDataSetCandidate): Promise<{ fingerprint: RuntimeDataSetFingerprint; work: RelocatedWorkInventory }> {
  const facts = await readRuntimeDataSetFacts(candidate, { contentDigest: true, relocatedWork: true });
  return { fingerprint: fingerprintOf(facts), work: facts.relocatedWork! };
}

function fingerprintOf(facts: Awaited<ReturnType<typeof readRuntimeDataSetFacts>>): RuntimeDataSetFingerprint {
  return {
    dataSetId: facts.binding.dataSetId,
    rootInstanceId: facts.binding.rootInstanceId,
    rootGeneration: facts.binding.rootGeneration,
    pointerRevision: facts.binding.pointerRevision,
    contentDigest: facts.contentDigest!
  };
}

// ---------------------------------------------------------------------------------------------
// Configuration

interface ConfigurationTransfer {
  copied: CopiedConfiguration[];
  copiedFiles: number;
  replacedFiles: number;
}

/**
 * Registered configuration entries, the data-root marker, global rules and skills (a custom data
 * directory may hold other files of the user; those stay). A missing target entry is copied; an
 * existing LimCode target keeps its own records: record stores at any depth are merged by record id,
 * a file present on both sides with different content takes the current version and the replaced
 * one is kept in the relocation's backup directory. Every copied file is verified by SHA-256 and
 * made durable; every change is journaled first.
 */
async function transferConfiguration(sourceRoot: string, targetRoot: string, journal: RelocationJournal): Promise<ConfigurationTransfer> {
  const state: TransferState = { journal, targetRoot, copiedFiles: 0, replacedFiles: 0, hashes: new Map() };
  const copied: CopiedConfiguration[] = [];
  for (const name of CONFIGURATION_ENTRIES) {
    const source = path.join(sourceRoot, name);
    if (!isConfigurationEntry(await lstatOrUndefined(source))) continue;
    await transferEntry(source, path.join(targetRoot, name), name, state);
    copied.push({ entry: name, digest: await treeDigest(source, state.hashes) });
  }
  return { copied, copiedFiles: state.copiedFiles, replacedFiles: state.replacedFiles };
}

/** A configuration entry the relocation copies: a file, a directory, or a link (copied as the link itself). */
function isConfigurationEntry(info: Stats | undefined): boolean {
  return !!info && (info.isFile() || info.isDirectory() || info.isSymbolicLink());
}

interface TransferState {
  journal: RelocationJournal;
  targetRoot: string;
  copiedFiles: number;
  replacedFiles: number;
  /** SHA-256 of every source file read, for the tree digest. */
  hashes: Map<string, string>;
}

async function transferEntry(from: string, to: string, relative: string, state: TransferState): Promise<void> {
  const info = await fs.lstat(from);
  const existing = await lstatOrUndefined(to);
  if (info.isDirectory()) {
    if (!existing) {
      await state.journal.append({ op: 'entry', path: relative });
      await copyTree(from, to, state);
      return;
    }
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      await moveAside(to, relative, state);
      await state.journal.append({ op: 'entry', path: relative });
      await copyTree(from, to, state);
      return;
    }
    if (await isRecordStore(from) && await isRecordStore(to)) {
      await mergeRecordStore(from, to, relative, state);
      return;
    }
    for (const name of (await fs.readdir(from)).sort()) {
      if (await isTransientEntry(from, name)) continue;
      await transferEntry(path.join(from, name), path.join(to, name), path.join(relative, name), state);
    }
    await syncDirectoryDurably(to);
    return;
  }
  if (info.isFile()) {
    const digest = await hashSource(from, state);
    if (existing?.isFile() && existing.size === info.size && await sha256File(to) === digest) return;
    if (existing?.isFile()) {
      await replaceFile(from, to, relative, digest, state);
    } else {
      if (existing) await moveAside(to, relative, state);
      else await state.journal.append({ op: 'entry', path: relative });
      await copyVerified(from, to, digest);
      state.copiedFiles += 1;
    }
    await syncDirectoryDurably(path.dirname(to));
    return;
  }
  if (info.isSymbolicLink()) {
    const link = await fs.readlink(from);
    if (existing?.isSymbolicLink() && await fs.readlink(to) === link) return;
    if (existing) await moveAside(to, relative, state);
    else await state.journal.append({ op: 'entry', path: relative });
    await fs.symlink(link, to);
    await syncDirectoryDurably(path.dirname(to));
  }
}

/** A tree created by this relocation (its top is already journaled). */
async function copyTree(from: string, to: string, state: TransferState): Promise<void> {
  await fs.mkdir(to);
  for (const entry of (await fs.readdir(from, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (await isTransientEntry(from, entry.name)) continue;
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, destination, state);
    else if (entry.isFile()) {
      await copyVerified(source, destination, await hashSource(source, state));
      state.copiedFiles += 1;
    } else if (entry.isSymbolicLink()) await fs.symlink(await fs.readlink(source), destination);
  }
  await syncDirectoryDurably(to);
}

/** The existing file is copied into the backups first; the new content then replaces it atomically. */
async function replaceFile(from: string, to: string, relative: string, digest: string, state: TransferState): Promise<void> {
  const backup = path.join(CONFIGURATION_BACKUP_DIRECTORY, relative);
  await state.journal.append({ op: 'replace', path: relative, backup });
  await copyIntoBackup(to, path.join(state.journal.workDirectory, backup));
  await copyVerified(from, to, digest);
  state.copiedFiles += 1;
  state.replacedFiles += 1;
}

/** A directory, link or file in the way of a different kind of entry is moved into the backups. */
async function moveAside(to: string, relative: string, state: TransferState): Promise<void> {
  const backup = path.join(CONFIGURATION_BACKUP_DIRECTORY, relative);
  const destination = path.join(state.journal.workDirectory, backup);
  await state.journal.append({ op: 'replace', path: relative, backup });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(to, destination);
  await syncDirectoryDurably(path.dirname(destination));
  state.replacedFiles += 1;
}

async function copyIntoBackup(file: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyDurably(file, temporary);
    await fs.rename(temporary, destination);
    await syncDirectoryDurably(path.dirname(destination));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function hashSource(file: string, state: TransferState): Promise<string> {
  const known = state.hashes.get(file);
  if (known) return known;
  const digest = await sha256File(file);
  state.hashes.set(file, digest);
  return digest;
}

interface RecordIndexEntry { id: string; file: string; updatedAt: string }

async function isRecordStore(directory: string): Promise<boolean> {
  return (await lstatOrUndefined(path.join(directory, INDEX_FILE)))?.isFile() === true;
}

/**
 * Union by record id (see transferConfiguration). The target index is replaced atomically after
 * its previous version was copied into the backups, so it is never missing.
 */
async function mergeRecordStore(source: string, target: string, relative: string, state: TransferState): Promise<void> {
  const sourceIndex = await readRecordIndex(path.join(source, INDEX_FILE));
  const targetIndex = await readRecordIndex(path.join(target, INDEX_FILE));
  await hashSource(path.join(source, INDEX_FILE), state);
  const entries = targetIndex.records.map((entry) => ({ ...entry }));
  const byId = new Map(entries.map((entry, index) => [entry.id, index] as const));
  const fileOwners = new Map(entries.map((entry) => [entry.file, entry.id] as const));
  let changed = false;
  const recordsDirectory = path.join(target, RECORDS_DIR);
  if (!await pathExists(recordsDirectory)) {
    await state.journal.append({ op: 'entry', path: path.join(relative, RECORDS_DIR) });
    await fs.mkdir(recordsDirectory);
  }
  for (const entry of sourceIndex.records) {
    const from = path.join(source, ...entry.file.split('/'));
    await hashSource(from, state);
    const existingIndex = byId.get(entry.id);
    const existing = existingIndex === undefined ? undefined : entries[existingIndex];
    if (existing && isDeepStrictEqual(await readRecordBody(from), await readRecordBody(path.join(target, ...existing.file.split('/'))).catch(() => undefined))) {
      continue;
    }
    const owner = fileOwners.get(entry.file);
    if (owner !== undefined && owner !== entry.id) {
      throw new DataRootRelocationError('data-root-relocation-configuration-conflict',
        `新数据目录的设置里有同名文件属于另一条记录（${relative}/${entry.file}），整体取消迁移。`);
    }
    await transferEntry(from, path.join(target, ...entry.file.split('/')), path.join(relative, ...entry.file.split('/')), state);
    if (existing && existing.file !== entry.file) fileOwners.delete(existing.file);
    if (existingIndex === undefined) {
      byId.set(entry.id, entries.length);
      entries.push({ ...entry });
    } else {
      entries[existingIndex] = { ...entry };
    }
    fileOwners.set(entry.file, entry.id);
    changed = true;
  }
  await syncDirectoryDurably(recordsDirectory);
  if (!changed) return;
  const indexPath = path.join(target, INDEX_FILE);
  const indexRelative = path.join(relative, INDEX_FILE);
  const backup = path.join(CONFIGURATION_BACKUP_DIRECTORY, indexRelative);
  await state.journal.append({ op: 'replace', path: indexRelative, backup });
  await copyIntoBackup(indexPath, path.join(state.journal.workDirectory, backup));
  await writeJsonDurably(indexPath, { ...targetIndex.raw, savedAt: new Date().toISOString(), records: entries });
  state.replacedFiles += 1;
}

async function readRecordIndex(file: string): Promise<{ raw: Record<string, unknown>; records: RecordIndexEntry[] }> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    throw new DataRootRelocationError('data-root-relocation-configuration-unreadable', `设置索引无法读取，整体取消迁移：${file}（${errorMessage(error)}）`);
  }
  const index = value as { records?: unknown } | null;
  if (!index || typeof index !== 'object' || Array.isArray(index) || !Array.isArray(index.records)) {
    throw new DataRootRelocationError('data-root-relocation-configuration-unreadable', `设置索引格式无效，整体取消迁移：${file}`);
  }
  const records = index.records as unknown[];
  if (!records.every((entry) => {
    const record = entry as Partial<RecordIndexEntry> | null;
    return !!record && typeof record.id === 'string' && typeof record.file === 'string' && typeof record.updatedAt === 'string'
      && /^records\/[^/\\]+\.json$/i.test(record.file);
  })) {
    throw new DataRootRelocationError('data-root-relocation-configuration-unreadable', `设置索引里有无效的记录项，整体取消迁移：${file}`);
  }
  return { raw: index as Record<string, unknown>, records: records as RecordIndexEntry[] };
}

/** A record file without its save timestamp: two saves of the same record compare equal. */
async function readRecordBody(file: string): Promise<unknown> {
  const body = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  delete body.savedAt;
  return body;
}

/**
 * Digest of a configuration entry: kinds, relative paths, file contents and link targets in order,
 * without LimCode's own lock and temporary files.
 */
async function treeDigest(root: string, hashes?: ReadonlyMap<string, string>): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const info = await fs.lstat(absolute);
    if (info.isDirectory()) {
      hash.update(`d\0${relative}\n`);
      for (const name of (await fs.readdir(absolute)).sort()) {
        if (await isTransientEntry(absolute, name)) continue;
        await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
      }
    } else if (info.isFile()) {
      hash.update(`f\0${relative}\0${hashes?.get(absolute) ?? await sha256File(absolute)}\n`);
    } else if (info.isSymbolicLink()) {
      hash.update(`l\0${relative}\0${await fs.readlink(absolute)}\n`);
    }
  };
  await visit(root, '');
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// What merges must never bring back (runtimeMergeTombstones, the merge ledger's closures)

/** Where a merge record the relocation rewrote keeps its previous version, in the relocation's work directory. */
const MERGE_RECORDS_BACKUP_DIRECTORY = 'merge-records';
/** `<dataSetId>.<rootInstanceId>`: a directory of one identity's deletion records (runtimeMergeTombstones). */
const IDENTITY_DIRECTORY_NAME = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

/**
 * A data set whose identity the relocation changes: the one it left in the new directory (`to`; not
 * known yet while planning a fresh root) continues the one it came from.
 */
interface ContinuedIdentity { from: RuntimeMergeIdentity; to?: RuntimeMergeIdentity }

/** One file the carry writes in the target; `replaces`: one is there already (backed up first). */
type MergeRecordsWrite =
  | { kind: 'copy'; from: string; to: string; digest: string; replaces: boolean }
  | { kind: 'write'; to: string; text: string; replaces: boolean };

interface MergeRecordsCarry {
  writes: MergeRecordsWrite[];
  /** What the target must hold afterwards (verifyMergeRecordsCarry); `keptClosures`: those of a target's record it joined. */
  deletionIdentities: RuntimeMergeIdentity[];
  keptClosures: Array<{ candidateId: string; closures: ReturnType<typeof runtimeDataSetMergeClosures> }>;
  continuations: Array<{ to: RuntimeMergeIdentity; continues: RuntimeMergeIdentity[] }>;
}

/**
 * What the relocation writes into the target of the old directory's merge bookkeeping, read only
 * (nothing is written): every deletion record (a new name is copied, the same name must hold the same
 * content), every merge ledger record (copied; one the target has under the same candidate id stays,
 * with the old one's closures joined to it per source identity), and for every data set whose
 * identity changes a continuation of its new identity: what the target kept for it, the old identity,
 * and what that one continued (chains expanded here, see readRuntimeMergeTargetIdentities). Without
 * it a copy of the old identity is no old copy any more and what the user deleted before the
 * relocation could be merged back. `movedAside`: the target's content is renamed aside first (a
 * copied target), so none of it counts. Throws DataRootRelocationError when something cannot be read.
 */
async function planMergeRecordsCarry(
  source: string,
  target: string,
  continued: readonly ContinuedIdentity[],
  options: { relocationId: string; at: string; movedAside?: boolean }
): Promise<MergeRecordsCarry> {
  const sourcePaths = { globalStoragePath: source };
  const targetPaths = { globalStoragePath: target };
  const sourceLedger = resolveVscodeRuntimeMergeLedgerRoot(sourcePaths);
  const targetLedger = resolveVscodeRuntimeMergeLedgerRoot(targetPaths);
  const existing = async (file: string): Promise<Stats | undefined> => options.movedAside ? undefined : lstatOrUndefined(file);
  const writes: MergeRecordsWrite[] = [];
  const keptClosures: MergeRecordsCarry['keptClosures'] = [];

  // Deletion records: files of unique names, never merged.
  const deletionIdentities = await readMergeRecords(() => deletionRecordIdentities(source), '旧目录里的删除记录');
  await readMergeRecords(() => readRuntimeDeletedConversations(source, deletionIdentities), '旧目录里的删除记录');
  for (const identity of deletionIdentities) {
    const name = runtimeMergeIdentityName(identity);
    const directory = path.join(sourceLedger, RUNTIME_DELETED_CONVERSATIONS_DIRECTORY, name);
    for (const file of (await fs.readdir(directory)).sort()) {
      if (!file.endsWith('.json')) continue;
      const from = path.join(directory, file);
      const to = path.join(targetLedger, RUNTIME_DELETED_CONVERSATIONS_DIRECTORY, name, file);
      const digest = await sha256File(from);
      const there = await existing(to);
      if (there) {
        if (there.isFile() && await sha256File(to) === digest) continue;
        throw mergeRecordsError(`新数据目录里已有同名但内容不同的删除记录（${to}），无法合在一起`);
      }
      writes.push({ kind: 'copy', from, to, digest, replaces: false });
    }
  }

  // Merge ledger records: closures are kept per source identity, whoever's record it is.
  const sourceRecords = await readMergeRecords(() => readRuntimeDataSetMergeLedger(sourcePaths), '旧目录里的合并记录');
  const targetRecords = options.movedAside ? new Map() : await readMergeRecords(() => readRuntimeDataSetMergeLedger(targetPaths), '新数据目录里的合并记录');
  for (const [candidateId, record] of sourceRecords) {
    const from = await runtimeDataSetMergeLedgerRecordFile(sourcePaths, candidateId);
    const to = await runtimeDataSetMergeLedgerRecordFile(targetPaths, candidateId);
    const there = await existing(to);
    if (there && !there.isFile()) throw mergeRecordsError(`新数据目录的合并记录里有同名的非普通文件（${to}）`);
    const kept = targetRecords.get(candidateId);
    if (!kept) {
      // Nothing there, or a file that is no record (a merge reads it as none): the old directory's record as it is.
      writes.push({ kind: 'copy', from, to, digest: await sha256File(from), replaces: there !== undefined });
      continue;
    }
    const joined = withRuntimeDataSetMergeClosures(kept, record);
    keptClosures.push({ candidateId, closures: runtimeDataSetMergeClosures(kept) });
    if (!isDeepStrictEqual(joined, kept)) writes.push({ kind: 'write', to, text: `${JSON.stringify(joined, null, 2)}\n`, replaces: true });
  }

  // Continuations of the identities that change.
  const continuations: MergeRecordsCarry['continuations'] = [];
  for (const { from, to } of continued) {
    const earlier = await readMergeRecords(() => readRuntimeIdentityAliases(source, from), '旧目录里历史库的身份延续记录');
    if (!to || sameRuntimeDataSetIdentity(from, to)) continue;
    const file = path.join(targetLedger, RUNTIME_IDENTITY_ALIASES_DIRECTORY, `${runtimeMergeIdentityName(to)}.json`);
    const kept = options.movedAside ? [] : await readMergeRecords(() => readRuntimeIdentityAliases(target, to), '新数据目录里当前历史库的身份延续记录');
    const entries: RuntimeIdentityContinuation[] = [];
    const add = (entry: RuntimeIdentityContinuation): void => {
      if (sameRuntimeDataSetIdentity(to, entry) || entries.some((known) => sameRuntimeDataSetIdentity(known, entry))) return;
      entries.push({ dataSetId: entry.dataSetId, rootInstanceId: entry.rootInstanceId, relocationId: entry.relocationId, at: entry.at });
    };
    for (const entry of [...kept, { ...from, relocationId: options.relocationId, at: options.at }, ...earlier]) add(entry);
    continuations.push({ to, continues: entries.map(({ dataSetId, rootInstanceId }) => ({ dataSetId, rootInstanceId })) });
    if (entries.length === kept.length) continue;
    writes.push({ kind: 'write', to: file, text: `${JSON.stringify({ version: 1, continues: entries }, null, 2)}\n`, replaces: await existing(file) !== undefined });
  }
  return { writes, deletionIdentities, keptClosures, continuations };
}

/**
 * Writes what planMergeRecordsCarry found, each change journaled first: a new file under the topmost
 * path it creates (an undo removes it), a rewritten one after its previous version was copied into
 * the relocation's work directory (an undo puts it back). Then every directory on the way is synced.
 */
async function applyMergeRecordsCarry(target: string, carry: MergeRecordsCarry, journal: RelocationJournal): Promise<void> {
  const directories = new Set<string>();
  for (const write of carry.writes) {
    const relative = path.relative(target, write.to);
    if (write.replaces) {
      const backup = path.join(MERGE_RECORDS_BACKUP_DIRECTORY, relative);
      await journal.append({ op: 'replace', path: relative, backup });
      await copyIntoBackup(write.to, path.join(journal.workDirectory, backup));
    } else {
      await journal.recordCreation(relative);
      await fs.mkdir(path.dirname(write.to), { recursive: true, mode: 0o700 });
    }
    if (write.kind === 'copy') await copyVerified(write.from, write.to, write.digest);
    else await writeTextDurably(write.to, write.text);
    for (let directory = path.dirname(write.to); isPathBelow(target, directory); directory = path.dirname(directory)) directories.add(directory);
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) await syncDirectoryDurably(directory);
  if (directories.size > 0) await syncDirectoryDurably(target);
}

/**
 * The target as a merge reads it now holds everything carried: every deletion the old directory
 * recorded, every closure of its ledger (per source identity and target), every continuation.
 */
async function verifyMergeRecordsCarry(source: string, target: string, carry: MergeRecordsCarry): Promise<void> {
  const mismatch = (what: string): DataRootRelocationError => new DataRootRelocationError('data-root-relocation-merge-records',
    `带到新数据目录的${what}与旧目录核对不一致，整体取消迁移。`);
  const targetPaths = { globalStoragePath: target };
  for (const identity of carry.deletionIdentities) {
    const carried = await readRuntimeDeletedConversations(target, [identity]);
    for (const id of await readRuntimeDeletedConversations(source, [identity])) if (!carried.has(id)) throw mismatch('删除记录');
  }
  const targetRecords = await readRuntimeDataSetMergeLedger(targetPaths);
  const expected = [
    ...[...await readRuntimeDataSetMergeLedger({ globalStoragePath: source })].map(([candidateId, record]) => ({ candidateId, closures: runtimeDataSetMergeClosures(record) })),
    ...carry.keptClosures
  ];
  for (const { candidateId, closures } of expected) {
    const kept = targetRecords.get(candidateId);
    for (const closure of closures) {
      const merged = new Set(kept ? runtimeDataSetConversationsMergedFrom(kept, closure.source, [closure.target]) : []);
      if (!closure.conversationIds.every((id) => merged.has(id))) throw mismatch('合并记录');
    }
  }
  for (const { to, continues } of carry.continuations) {
    const read = await readRuntimeIdentityAliases(target, to);
    if (!continues.every((identity) => read.some((entry) => sameRuntimeDataSetIdentity(entry, identity)))) throw mismatch('身份延续记录');
  }
}

/**
 * Before "回到旧目录" switches back from the directory relocation `relocationId` moved into: what the
 * user deleted here from a data set that continues one of the old directory through that relocation
 * is recorded there too, for the one it came from, so a merge there leaves those conversations out
 * as well (a copy of them elsewhere, e.g. a library merged here and then deleted from). Nothing of
 * the old directory's data changes: a conversation still there stays. Returns how many were recorded;
 * throws when the records here cannot be read or one cannot be written there (nothing more is written).
 */
export async function carryDeletionRecordsBack(input: { currentRootPath: string; previousRootPath: string; relocationId: string }): Promise<number> {
  const current = path.resolve(input.currentRootPath);
  const previous = path.resolve(input.previousRootPath);
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: current }), RUNTIME_IDENTITY_ALIASES_DIRECTORY);
  let names: string[];
  try { names = (await fs.readdir(directory)).sort(); }
  catch (error) { if (isMissing(error)) return 0; throw error; }
  let recorded = 0;
  for (const name of names) {
    const match = name.endsWith('.json') ? IDENTITY_DIRECTORY_NAME.exec(name.slice(0, -'.json'.length)) : null;
    if (!match) continue;
    const identity = { dataSetId: match[1], rootInstanceId: match[2] };
    for (const earlier of (await readRuntimeIdentityAliases(current, identity)).filter((entry) => entry.relocationId === input.relocationId)) {
      // Only to leave out what is recorded there already: one more record of the same ids changes nothing.
      const known = await readRuntimeDeletedConversations(previous, [earlier]).catch(() => new Set<string>());
      const missing = [...await readRuntimeDeletedConversations(current, [identity])].filter((id) => !known.has(id)).sort();
      if (missing.length === 0) continue;
      await recordRuntimeDeletedConversations(previous, earlier, missing);
      recorded += missing.length;
    }
  }
  return recorded;
}

/** A data set's identity as merge records name it (a data set of the current epoch always has one). */
function mergeIdentity(dataSet: { dataSetId?: string; rootInstanceId?: string }): RuntimeMergeIdentity {
  if (!dataSet.dataSetId || !dataSet.rootInstanceId) throw mergeRecordsError('有一个历史库没有完整的身份');
  return { dataSetId: dataSet.dataSetId, rootInstanceId: dataSet.rootInstanceId };
}

/** The identities that have a directory of deletion records under `root` (other entries are no records). */
async function deletionRecordIdentities(root: string): Promise<RuntimeMergeIdentity[]> {
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: root }), RUNTIME_DELETED_CONVERSATIONS_DIRECTORY);
  let names: string[];
  try { names = (await fs.readdir(directory)).sort(); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  return names.flatMap((name) => {
    const match = IDENTITY_DIRECTORY_NAME.exec(name);
    return match ? [{ dataSetId: match[1], rootInstanceId: match[2] }] : [];
  });
}

async function readMergeRecords<T>(read: () => Promise<T>, what: string): Promise<T> {
  try { return await read(); }
  catch (error) { throw mergeRecordsError(`${what}读不出（${errorMessage(error)}）`, error); }
}

function mergeRecordsError(reason: string, cause?: unknown): DataRootRelocationError {
  return new DataRootRelocationError('data-root-relocation-merge-records',
    `${reason}。迁移要把删除记录、合并记录和身份延续带到新目录（以后合并旧拷贝时按它们跳过你删掉的对话），做不到就不能保证删掉的对话不会回来，这次不迁移。`, cause);
}

// ---------------------------------------------------------------------------------------------
// Journal and undo

class RelocationJournal {
  private constructor(public readonly target: string, public readonly workDirectory: string) {}

  public static async create(target: string, relocationId: string): Promise<RelocationJournal> {
    const backups = path.join(target, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY);
    await fs.mkdir(backups, { recursive: true });
    const journal = new RelocationJournal(target, workDirectory(target, relocationId));
    await fs.mkdir(journal.workDirectory);
    const handle = await fs.open(journal.file, 'wx', 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
    await syncDirectoryDurably(journal.workDirectory);
    await syncDirectoryDurably(backups);
    await syncDirectoryDurably(target);
    return journal;
  }

  public static open(target: string, relocationId: string): RelocationJournal {
    return new RelocationJournal(target, workDirectory(target, relocationId));
  }

  public get file(): string {
    return path.join(this.workDirectory, JOURNAL_FILE);
  }

  public get configurationBackupPath(): string {
    return path.join(this.workDirectory, CONFIGURATION_BACKUP_DIRECTORY);
  }

  public async append(entry: JournalEntry): Promise<void> {
    requireRelative(entry.path);
    const handle = await fs.open(this.file, 'a', 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(entry)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Journals the topmost path of `relative` that does not exist yet (nothing when all exist). */
  public async recordCreation(relative: string): Promise<void> {
    const missing = await firstMissingAncestor(this.target, path.join(this.target, relative));
    if (missing) await this.append({ op: 'entry', path: path.relative(this.target, missing) });
  }
}

function workDirectory(target: string, relocationId: string): string {
  return path.join(target, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, relocationId);
}

function journalPath(target: string, relocationId: string): string {
  return path.join(workDirectory(target, relocationId), JOURNAL_FILE);
}

async function readJournal(target: string, relocationId: string): Promise<JournalEntry[]> {
  let text: string;
  try { text = await fs.readFile(journalPath(target, relocationId), 'utf8'); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const entries: JournalEntry[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) {
      // Only the last line can be torn by a crash; it was never acted on.
      if (index >= lines.length - 2) break;
      throw new DataRootRelocationError('data-root-relocation-journal', `迁移日志损坏，无法撤销：${journalPath(target, relocationId)}`, error);
    }
    const entry = value as Partial<JournalEntry> & { backup?: unknown; keep?: unknown; before?: unknown; fingerprint?: unknown } | null;
    const keep = entry?.keep;
    const fingerprint = (item: unknown): boolean => typeof (item as Partial<RuntimeDataSetFingerprint> | undefined)?.contentDigest === 'string';
    const valid = !!entry && typeof entry.path === 'string' && (entry.op === 'entry'
      || (entry.op === 'children' && Array.isArray(keep) && keep.every((name) => typeof name === 'string'))
      || (entry.op === 'replace' && typeof entry.backup === 'string')
      || (entry.op === 'database' && typeof entry.backup === 'string' && fingerprint(entry.before)
        && typeof (entry as { stamp?: { database?: unknown } }).stamp?.database === 'string'
        && ['undefined', 'string'].includes(typeof (entry as { stamp: { wal?: unknown } }).stamp.wal))
      || (entry.op === 'received' && fingerprint(entry.fingerprint))
      || (entry.op === 'merging' && Array.isArray((entry as { inserted?: unknown }).inserted)
        && ((entry as { inserted: unknown[] }).inserted).every((row) => Array.isArray(row) && row.length === 2
          && typeof row[0] === 'string' && typeof row[1] === 'string')));
    if (!valid) {
      throw new DataRootRelocationError('data-root-relocation-journal', `迁移日志里有无法识别的记录：${line}`);
    }
    requireRelative(entry!.path!);
    if (typeof entry!.backup === 'string') requireRelative(entry!.backup);
    entries.push(entry as JournalEntry);
  }
  return entries;
}

type ReceivingCheck = { kind: 'unchanged' } | { kind: 'changed'; reason: string } | { kind: 'unreadable'; reason: string };

/**
 * Whether the receiving data set may still be undone: it is what the relocation left there (its
 * 'received' journal entry), or what it was before (an existing one's 'database' entry; also what a
 * restore that already happened put back), or exactly `before` plus the rows the merge journaled
 * before its commit ('merging': e.g. killed between the commit and the 'received' entry). Otherwise
 * someone else wrote there since ('changed'). An existing data set that cannot be read right now is
 * 'unreadable': nothing is decided, the next attempt reads it again. A fresh root of this relocation
 * that cannot be read any more (half removed by an interrupted undo) counts as unchanged.
 */
async function receivingChangedSince(target: string, marker: RelocationMarker): Promise<ReceivingCheck> {
  const entries = await readJournal(target, marker.relocationId);
  const database = entries.find((entry): entry is Extract<JournalEntry, { op: 'database' }> => entry.op === 'database');
  const received = entries.find((entry): entry is Extract<JournalEntry, { op: 'received' }> => entry.op === 'received');
  const merging = entries.find((entry): entry is Extract<JournalEntry, { op: 'merging' }> => entry.op === 'merging');
  if (!database && !received) return { kind: 'unchanged' };
  if (database) {
    // This undo's own restore is halfway (the database file is back, its WAL maybe not yet): it
    // continues while the files there are exactly the ones it put back (a rename keeps the stamp,
    // any write, also a checkpoint on close, changes it) and no other WAL appeared.
    const backup = path.join(workDirectory(target, marker.relocationId), database.backup);
    if (await pathExists(backup) && !await pathExists(path.join(backup, 'limcode.sqlite'))) {
      const destination = path.join(target, database.path);
      const walRestored = database.stamp.wal !== undefined && !await pathExists(path.join(backup, 'limcode.sqlite-wal'));
      const wal = await lstatOrUndefined(`${destination}-wal`);
      const walIntact = walRestored ? await fileStamp(`${destination}-wal`) === database.stamp.wal : !wal || wal.size === 0;
      if (await fileStamp(destination) === database.stamp.database && walIntact) return { kind: 'unchanged' };
      return { kind: 'changed', reason: '撤销还原到一半时，新数据目录里的当前历史库又被打开写入过。' };
    }
  }
  let candidate: VscodeRuntimeDataSetCandidate;
  let current: RuntimeDataSetFingerprint;
  try {
    candidate = await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, marker.receivingId);
    current = await dataSetFingerprint(candidate);
  } catch (error) {
    if (!database) return { kind: 'unchanged' };
    return { kind: 'unreadable', reason: errorMessage(error) };
  }
  if (database && sameRuntimeDataSetFingerprint(database.before, current)) return { kind: 'unchanged' };
  if (received && sameRuntimeDataSetFingerprint(received.fingerprint, current)) return { kind: 'unchanged' };
  if (database && merging && current.dataSetId === database.before.dataSetId && current.rootInstanceId === database.before.rootInstanceId) {
    try {
      if (await digestWithoutRows(candidate, merging.inserted) === database.before.contentDigest) return { kind: 'unchanged' };
    } catch (error) {
      // The check itself did not run (a defect of this build, e.g. its worker missing from the
      // package): never taken for a read that may pass, which would be retried forever.
      if (isCheckWorkerFailure(error)) throw error;
      return { kind: 'unreadable', reason: errorMessage(error) };
    }
  }
  return { kind: 'changed', reason: '新数据目录里的当前历史库在这次迁移之后有了新的内容（可能是另一个 LimCode 安装或窗口正在使用这个目录）。' };
}

/**
 * The content digest of a data set without the given rows, on a private copy in a worker. A read of
 * the copy that fails is the worker's answer (`ok: false`); a worker that could not start (its file
 * missing, MODULE_NOT_FOUND) or ended without an answer (an uncaught error, an abnormal exit) is a
 * defect of this build: 'data-root-relocation-check-worker-failed' (see isCheckWorkerFailure).
 */
async function digestWithoutRows(candidate: VscodeRuntimeDataSetCandidate, inserted: Array<[string, string]>): Promise<string> {
  const copy = await copyRuntimeDataSetDatabase(candidate, await requireCompleteRuntimeDataSet(candidate));
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let worker: Worker;
      try {
        worker = new Worker(path.join(__dirname, 'runtimeDataRootRelocationWorker.js'), { workerData: { databasePath: copy.databasePath, inserted } });
      } catch (error) {
        reject(checkWorkerFailure(error));
        return;
      }
      worker.once('message', (message: RelocationDigestWorkerResponse) => {
        settled = true;
        if (message.ok) resolve(message.digest);
        else reject(new Error(message.message));
      });
      worker.once('error', (error) => { if (!settled) { settled = true; reject(checkWorkerFailure(error)); } });
      worker.once('exit', (code) => {
        if (!settled) { settled = true; reject(checkWorkerFailure(new Error(`核对线程没有给出结果就退出了（退出码 ${code}）`))); }
      });
    });
  } finally {
    await copy.remove();
  }
}

function checkWorkerFailure(cause: unknown): DataRootRelocationError {
  return new DataRootRelocationError('data-root-relocation-check-worker-failed',
    `撤销前的核对没能运行（${errorMessage(cause)}）：这是这个 LimCode 版本自身的问题，不是目录读不出，重试不会好转；`
    + '那次迁移在新目录里的改动这次没有撤销，记录保持不变。请更新或重新安装 LimCode。', cause);
}

function isCheckWorkerFailure(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'data-root-relocation-check-worker-failed';
}

function heldError(target: string, marker: RelocationMarker): DataRootRelocationError {
  return new DataRootRelocationError('data-root-relocation-undo-held', describeHeld(target, marker));
}

function describeHeld(target: string, marker: RelocationMarker): string {
  return `${marker.held?.reason ?? ''}为了不覆盖这些内容，那次迁移在新目录 ${target} 里做的改动没有撤销，之后也不会自动撤销；`
    + `迁移前的数据库副本和被替换的设置保存在 ${workDirectory(target, marker.relocationId)}，需要时可以据此手动恢复。旧目录没有改动。`;
}

function isHeldError(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'data-root-relocation-undo-held';
}

function isUnreadableUndo(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'data-root-relocation-undo-unreadable';
}

async function hasDatabaseRestore(target: string, marker: RelocationMarker): Promise<boolean> {
  return (await readJournal(target, marker.relocationId)).some((entry) => entry.op === 'database');
}

/**
 * Undoes a relocation in the target from its journal, newest change first. First the receiving data
 * set must still be exactly what the relocation left there, or what it was before, or that plus only
 * its own rows (see receivingChangedSince): otherwise someone wrote there since (another installation
 * whose current directory it is), nothing is touched and the record becomes 'held'. When it cannot
 * be read right now, nothing is touched either and the record stays as it is, for the next attempt.
 * `verified`: the caller knows nobody could have written (the undo right after its own failure,
 * the target never left its admission). A complete record is marked 'undoing' (durably) before
 * anything is touched, so an interrupted undo is always continued; a staging record is marked too,
 * only so that others see a failed relocation being undone instead of one still running (it is
 * undone anyway, so a mark it cannot write stops nothing). A disk too full for the mark does not
 * stop the undo either (every step frees space or needs none): the mark is tried again after each
 * step until it is written. Then the moved notice it wrote in the old directory goes (see
 * removeMovedNotice). Every step can run again: replaced files and an existing
 * receiving database are put back from the relocation's own backups, created entries removed; then
 * the journal directory goes, then the record (the earlier completion record is put back, or it is
 * removed), and last the copied data renamed aside comes back to its place. Stops at the first
 * failure (a full disk says what can be deleted by hand). Callers hold the target's admission; a
 * database restore needs every Host of the target offline.
 */
async function undoRelocation(target: string, found: RelocationMarker, options: { verified?: boolean } = {}): Promise<void> {
  if (found.state === 'held') throw heldError(target, found);
  if (found.state === 'published' || found.state === 'finalized') {
    throw new DataRootRelocationError('data-root-relocation-published', '这次迁移已经生效（数据目录已切换到新目录），不会撤销。');
  }
  if (!options.verified) {
    const check = await receivingChangedSince(target, found);
    if (check.kind === 'unreadable') {
      throw new DataRootRelocationError('data-root-relocation-undo-unreadable',
        `那次没有完成的数据迁移还没有撤销：${target} 里的当前历史库现在读不出来（${check.reason}），无法确认那次迁移之后没有别人写入，`
        + '这次没有撤销，记录保持不变；下次会再试。');
    }
    if (check.kind === 'changed') {
      const held: RelocationMarker = { ...found, state: 'held', held: { at: new Date().toISOString(), reason: check.reason } };
      await writeMarker(target, held);
      throw heldError(target, held);
    }
  }
  const entries = await readJournal(target, found.relocationId);
  try {
    const marker: RelocationMarker = { ...found, state: 'undoing' };
    let marked = found.state === 'undoing';
    const markUndoing = async (): Promise<void> => {
      if (marked) return;
      try {
        await writeMarker(target, marker);
        marked = true;
      } catch (error) {
        if (found.state === 'complete' && !isDiskFull(error)) throw error;
        console.warn('[LimCode] 还没能记下撤销进行中，先接着撤销（撤销只会腾出空间），之后再记。', error);
      }
    };
    await markUndoing();
    await removeMovedNotice(target, found);
    const work = workDirectory(target, marker.relocationId);
    for (const entry of [...entries].reverse()) {
      await markUndoing();
      const destination = path.join(target, entry.path);
      if (entry.op === 'received' || entry.op === 'merging') continue;
      if (entry.op === 'entry') {
        await removeWithTemporaries(destination);
        continue;
      }
      if (entry.op === 'children') {
        // Entries created inside an existing directory (e.g. a merge backup of the receiving data set).
        for (const name of await fs.readdir(destination).catch(() => [] as string[])) {
          if (!entry.keep.includes(name)) await fs.rm(path.join(destination, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        }
        continue;
      }
      const backup = path.join(work, entry.backup);
      if (entry.op === 'replace') {
        if (!await pathExists(backup)) continue;
        const previous = await fs.lstat(backup);
        const current = await lstatOrUndefined(destination);
        if (current && (current.isDirectory() || !previous.isFile())) await fs.rm(destination, { recursive: true, force: true });
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(backup, destination);
        await syncDirectoryDurably(path.dirname(destination));
        continue;
      }
      await restoreReceivingDatabase(destination, backup);
    }
    await markUndoing();
    await fs.rm(work, { recursive: true, force: true });
    const backups = path.join(target, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY);
    if (!marker.preexisting.includes(DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY)) await fs.rmdir(backups).catch(() => undefined);
    if (marker.previous) await writeMarker(target, marker.previous);
    else await fs.rm(path.join(target, DATA_ROOT_RELOCATION_MARKER_FILE), { force: true });
    await syncDirectoryDurably(target).catch(() => undefined);
  } catch (error) {
    if (!isDiskFull(error)) throw error;
    throw new DataRootRelocationError('data-root-relocation-disk-full', await diskFullHint(target, found, entries), error);
  }
  if (found.movedAside && await pathExists(found.movedAside)) await restoreMovedAside(target, found.movedAside);
  else if (found.createdDirectory) await fs.rmdir(target).catch(() => undefined);
}

/**
 * The moved notice a relocation wrote in its source directory goes with its undo (it is written
 * before the pointer switch, see completeDataRootRelocation): the work it names never moved. The one
 * that was there before it (kept in its work directory) comes back, else the file goes. Only that
 * relocation's notice; one that cannot be read stays (it may be another's) and one that cannot be
 * removed stops the undo, for the next attempt. Not under the source's admission (the undo holds the
 * target's; the other order is the completion's): a consent there meanwhile is refused while the
 * relocation's process lives (see dataRootMovedNoticeUnderWay).
 */
async function removeMovedNotice(target: string, found: RelocationMarker): Promise<void> {
  const source = path.resolve(found.sourceRootPath);
  const noticePath = path.join(source, DATA_ROOT_MOVED_NOTICE_FILE);
  try {
    const read = await inspectDataRootMovedNotice(source);
    if (!('notice' in read) || read.notice.relocationId !== found.relocationId) return;
    const earlier = await readTextIfPresent(path.join(workDirectory(target, found.relocationId), EARLIER_MOVED_NOTICE_FILE));
    if (earlier === undefined) await fs.rm(noticePath, { force: true });
    else await writeTextDurably(noticePath, earlier);
  } catch (error) {
    throw new DataRootRelocationError('data-root-relocation-undo',
      `撤销没有做完：没能去掉旧目录里这次迁移写下的“数据已迁走”标记（${noticePath}：${errorMessage(error)}）。`
      + '它留着，旧目录会把没有迁走的任务当成已迁走，所以撤销停在这里，下次再试。', error);
  }
  await syncDirectoryDurably(source).catch(() => undefined);
}

/** What the user can delete by hand when the target's disk is too full even for the undo. */
async function diskFullHint(target: string, marker: RelocationMarker, entries: readonly JournalEntry[]): Promise<string> {
  const created = entries.filter((entry): entry is Extract<JournalEntry, { op: 'entry' }> => entry.op === 'entry')
    .map((entry) => path.join(target, entry.path));
  const left: string[] = [];
  for (const entry of marker.createdDirectory ? [target] : [...created, workDirectory(target, marker.relocationId)]) {
    if (await pathExists(entry).catch(() => true)) left.push(entry);
  }
  const lead = '新数据目录所在的磁盘已满，撤销没有做完（旧目录没有改动，下次启动会再试）。';
  return left.length > 0
    ? `${lead}可以先手动删除这次迁移在新目录里新建的这些内容来腾出空间：${left.join('；')}。`
    : `${lead}这次迁移新建的内容已经删掉了，只差写回迁移前的记录：请在这个盘上腾出一点空间。`;
}

/**
 * Puts the receiving database back from its offline copy; safe to repeat after an interruption: the
 * copy's database file is renamed back first (the target's own sidecars removed just before), then
 * its WAL, and only then is the copy's directory removed.
 */
async function restoreReceivingDatabase(destination: string, backup: string): Promise<void> {
  if (!await pathExists(backup)) return;
  const database = path.join(backup, 'limcode.sqlite');
  const wal = path.join(backup, 'limcode.sqlite-wal');
  if (await pathExists(database)) {
    for (const suffix of ['-shm', '-wal', '-journal']) await fs.rm(`${destination}${suffix}`, { force: true });
    await fs.rename(database, destination);
  } else if (!await pathExists(destination)) {
    throw new DataRootRelocationError('data-root-relocation-undo', `迁移前的数据库副本和目标数据库都不见了，无法撤销：${destination}`);
  }
  if (await pathExists(wal)) await fs.rename(wal, `${destination}-wal`);
  await syncDirectoryDurably(path.dirname(destination));
  await fs.rm(backup, { recursive: true, force: true });
}

/**
 * Copied LimCode data renamed aside goes back to its place. The target this relocation created may
 * still hold dead maintenance claims (never deleted by the claim protocol): that directory moves to
 * a new sibling first. Anything else there means someone put files there meanwhile: the copy stays
 * where it is and the error says where.
 */
async function restoreMovedAside(target: string, aside: string): Promise<void> {
  const names = await fs.readdir(target).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (names) {
    if (names.some((name) => !isClaimName(name) && !IGNORABLE_ENTRY_NAMES.has(name))) {
      throw new DataRootRelocationError('data-root-relocation-copy-aside',
        `从别处拷来的 LimCode 数据仍保留在 ${aside}，没能改回原来的名字 ${target}：那里现在有其它内容。请自行检查后改回。`);
    }
    if (names.length > 0) await fs.rename(target, `${target}.limcode-undone-${timestampSlug()}`);
    else await fs.rmdir(target);
  }
  try {
    await fs.rename(aside, target);
  } catch (error) {
    throw new DataRootRelocationError('data-root-relocation-copy-aside',
      `从别处拷来的 LimCode 数据仍保留在 ${aside}，没能改回原来的名字 ${target}（${errorMessage(error)}）。之后会再试；也可以自行改回。`, error);
  }
  await syncDirectoryDurably(path.dirname(target)).catch(() => undefined);
}

/** Where copied data in `target` is renamed aside by this relocation (found again from the relocation id alone). */
function movedAsidePath(target: string, relocationId: string): string {
  return `${target}.limcode-copied-${timestampSlug()}-${relocationId.slice(0, 8)}`;
}

/** The copied data this relocation renamed aside, when it is still there. */
async function findMovedAside(target: string, relocationId: string): Promise<string | undefined> {
  const base = path.basename(target);
  const suffix = `-${relocationId.slice(0, 8)}`;
  const names = await fs.readdir(path.dirname(target)).catch(() => [] as string[]);
  const name = names.find((entry) => entry.startsWith(`${base}.limcode-copied-`) && entry.endsWith(suffix));
  return name ? path.join(path.dirname(target), name) : undefined;
}

/** A created file together with this process family's temporaries beside it (`<name>.<pid>.<uuid>.tmp`). */
async function removeWithTemporaries(file: string): Promise<void> {
  await fs.rm(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  const base = path.basename(file);
  const siblings = await fs.readdir(path.dirname(file)).catch(() => [] as string[]);
  for (const name of siblings) {
    if (name.startsWith(`${base}.`) && isTransientName(name) && name.slice(base.length + 1).match(new RegExp(`^\\d+\\.${UUID_PATTERN}\\.tmp$`))) {
      await fs.rm(path.join(path.dirname(file), name), { recursive: true, force: true });
    }
  }
}

function requireRelative(relative: string): void {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..')) {
    throw new DataRootRelocationError('data-root-relocation-journal', `迁移日志里的路径无效：${relative}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Records, recovery and leftovers

/**
 * The relocation record of a directory. Only a missing file means "none": any other read error (a
 * drive that hiccups, no permission) throws, since it proves nothing either way. A record that does
 * not describe this directory (copied along from elsewhere) is ignored.
 */
async function readMarker(root: string): Promise<RelocationMarker | undefined> {
  let text: string;
  try { text = await fs.readFile(path.join(root, DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8'); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  return isMarker(value) && isSamePath(path.resolve(value.targetRootPath), path.resolve(root)) ? value : undefined;
}

/** Copied, with its pointer switch still to be confirmed or confirmed (see RelocationMarker.state). */
function isCompleted(marker: RelocationMarker): boolean {
  return marker.state === 'complete' || marker.state === 'published' || marker.state === 'finalized';
}

function isMarker(value: unknown): value is RelocationMarker {
  const marker = value as Partial<RelocationMarker> | null;
  const strings = (items: unknown): boolean => Array.isArray(items) && items.every((item) => typeof item === 'string');
  const targetState = marker?.targetState as Partial<TargetState & { receivingId: unknown; dataSetIds: unknown }> | undefined;
  return !!marker && marker.kind === MARKER_KIND
    && ['staging', 'complete', 'published', 'finalized', 'undoing', 'held'].includes(String(marker.state))
    && (marker.installation === undefined || typeof marker.installation === 'string')
    && (marker.held === undefined || (typeof marker.held.at === 'string' && typeof marker.held.reason === 'string'))
    && typeof marker.relocationId === 'string' && /^[0-9a-f-]{36}$/.test(marker.relocationId)
    && typeof marker.sourceRootPath === 'string' && typeof marker.targetRootPath === 'string'
    && typeof marker.startedAt === 'string' && typeof marker.receivingId === 'string'
    && typeof marker.createdDirectory === 'boolean' && strings(marker.preexisting)
    && !!marker.owner && typeof marker.owner.processId === 'number'
    && !!targetState && (targetState.kind === 'empty'
      || (targetState.kind === 'copied' && typeof (targetState as { sameDataSet?: unknown }).sameDataSet === 'boolean')
      || (targetState.kind === 'limcode' && typeof targetState.receivingId === 'string' && strings(targetState.dataSetIds)))
    && (marker.movedAside === undefined || typeof marker.movedAside === 'string')
    && (marker.previous === undefined || isMarker(marker.previous))
    && (marker.migrated === undefined || (Array.isArray(marker.migrated) && marker.migrated.every((item) =>
      !!item && typeof item.id === 'string' && typeof item.dataSetId === 'string' && typeof item.rootInstanceId === 'string'
      && !!item.fingerprint && typeof item.fingerprint.contentDigest === 'string')))
    && (marker.configuration === undefined || (Array.isArray(marker.configuration) && marker.configuration.every((item) =>
      !!item && typeof item.entry === 'string' && typeof item.digest === 'string')))
    && (marker.leftBehind === undefined || (Array.isArray(marker.leftBehind) && marker.leftBehind.every((item) =>
      !!item && typeof item.id === 'string' && typeof item.reason === 'string')));
}

async function writeMarker(root: string, marker: RelocationMarker): Promise<void> {
  await writeJsonDurably(path.join(root, DATA_ROOT_RELOCATION_MARKER_FILE), marker);
}

/** Only the latest earlier record is kept (the one an undo puts back). */
function withoutPrevious(marker: RelocationMarker): RelocationMarker {
  const { previous: _older, ...rest } = marker;
  return rest;
}

function currentOwner(): RelocationOwner {
  const identity = ownProcessStartIdentity();
  return { processId: process.pid, ...(identity ? { processStartIdentity: identity } : {}) };
}

function ownerState(owner: RelocationOwner): 'alive' | 'dead' | 'unknown' {
  return classifyRecordedProcess(owner.processId, owner.processStartIdentity);
}

/** Migration evidence of a directory, e.g. for the settings view (`hint`: what the user can do about it). */
export async function readDataRootRelocationRecord(root: string): Promise<{
  sourceRootPath: string;
  completedAt?: string;
  invalidated: boolean;
  leftBehind: Array<{ id: string; reason: string; hint: string }>;
} | undefined> {
  const marker = await readMarker(path.resolve(root));
  if (!marker || !isCompleted(marker)) return undefined;
  return {
    sourceRootPath: marker.sourceRootPath,
    ...(marker.completedAt ? { completedAt: marker.completedAt } : {}),
    invalidated: marker.invalidatedAt !== undefined,
    leftBehind: (marker.leftBehind ?? []).map((item) => ({ ...item, hint: leftBehindHint(item.reason) }))
  };
}

function leftBehindHint(reason: string): string {
  if (reason.startsWith(NAME_TAKEN_REASON)) {
    return '当前目录里已有同名的库，再迁移也不会带过来；需要时可以回到旧目录查看或导出其中的对话。';
  }
  if (reason.startsWith('无法读取')) return '可以回到旧目录打开一次（完成升级或修复）后再迁移一次，会合并。';
  return '可以回到旧目录处理后再迁移一次，会合并。';
}

/**
 * "回到旧目录": the completion record of the directory being left no longer describes the old one
 * (data may be written there again), so it can never justify deleting it. Also ends any redo.
 */
export async function invalidateDataRootRelocationRecord(currentRootPath: string): Promise<void> {
  const root = path.resolve(currentRootPath);
  await withRuntimeDataRootAdmission(root, async () => {
    const marker = await readMarker(root);
    if (!marker || !isCompleted(marker) || marker.invalidatedAt) return;
    await writeMarker(root, { ...marker, invalidatedAt: new Date().toISOString() });
    await finalizeRelocation(root, marker);
  });
}

/**
 * The relocation into this directory took effect and the installation that started it opened the
 * directory: its journal and the undo copy of a receiving database are no longer needed (replaced
 * configuration versions stay for the user) and the record becomes 'finalized'. Only that
 * installation, and only for a confirmed ('published') record; a 'complete' one it confirms first
 * when its pointer names this relocation (`publishedRelocationId`: the pointer switched, the
 * confirmation was lost). Any other installation that opens the directory never touches it.
 */
export async function finalizeDataRootRelocation(
  currentRootPath: string,
  input: { installation?: string; publishedRelocationId?: string } = {}
): Promise<void> {
  const root = path.resolve(currentRootPath);
  const found = await readMarker(root);
  if (!found || found.installation !== input.installation) return;
  const confirmable = found.state === 'complete' && found.relocationId === input.publishedRelocationId;
  if (found.state !== 'published' && !confirmable) return;
  await withRuntimeDataRootAdmission(root, async () => {
    let marker = await readMarker(root);
    if (!marker || marker.relocationId !== found.relocationId || (marker.state !== 'published' && marker.state !== 'complete')) return;
    const now = new Date().toISOString();
    if (marker.state === 'complete') {
      marker = { ...marker, state: 'published', publishedAt: now };
      await writeMarker(root, marker);
    }
    await finalizeRelocation(root, marker);
    await writeMarker(root, { ...marker, state: 'finalized', finalizedAt: now });
  });
}

async function finalizeRelocation(root: string, marker: RelocationMarker): Promise<void> {
  const work = workDirectory(root, marker.relocationId);
  for (const name of await fs.readdir(work).catch(() => [] as string[])) {
    // The merge records it rewrote only gained closures and continuations: their earlier versions go too.
    if (name === JOURNAL_FILE || name.startsWith(DATABASE_BACKUP_PREFIX) || name === MERGE_RECORDS_BACKUP_DIRECTORY) {
      await fs.rm(path.join(work, name), { recursive: true, force: true });
    }
  }
  await fs.rmdir(work).catch(() => undefined);
  await fs.rmdir(path.join(root, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY)).catch(() => undefined);
}

/**
 * A relocation recorded as in progress (see the data-root pointer; while it is there the pointer
 * did not switch to it) whose process is gone: what it did in the target is undone — its staging,
 * or a completion never confirmed — unless someone wrote there since ('held'). 'running' while the
 * owner lives (or cannot be judged), 'blocked' while the target is in use and a database restore
 * would be needed, 'unreadable' while the receiving data set cannot be read (nothing decided,
 * tried again later), 'unreachable' while the target is not visible (its parent is missing, or the
 * directories it was found in are not the ones there: `anchor`), 'orphaned' when the relocation's
 * data is in the target but can no longer be undone (its journal is gone, e.g. finalized by another
 * installation of an older version, or it was confirmed there). 'absent': nothing of it is there
 * (never written, or undone).
 */
export async function recoverInterruptedDataRootRelocation(input: {
  targetRootPath: string;
  relocationId: string;
  anchor?: DataRootRelocationTargetAnchor;
}): Promise<'recovered' | 'absent' | 'unreachable' | 'running' | 'blocked' | 'held' | 'unreadable' | 'orphaned'> {
  const target = path.resolve(input.targetRootPath);
  const nothingThere = async (): Promise<'recovered' | 'absent' | 'unreachable'> => {
    try { await assertTargetVisible(target, input.anchor); } catch { return 'unreachable'; }
    // An undo removes the record just before the copied data renamed aside comes back.
    const aside = await findMovedAside(target, input.relocationId);
    if (!aside) return 'absent';
    await withRuntimeDataRootAdmission(target, () => restoreMovedAside(target, aside));
    return 'recovered';
  };
  // Never takes a claim beside a directory whose parent is not there (an unmounted drive).
  if (!(await lstatOrUndefined(path.dirname(target)).catch(() => undefined))?.isDirectory()) return input.anchor ? 'unreachable' : 'absent';
  const found = await readMarker(target);
  if (!found || found.relocationId !== input.relocationId) return nothingThere();
  return withRuntimeDataRootAdmission(target, async () => {
    const marker = await readMarker(target);
    if (!marker || marker.relocationId !== input.relocationId) return nothingThere();
    if (marker.state === 'held') return 'held';
    if (marker.state === 'published' || marker.state === 'finalized') return 'orphaned';
    if (ownerState(marker.owner) !== 'dead') return 'running';
    if (marker.state === 'complete' && !await pathExists(journalPath(target, marker.relocationId))) return 'orphaned';
    if (await hasDatabaseRestore(target, marker) && await targetOfflineProblem(target)) return 'blocked';
    try {
      await undoRelocation(target, marker);
    } catch (error) {
      if (isHeldError(error)) return 'held';
      if (isUnreadableUndo(error)) return 'unreadable';
      throw error;
    }
    return 'recovered';
  });
}

/**
 * Before a window opens `root` (call under its configuration admission): a relocation into it that
 * never finished is not built upon. A staging or undoing record whose process is proven gone: the
 * undo is completed first (`undone`; the directory may then no longer hold LimCode data, so the
 * caller checks it again), unless someone wrote into it since, in which case nothing is touched,
 * the record is left 'held' and `held` says why and where the backups are (the directory opens as
 * it is). A complete record (copied, pointer switch not confirmed): the installation that started
 * it and whose pointer names it confirms it (`installation`, `publishedRelocationId`) and opens;
 * for anyone else it is refused while its process lives ('relocating'), and once that is gone the
 * user decides ('unpublished', see undoUnpublishedDataRootRelocation). A process alive or unknown,
 * a needed database restore while the directory is in use, or an undo that cannot read the
 * receiving data set right now: refused ('relocating').
 */
export async function settleDataRootRelocationBeforeOpen(
  root: string,
  opener: { installation?: string; publishedRelocationId?: string } = {}
): Promise<{ undone: boolean; held?: string }> {
  const target = path.resolve(root);
  return withRuntimeDataRootAdmission(target, async () => {
    let marker: RelocationMarker | undefined;
    try { marker = await readMarker(target); }
    catch (error) { throw new DataRootUnavailableError(target, readFailureReason(error), error); }
    if (!marker) return { undone: false };
    if (marker.state === 'complete') {
      if (opener.installation !== undefined && marker.installation === opener.installation && marker.relocationId === opener.publishedRelocationId) {
        await writeMarker(target, { ...marker, state: 'published', publishedAt: new Date().toISOString() });
        return { undone: false };
      }
      if (marker.invalidatedAt) return { undone: false };
      throw new DataRootUnavailableError(target, ownerState(marker.owner) === 'dead' ? 'unpublished' : 'relocating');
    }
    if (marker.state !== 'staging' && marker.state !== 'undoing') return { undone: false };
    if (ownerState(marker.owner) !== 'dead') throw new DataRootUnavailableError(target, marker.state === 'undoing' ? 'relocation-undoing' : 'relocating');
    if (await hasDatabaseRestore(target, marker) && await targetOfflineProblem(target)) {
      throw new DataRootUnavailableError(target, 'relocating', new DataRootRelocationError('data-root-relocation-target-busy',
        '发起它的进程已经结束，但这个目录正被其它 LimCode 窗口使用（可能是另一个 VS Code 或 code-server），要等它们关闭后才能撤销。'));
    }
    try {
      await undoRelocation(target, marker);
    } catch (error) {
      if (isHeldError(error)) return { undone: false, held: errorMessage(error) };
      if (isUnreadableUndo(error)) throw new DataRootUnavailableError(target, 'unreadable', error);
      throw error;
    }
    return { undone: true };
  });
}

/**
 * "撤销那次未完成的迁移并打开": the user's choice for a directory with another installation's
 * relocation that copied its data in but never switched to it, its process gone (see
 * settleDataRootRelocationBeforeOpen, 'unpublished'). Undone like any other: never over content
 * written since ('held' then says why and where the backups are).
 */
export async function undoUnpublishedDataRootRelocation(root: string): Promise<{ held?: string }> {
  const target = path.resolve(root);
  return withRuntimeDataRootAdmission(target, async () => {
    const marker = await readMarker(target);
    if (!marker || marker.state !== 'complete' || marker.invalidatedAt) return {};
    if (ownerState(marker.owner) !== 'dead') throw new DataRootUnavailableError(target, 'relocating');
    if (!await pathExists(journalPath(target, marker.relocationId))) {
      throw new DataRootRelocationError('data-root-relocation-orphaned',
        `那次迁移的撤销日志已经不在了（${journalPath(target, marker.relocationId)}），无法自动撤销；这个目录里有那次迁移复制进来的数据。`
        + `确认要按现在的样子使用这个目录，可以删除 ${path.join(target, DATA_ROOT_RELOCATION_MARKER_FILE)} 后再打开。`);
    }
    if (await hasDatabaseRestore(target, marker)) {
      const blocked = await targetOfflineProblem(target);
      if (blocked) throw new DataRootRelocationError('data-root-relocation-target-busy', blocked);
    }
    try {
      await undoRelocation(target, marker);
    } catch (error) {
      if (isHeldError(error)) return { held: errorMessage(error) };
      throw error;
    }
    return {};
  });
}

/**
 * 'running': an unfinished relocation into `root` whose process is alive or cannot be judged, or a
 * completion that was never confirmed; 'undoing': one that failed and is being undone (or its undo
 * stopped) in a live process (opening it is refused or asks, see settleDataRootRelocationBeforeOpen).
 */
async function unfinishedRelocationOwner(root: string): Promise<'none' | 'running' | 'undoing' | 'dead' | 'unpublished'> {
  const marker = await readMarker(path.resolve(root));
  if (marker?.state === 'complete' && !marker.invalidatedAt) return ownerState(marker.owner) === 'dead' ? 'unpublished' : 'running';
  if (!marker || (marker.state !== 'staging' && marker.state !== 'undoing')) return 'none';
  if (ownerState(marker.owner) === 'dead') return 'dead';
  return marker.state === 'undoing' ? 'undoing' : 'running';
}

/**
 * A relocation into `root` whose undo was held (someone wrote there since): why, and where its
 * backups are. For a notice when the directory is opened.
 */
export async function readDataRootRelocationHold(root: string): Promise<{ relocationId: string; message: string } | undefined> {
  const target = path.resolve(root);
  const marker = await readMarker(target);
  return marker?.state === 'held' ? { relocationId: marker.relocationId, message: describeHeld(target, marker) } : undefined;
}

/** The copied data a relocation renamed aside from `targetRootPath`, while it is still there (not put back). */
export async function findDataRootRelocationCopy(targetRootPath: string, relocationId: string): Promise<string | undefined> {
  return findMovedAside(path.resolve(targetRootPath), relocationId);
}

/** The moved notice of a directory (see DATA_ROOT_MOVED_NOTICE_FILE), if it has a valid one (for what is only shown). */
export async function readDataRootMovedNotice(root: string): Promise<DataRootMovedNotice | undefined> {
  const read = await inspectDataRootMovedNotice(root);
  return 'notice' in read ? read.notice : undefined;
}

/**
 * The moved notice as the gate of an old directory reads it: none, a valid one, or one that is there
 * but cannot be understood (`invalid`: broken JSON, another shape, a state this version does not know,
 * such as one a newer version wrote; with the new directory when that part is readable). A read that
 * fails otherwise proves nothing and throws.
 */
export async function inspectDataRootMovedNotice(root: string): Promise<
  { none: true } | { notice: DataRootMovedNotice } | { invalid: string; targetRootPath?: string }
> {
  let text: string;
  try { text = await fs.readFile(path.join(path.resolve(root), DATA_ROOT_MOVED_NOTICE_FILE), 'utf8'); }
  catch (error) {
    if (isMissing(error)) return { none: true };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { return { invalid: `不是完整的 JSON：${errorMessage(error)}` }; }
  const notice = value as (Partial<DataRootMovedNotice> & { kind?: unknown }) | null;
  const target = typeof notice?.targetRootPath === 'string' && path.isAbsolute(notice.targetRootPath) ? { targetRootPath: notice.targetRootPath } : {};
  if (notice?.kind !== MOVED_NOTICE_KIND || typeof notice.targetRootPath !== 'string' || typeof notice.relocationId !== 'string'
    || typeof notice.movedAt !== 'string' || typeof notice.installation?.id !== 'string' || typeof notice.installation.label !== 'string') {
    return { invalid: '内容不是本版本认得的“数据已迁走”标记', ...target };
  }
  if (notice.carriedWork !== undefined && !isCarriedWork(notice.carriedWork)) {
    return { invalid: '迁走的任务清单或它的收尾状态不是本版本认得的内容（可能是更新的版本写的）', ...target };
  }
  return {
    notice: {
      targetRootPath: notice.targetRootPath, relocationId: notice.relocationId, movedAt: notice.movedAt,
      installation: { id: notice.installation.id, label: notice.installation.label },
      ...(notice.carriedWork ? { carriedWork: notice.carriedWork } : {})
    }
  };
}

/**
 * Whether the relocation a moved notice names is still under way: the target's record of it is
 * staging, complete or being undone and its process is not proven gone. The notice is written before
 * the pointer switches, so until that process ends the relocation may still fail and be undone
 * (removing the notice): nothing is consented to or settled on it meanwhile. Once that process is
 * gone the notice holds as written (a relocation it names may have switched), until an undo removes it.
 */
export async function dataRootMovedNoticeUnderWay(notice: DataRootMovedNotice): Promise<boolean> {
  const marker = await readMarker(path.resolve(notice.targetRootPath)).catch(() => undefined);
  return !!marker && marker.relocationId === notice.relocationId
    && (marker.state === 'staging' || marker.state === 'complete' || marker.state === 'undoing')
    && ownerState(marker.owner) !== 'dead';
}

function isCarriedWork(value: unknown): value is DataRootCarriedWork {
  const work = value as Partial<DataRootCarriedWork> | null;
  return !!work && Array.isArray(work.dataSets) && work.dataSets.length > 0 && work.dataSets.every((item) => {
    const settlement = item?.settlement as { state?: unknown; at?: unknown; by?: unknown; result?: unknown; left?: unknown } | undefined;
    try { parseRelocatedWorkInventory(item?.inventory); } catch { return false; }
    const stamped = typeof settlement?.at === 'string' && typeof settlement.by === 'string';
    return typeof item.id === 'string' && typeof item.dataSetId === 'string'
      && (settlement?.state === 'pending'
        || (settlement?.state === 'consented' && stamped && (settlement.left === undefined || isCarriedWorkLeft(settlement.left)))
        || (settlement?.state === 'settled' && stamped && isCarriedWorkResult(settlement.result)));
  });
}

function isCarriedWorkResult(value: unknown): value is DataRootCarriedWorkResult {
  const counts = (value as Partial<DataRootCarriedWorkResult> | null)?.counts;
  return !!counts && typeof counts === 'object' && !Array.isArray(counts)
    && Object.values(counts).every((count) => Number.isSafeInteger(count) && count >= 0);
}

const LEFT_WHY: ReadonlySet<string> = new Set(['live', 'failed', 'needs_human', 'rounds_exhausted']);

function isCarriedWorkLeft(value: unknown): value is DataRootCarriedWorkLeft {
  const left = value as Partial<DataRootCarriedWorkLeft> | null;
  return !!left && typeof left.at === 'string' && typeof left.by === 'string' && Array.isArray(left.items) && left.items.length > 0
    && left.items.every((item: Partial<DataRootCarriedWorkLeftItem> | null) => !!item && typeof item.conversationId === 'string'
      && typeof item.title === 'string' && typeof item.list === 'string' && typeof item.id === 'string'
      && typeof item.why === 'string' && LEFT_WHY.has(item.why) && typeof item.detail === 'string');
}

/** Rewrites the moved notice of `root` for relocation `relocationId` under its admission (false: not that notice). */
async function updateMovedWork(root: string, relocationId: string, change: (work: DataRootCarriedWork) => DataRootCarriedWork | undefined): Promise<boolean> {
  const resolved = path.resolve(root);
  return withRuntimeDataRootAdmission(resolved, async () => {
    const notice = await readDataRootMovedNotice(resolved);
    if (!notice?.carriedWork || notice.relocationId !== relocationId) return false;
    const next = change(notice.carriedWork);
    if (!next) return false;
    await writeJsonDurably(path.join(resolved, DATA_ROOT_MOVED_NOTICE_FILE), { kind: MOVED_NOTICE_KIND, ...notice, carriedWork: next });
    return true;
  });
}

/**
 * The user chose to keep using the old directory ("回到旧目录", or "在这里继续" when opening it): the
 * pending carried work of every data set (or of `ids`) is settled when it is opened there, before
 * anything runs. Only the notice of that relocation; a consent or settlement is never taken back.
 */
export async function consentToDataRootMovedWork(root: string, relocationId: string, by: string, ids?: readonly string[]): Promise<boolean> {
  const at = new Date().toISOString();
  return updateMovedWork(root, relocationId, (work) => {
    let changed = false;
    const dataSets = work.dataSets.map((item) => {
      if (item.settlement.state !== 'pending' || (ids && !ids.includes(item.id))) return item;
      changed = true;
      return { ...item, settlement: { state: 'consented' as const, at, by } };
    });
    return changed ? { dataSets } : undefined;
  });
}

/** Records, once, that data set `id`'s carried work is all settled (after its consent), with what was closed. */
export async function recordDataRootMovedWorkSettled(
  root: string, relocationId: string, id: string, by: string, result: DataRootCarriedWorkResult
): Promise<boolean> {
  if (!isCarriedWorkResult(result)) throw new TypeError('recordDataRootMovedWorkSettled requires the counts of what was closed.');
  return updateMovedWork(root, relocationId, (work) => {
    const item = work.dataSets.find((entry) => entry.id === id);
    if (item?.settlement.state !== 'consented') return undefined;
    const settlement = { state: 'settled' as const, at: new Date().toISOString(), by, result: { counts: { ...result.counts } } };
    return { dataSets: work.dataSets.map((entry) => (entry === item ? { ...entry, settlement } : entry)) };
  });
}

/**
 * Records what an open of data set `id` could not settle (it stays consented; that open failed and
 * nothing ran), for the prompt; the next open settles all of it again.
 */
export async function recordDataRootMovedWorkLeft(
  root: string, relocationId: string, id: string, by: string, items: readonly DataRootCarriedWorkLeftItem[]
): Promise<boolean> {
  const left: DataRootCarriedWorkLeft = { at: new Date().toISOString(), by, items: items.map((item) => ({ ...item })) };
  if (!isCarriedWorkLeft(left)) throw new TypeError('recordDataRootMovedWorkLeft requires what was left and why.');
  return updateMovedWork(root, relocationId, (work) => {
    const item = work.dataSets.find((entry) => entry.id === id);
    if (item?.settlement.state !== 'consented') return undefined;
    const settlement = { ...item.settlement, left };
    return { dataSets: work.dataSets.map((entry) => (entry === item ? { ...entry, settlement } : entry)) };
  });
}

/** This installation uses the directory again (e.g. "回到旧目录"): its own moved notice there goes. */
export async function clearDataRootMovedNotice(root: string, installationId: string): Promise<boolean> {
  const notice = await readDataRootMovedNotice(root);
  if (!notice || notice.installation.id !== installationId) return false;
  // Carried work not settled yet keeps it: a data set opened later must still be settled first.
  if (notice.carriedWork?.dataSets.some((item) => item.settlement.state !== 'settled')) return false;
  await fs.rm(path.join(path.resolve(root), DATA_ROOT_MOVED_NOTICE_FILE), { force: true });
  return true;
}

/** State of a recorded relocation's process (for the pointer's in-progress record). */
export function dataRootRelocationOwnerState(owner: RelocationOwner): 'alive' | 'dead' | 'unknown' {
  return ownerState(owner);
}

/**
 * Removes private copies abandoned by crashed processes: the temporary directories of snapshots,
 * pre-copies and row counts (named with their process id) and the Backup API staging files in the
 * control roots of this data directory. Files of earlier builds without an owner go once they are a
 * day old.
 */
export async function sweepDataRootRelocationLeftovers(dataRootPath: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const now = Date.now();
  const abandoned = async (name: string, owned: RegExp, unowned: RegExp, file: string): Promise<boolean> => {
    const match = owned.exec(name);
    if (match) return Number(match[1]) !== process.pid && classifyRecordedProcess(Number(match[1]), undefined) === 'dead';
    if (!unowned.test(name)) return false;
    const info = await lstatOrUndefined(file);
    return !!info && now - info.mtimeMs > UNOWNED_LEFTOVER_AGE_MS;
  };
  const temporary = os.tmpdir();
  for (const name of await fs.readdir(temporary).catch(() => [] as string[])) {
    const file = path.join(temporary, name);
    if (await abandoned(name, OWNED_TEMPORARY_DIRECTORY, UNOWNED_TEMPORARY_DIRECTORY, file)) {
      await fs.rm(file, { recursive: true, force: true }).then(() => removed.push(file), () => undefined);
    }
  }
  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: dataRootPath }).catch(() => undefined);
  for (const candidate of inspection?.candidates ?? []) {
    const controlRoot = path.dirname(candidate.runtimeDataRootPath);
    for (const name of await fs.readdir(controlRoot).catch(() => [] as string[])) {
      const file = path.join(controlRoot, name);
      if (await abandoned(name, OWNED_STAGING_FILE, UNOWNED_STAGING_FILE, file)) {
        await fs.rm(file, { force: true }).then(() => removed.push(file), () => undefined);
      }
    }
  }
  return { removed };
}

// ---------------------------------------------------------------------------------------------
// Deleting the old directory

export interface OldDataRootDeletionItem {
  key: string;
  /** 'unmigrated': what a data set holds besides what moved (e.g. its diagnostic journal); only when ticked. */
  kind: 'data-set' | 'unmigrated' | 'configuration' | 'backup' | 'metadata';
  /** User-facing description. */
  label: string;
  paths: string[];
  bytes: number;
  /** Deleted only when the user ticks it (backups and archives). */
  optional: boolean;
  deletable: boolean;
  /** Why it stays (when not deletable). */
  reason?: string;
}

export interface OldDataRootDeletionPlan {
  oldRootPath: string;
  problems: string[];
  items: OldDataRootDeletionItem[];
  /** Top-level entries that stay in any case, each with the reason. */
  kept: Array<{ name: string; reason: string }>;
}

/**
 * What "delete the old directory" may remove: only what the current directory's completion record
 * proves was carried over from it and is unchanged since — data sets by content fingerprint,
 * configuration entries by tree digest — plus LimCode's bookkeeping once no data set is left.
 * Backups and archives are listed with their sizes and removed only when ticked. Everything else
 * (files of the user, data written after the move) stays, and so does the directory itself.
 */
export async function planOldDataRootDeletion(input: {
  oldRootPath: string;
  currentRootPath: string;
  /**
   * The relocation the data-root pointer names as the switch from the old directory (its
   * lastMigration.relocationId); a switch without copying has none and never justifies a deletion.
   */
  relocationId?: string;
  /** VS Code's own storage directory keeps the pointer file and is never removed itself. */
  keepEntries?: readonly string[];
}): Promise<OldDataRootDeletionPlan> {
  const oldRoot = path.resolve(input.oldRootPath);
  const currentRoot = path.resolve(input.currentRootPath);
  const problems: string[] = [];
  if (isSamePath(oldRoot, currentRoot)) problems.push('旧目录就是当前数据目录。');
  const marker = await readMarker(currentRoot);
  if (!input.relocationId) {
    problems.push('当前目录是切换过来的（回到旧目录、选择其它目录或使用默认目录），没有复制旧目录的数据，不能据此删除旧目录。');
  } else if (!marker || !isCompleted(marker) || !isSamePath(path.resolve(marker.sourceRootPath), oldRoot)) {
    problems.push('找不到从这个目录迁移完成的记录，为避免误删，不能在这里删除它。');
  } else if (marker.relocationId !== input.relocationId) {
    problems.push('当前目录里的迁移记录不是切换到这里的那次迁移留下的，为避免误删，不能在这里删除旧目录。');
  } else if (marker.invalidatedAt) {
    problems.push('迁移之后回到过这个旧目录，它可能有新的数据；迁移记录不再作为删除依据。需要时请再迁移一次（会合并），之后才能删除。');
  }
  if (problems.length > 0 || !marker || !isCompleted(marker)) return { oldRootPath: oldRoot, problems, items: [], kept: [] };
  const items: OldDataRootDeletionItem[] = [];
  const covered = new Set<string>();
  const cover = (absolute: string): void => { covered.add(path.relative(oldRoot, absolute).split(path.sep)[0]); };

  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: oldRoot });
  let everyDataSetGoes = inspection.problems.length === 0;
  for (const candidate of inspection.candidates) {
    const controlRoot = path.dirname(candidate.runtimeDataRootPath);
    const scopeRoot = candidate.runtimeScopeRootPath;
    for (const name of CONTROL_ROOT_BACKUP_DIRECTORIES) {
      const backup = path.join(controlRoot, name);
      if (!await pathExists(backup)) continue;
      items.push({
        key: `backup:${candidate.id}:${name}`, kind: 'backup', label: `历史库 ${candidate.id} 的${backupLabel(name)}`,
        paths: [backup], bytes: (await measureTree(backup)).bytes, optional: true, deletable: true
      });
    }
    const archives = path.join(scopeRoot, RESET_ARCHIVES_DIRECTORY);
    if (await pathExists(archives)) {
      items.push({
        key: `backup:${candidate.id}:${RESET_ARCHIVES_DIRECTORY}`, kind: 'backup',
        label: `历史库 ${candidate.id} 的“归档并重置”归档（含当时的对话）`,
        paths: [archives], bytes: (await measureTree(archives)).bytes, optional: true, deletable: true
      });
      cover(archives);
    }
    if (!candidate.dataSetId) continue;
    cover(controlRoot);
    const migrated = marker.migrated?.find((item) => item.id === candidate.id
      && item.dataSetId === candidate.dataSetId && item.rootInstanceId === candidate.rootInstanceId);
    // Where its debug captures went: the receiving data set for the current one, else its own (or the one it is merged into).
    const movedId = candidate.selected ? marker.receivingId : migrated?.mergedInto ?? candidate.id;
    const moved = migrated ? await resolveVscodeRuntimeDataSet({ globalStoragePath: currentRoot }, movedId).catch(() => undefined) : undefined;
    const { paths, unmigrated } = await splitDataSetEntries(controlRoot, candidate.runtimeDataRootPath, moved?.runtimeDataRootPath);
    let bytes = 0;
    for (const entry of paths) bytes += (await measureTree(entry)).bytes;
    let reason: string | undefined;
    if (!migrated) reason = '没有迁移到当前目录';
    else if (migrated.skippedConversations) {
      reason = `迁移时有 ${migrated.skippedConversations} 个对话你在新目录的当前库里删除过，没有并过去，只在这里还有，所以保留`;
    } else {
      const now = await dataSetFingerprint(candidate).catch(() => undefined);
      if (!now) reason = '无法读取，无法确认迁移之后没有改动';
      else if (!sameRuntimeDataSetFingerprint(migrated.fingerprint, now)) reason = '迁移之后这个历史库有新的改动';
    }
    if (reason) everyDataSetGoes = false;
    items.push({
      key: `data-set:${candidate.id}`, kind: 'data-set',
      label: `历史库 ${candidate.id}${candidate.selected ? '（旧目录的当前库）' : ''}${migrated?.mergedInto ? '（已合并进当前库）' : ''}`,
      paths, bytes, optional: false, deletable: !reason, ...(reason ? { reason } : {})
    });
    if (unmigrated.length > 0) {
      let unmigratedBytes = 0;
      for (const entry of unmigrated) unmigratedBytes += (await measureTree(entry)).bytes;
      const names = unmigrated.map((entry) => path.relative(controlRoot, entry).split(path.sep).join('/'));
      items.push({
        key: `unmigrated:${candidate.id}`, kind: 'unmigrated',
        label: `历史库 ${candidate.id} 里没有迁移的内容（${names.slice(0, 5).join('、')}${names.length > 5 ? ` 等 ${names.length} 项` : ''}）`,
        paths: unmigrated, bytes: unmigratedBytes, optional: true, deletable: !reason,
        ...(reason ? { reason: '这个历史库保留，它的其它内容也保留' } : {})
      });
    }
  }
  for (const problem of inspection.problems) {
    const relative = path.relative(oldRoot, problem.runtimeScopeRootPath).split(path.sep)[0];
    if (relative && relative !== '..') covered.add(relative);
    items.push({
      key: `data-set:${problem.id}`, kind: 'data-set', label: `历史库 ${problem.id}`, paths: [], bytes: 0,
      optional: false, deletable: false, reason: `无法读取，保留：${problem.message}`
    });
  }
  // Archives listed by directory: also those of a scope whose data set was deleted (no candidate names them).
  const listed = new Set(items.flatMap((item) => item.paths));
  const known = new Set([...inspection.candidates.map((candidate) => candidate.id), ...inspection.problems.map((problem) => problem.id)]);
  for (const directory of await listVscodeRuntimeArchiveDirectories(oldRoot).catch(() => [])) {
    if (listed.has(directory.path)) continue;
    cover(directory.path);
    items.push({
      key: `backup:${directory.scope}:${RESET_ARCHIVES_DIRECTORY}`, kind: 'backup',
      label: `历史库 ${directory.scope} 的“归档并重置”归档（含当时的对话${known.has(directory.scope) ? '' : '；这个历史库本身已经删除'}）`,
      paths: [directory.path], bytes: directory.unreadable ? 0 : (await measureTree(directory.path).catch(() => ({ bytes: 0 }))).bytes,
      optional: true, deletable: !directory.unreadable, ...(directory.unreadable ? { reason: `无法读取，保留：${directory.unreadable}` } : {})
    });
  }

  for (const copied of marker.configuration ?? []) {
    const entry = path.join(oldRoot, copied.entry);
    if (!await pathExists(entry)) continue;
    cover(entry);
    const unchanged = await treeDigest(entry).then((digest) => digest === copied.digest, () => false);
    items.push({
      key: `configuration:${copied.entry}`, kind: 'configuration', label: configurationLabel(copied.entry), paths: [entry],
      bytes: (await measureTree(entry)).bytes, optional: false, deletable: unchanged,
      ...(unchanged ? {} : { reason: '迁移之后有改动' })
    });
  }
  for (const name of [DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, DATA_ROOT_BACKUPS_DIR]) {
    const backup = path.join(oldRoot, name);
    if (!await pathExists(backup)) continue;
    cover(backup);
    items.push({
      key: `backup:${name}`, kind: 'backup',
      label: name === DATA_ROOT_BACKUPS_DIR ? '旧版本开发数据的重置备份' : '更早一次迁移时被替换的设置版本',
      paths: [backup], bytes: (await measureTree(backup)).bytes, optional: true, deletable: true
    });
  }
  const metadata: string[] = [];
  for (const name of METADATA_ENTRIES) {
    // The moved notice stays (a few hundred bytes): another installation still pointing here learns
    // where the data went, also after everything else is deleted.
    if (name === DATA_ROOT_MOVED_NOTICE_FILE) {
      covered.add(name);
      continue;
    }
    if (await pathExists(path.join(oldRoot, name))) metadata.push(path.join(oldRoot, name));
  }
  if (metadata.length > 0) {
    for (const entry of metadata) cover(entry);
    let bytes = 0;
    for (const entry of metadata) bytes += (await measureTree(entry)).bytes;
    items.push({
      key: 'metadata', kind: 'metadata', label: 'LimCode 的目录记录（当前库选择、合并记录、目录标识）', paths: metadata, bytes,
      optional: false, deletable: everyDataSetGoes, ...(everyDataSetGoes ? {} : { reason: '旧目录里还有保留的历史库，需要这些记录' })
    });
  }
  if (await pathExists(path.join(oldRoot, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY))) covered.add(VSCODE_WORKSPACE_RUNTIMES_DIRECTORY);
  if (await pathExists(path.join(oldRoot, VSCODE_RUNTIME_CONTROL_DIRECTORY))) covered.add(VSCODE_RUNTIME_CONTROL_DIRECTORY);

  const keep = input.keepEntries ?? [];
  const kept: OldDataRootDeletionPlan['kept'] = [];
  for (const name of (await fs.readdir(oldRoot).catch(() => [] as string[])).sort()) {
    if (covered.has(name) || isClaimName(name) || keep.some((entry) => name === entry || name.startsWith(`${entry}.`))) continue;
    kept.push({
      name,
      reason: CONFIGURATION_ENTRIES.includes(name) ? '不是本次迁移复制过去的内容（可能是你自己的文件），保留' : '不是 LimCode 迁移的数据，保留'
    });
  }
  return { oldRootPath: oldRoot, problems, items, kept };
}

/**
 * Deletes what the user confirmed: every deletable item that is not optional, and the optional ones
 * in `include`. The plan is computed again under the old directory's admission with every Host of
 * it offline; when it no longer matches what was confirmed, nothing is deleted.
 */
export async function deleteOldDataRoot(input: {
  oldRootPath: string;
  currentRootPath: string;
  relocationId?: string;
  keepEntries?: readonly string[];
  include?: readonly string[];
  /** Keys of the items the confirmation listed for deletion. */
  confirmedKeys: readonly string[];
}): Promise<{ removed: string[]; remainingDataSets: number; remainingArchives: number }> {
  const oldRoot = path.resolve(input.oldRootPath);
  return withRuntimeDataRootAdmission(oldRoot, async () => {
    await assertConfigurationRootRuntimesOffline(oldRoot);
    const plan = await planOldDataRootDeletion(input);
    if (plan.problems.length > 0) throw new DataRootRelocationError('data-root-old-delete-refused', plan.problems.join('\n'));
    const include = new Set(input.include ?? []);
    const selected = plan.items.filter((item) => item.deletable && (!item.optional || include.has(item.key)));
    const keys = selected.map((item) => item.key).sort();
    if (!isDeepStrictEqual(keys, [...input.confirmedKeys].sort())) {
      throw new DataRootRelocationError('data-root-old-delete-changed', '确认之后旧目录发生了变化，没有删除任何内容；请重新查看后再删除。');
    }
    const order: Array<OldDataRootDeletionItem['kind']> = ['data-set', 'unmigrated', 'backup', 'configuration', 'metadata'];
    for (const kind of order) {
      for (const item of selected.filter((entry) => entry.kind === kind)) {
        for (const entry of item.paths) await fs.rm(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    }
    await removeEmptyDirectories(oldRoot);
    const after = await inspectVscodeRuntimeDataSets({ globalStoragePath: oldRoot }).catch(() => undefined);
    const remainingDataSets = after ? after.candidates.filter((candidate) => candidate.dataSetId).length + after.problems.length : 0;
    // Archives kept in the old directory stay foreign history of the current one only while it is remembered.
    return { removed: keys, remainingDataSets, remainingArchives: await countResetArchives(oldRoot) };
  });
}

/**
 * Reset archives in every scope of a data directory, found by listing directories (an unreadable
 * archives directory counts once), and the `.deleting-` leftovers of an interrupted backup cleanup
 * there: those are settled only while the directory is remembered.
 */
async function countResetArchives(root: string): Promise<number> {
  const directories = await listVscodeRuntimeArchiveDirectories(root).catch(() => []);
  let count = 0;
  for (const directory of directories) {
    if (directory.unreadable) { count += 1; continue; }
    const names = await fs.readdir(directory.path).catch(() => undefined);
    count += names ? names.filter((name) => RESET_ARCHIVE_NAME.test(name.replace(/\.deleting-[0-9a-f]{16}$/, ''))).length : 1;
  }
  return count;
}

/** What moved with a data set (its database, CAS, debug captures the new directory has) or is only bookkeeping. */
const MOVED_DATA_ROOT_ENTRIES: ReadonlySet<string> = new Set([
  'limcode.sqlite', 'limcode.sqlite-wal', 'limcode.sqlite-shm', 'limcode.sqlite-journal', 'cas', 'runtime-kernel-epoch.json',
  'host-liveness', 'conversation-owners', 'exclusive-maintenance'
]);
const BOOKKEEPING_CONTROL_ROOT_ENTRIES: ReadonlySet<string> = new Set([
  ROOT_BINDING_POINTER_FILE, 'root-binding.pending.json', 'owner.json', 'kept-by-user.json',
  'cutover-completion.json', 'cutover-journal.json', 'cutover-request.json'
]);

/**
 * A data set's entries in its control root (backups aside, they are items of their own): `paths`
 * moved with it or are bookkeeping (deleted with the data set); `unmigrated` did not move and are
 * deleted only when ticked — anything unknown, a non-empty process spool, diagnostics other than
 * debug captures, debug captures the new directory does not have.
 */
async function splitDataSetEntries(controlRoot: string, dataRoot: string, movedDataRoot: string | undefined): Promise<{ paths: string[]; unmigrated: string[] }> {
  const paths: string[] = [];
  const unmigrated: string[] = [];
  const names = async (directory: string): Promise<string[]> => (await fs.readdir(directory).catch((error: unknown) => {
    if (isMissing(error)) return [] as string[];
    throw error;
  })).sort();
  for (const name of await names(controlRoot)) {
    const entry = path.join(controlRoot, name);
    if (CONTROL_ROOT_BACKUP_DIRECTORIES.includes(name)) continue;
    if (!isSamePath(entry, dataRoot)) {
      (BOOKKEEPING_CONTROL_ROOT_ENTRIES.has(name) || isClaimName(name) || isTransientName(name) ? paths : unmigrated).push(entry);
      continue;
    }
    for (const inner of await names(dataRoot)) {
      const item = path.join(dataRoot, inner);
      if (MOVED_DATA_ROOT_ENTRIES.has(inner) || isClaimName(inner) || isTransientName(inner)) paths.push(item);
      else if (inner === PROCESS_SPOOL_DIRECTORY && (await names(item)).length === 0) paths.push(item);
      else if (inner === DEBUG_CAPTURES_PATH[0]) {
        for (const diagnostic of await names(item)) {
          const detail = path.join(item, diagnostic);
          if (diagnostic !== DEBUG_CAPTURES_PATH[1]) {
            unmigrated.push(detail);
            continue;
          }
          for (const run of await names(detail)) {
            const there = movedDataRoot ? await pathExists(path.join(movedDataRoot, ...DEBUG_CAPTURES_PATH, run)) : false;
            (there ? paths : unmigrated).push(path.join(detail, run));
          }
        }
      } else unmigrated.push(item);
    }
  }
  return { paths, unmigrated };
}

/** Control roots, scope roots and the workspace-runtimes container left empty by a deletion. */
async function removeEmptyDirectories(oldRoot: string): Promise<void> {
  const scopes = path.join(oldRoot, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, 'scopes');
  // A deleted data set leaves the empty directories of its Runtime data root (unmigrated content, when kept, keeps them).
  const pruneDeleted = async (scopeRoot: string): Promise<void> => {
    const dataRoot = resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot });
    if (!await pathExists(path.join(dataRoot, 'limcode.sqlite'))) await pruneEmptyDirectories(dataRoot);
  };
  await pruneDeleted(oldRoot);
  for (const key of await fs.readdir(scopes).catch(() => [] as string[])) {
    const scope = path.join(scopes, key);
    await pruneDeleted(scope);
    await fs.rmdir(path.join(scope, VSCODE_RUNTIME_CONTROL_DIRECTORY)).catch(() => undefined);
    await fs.rmdir(scope).catch(() => undefined);
  }
  await fs.rmdir(scopes).catch(() => undefined);
  await fs.rmdir(path.join(oldRoot, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY)).catch(() => undefined);
  await fs.rmdir(path.join(oldRoot, VSCODE_RUNTIME_CONTROL_DIRECTORY)).catch(() => undefined);
}

/** Removes the empty directories of a tree, deepest first (never a file). */
async function pruneEmptyDirectories(directory: string): Promise<void> {
  if (!(await lstatOrUndefined(directory).catch(() => undefined))?.isDirectory()) return;
  for (const name of await fs.readdir(directory).catch(() => [] as string[])) await pruneEmptyDirectories(path.join(directory, name));
  await fs.rmdir(directory).catch(() => undefined);
}

function backupLabel(name: string): string {
  return name === RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY ? '合并前备份'
    : name === RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY ? '合并来源备份' : '升级前备份';
}

function configurationLabel(entry: string): string {
  if (entry === 'AGENTS.md' || entry === 'CLAUDE.md') return `全局规则 ${entry}`;
  if (entry === 'skills') return '全局技能 skills/';
  return `设置 ${entry}`;
}

// ---------------------------------------------------------------------------------------------
// Files

function isGlobalStatusName(name: string): boolean {
  return name === GLOBAL_STATUS_FILE || name.startsWith(`${GLOBAL_STATUS_FILE}.`);
}

function isClaimName(name: string): boolean {
  return name.endsWith('.runtime-maintenance') || name.includes('.runtime-maintenance.generation-')
    || name.endsWith('.runtime-admission') || name.includes('.runtime-admission.generation-');
}

/**
 * LimCode's own locks and atomic-write temporaries: the exact names, or a lock directory
 * (`<file>.lock`, its candidates and quarantined generations, each holding owner.json). A user file
 * that merely ends in .lock or .tmp (e.g. in a checkpoint worktree) is configuration like any other.
 */
async function isTransientEntry(directory: string, name: string): Promise<boolean> {
  if (isTransientName(name)) return true;
  if (!/\.lock(?:\.(?:candidate|generation)-.+)?$/.test(name)) return false;
  const info = await lstatOrUndefined(path.join(directory, name));
  return !!info?.isDirectory() && (await lstatOrUndefined(path.join(directory, name, 'owner.json')))?.isFile() === true;
}

function isTransientName(name: string): boolean {
  return name === `${INDEX_FILE}.lock` || name.startsWith(`${INDEX_FILE}.lock.generation-`)
    || /\.\d+\.\d+\.\d+\.tmp$/.test(name)
    || new RegExp(`\\.\\d+\\.${UUID_PATTERN}\\.tmp$`).test(name);
}

async function writableProblem(targetRootPath: string): Promise<string | undefined> {
  // The admission claim lives beside the target, so its parent must be writable as well.
  for (const directory of [path.dirname(targetRootPath), targetRootPath]) {
    const existing = await nearestExisting(directory);
    if (!existing) return '新数据目录所在的磁盘或位置不存在。';
    const info = await fs.stat(existing);
    if (!info.isDirectory()) return `新数据目录的上级位置不是文件夹：${existing}`;
    try { await fs.access(existing, constants.W_OK); }
    catch { return `没有权限写入：${existing}`; }
  }
  return undefined;
}

async function nearestExisting(target: string): Promise<string | undefined> {
  let current = path.resolve(target);
  for (;;) {
    if (await lstatOrUndefined(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function realPathOfNearestExisting(target: string): Promise<string> {
  const existing = await nearestExisting(target);
  if (!existing) return path.resolve(target);
  const real = await fs.realpath(existing).catch(() => existing);
  return path.join(real, path.relative(existing, path.resolve(target)));
}

async function walkSizes(root: string, visit: (file: string, info: Stats) => void): Promise<void> {
  const walk = async (entry: string): Promise<void> => {
    const info = await lstatOrUndefined(entry);
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile()) visit(entry, info);
    else if (info.isDirectory()) {
      for (const name of await fs.readdir(entry).catch(() => [] as string[])) await walk(path.join(entry, name));
    }
  };
  await walk(root);
}

async function measureTree(root: string): Promise<{ files: number; bytes: number; allocated: number }> {
  const result = { files: 0, bytes: 0, allocated: 0 };
  await walkSizes(root, (_file, info) => {
    result.files += 1;
    result.bytes += info.size;
    result.allocated += allocatedBytes(info);
  });
  return result;
}

function allocatedBytes(info: Stats): number {
  // POSIX reports 512-byte blocks; elsewhere round up to a common 4 KiB cluster.
  return typeof info.blocks === 'number' && info.blocks > 0 ? info.blocks * 512 : Math.ceil(info.size / 4096) * 4096;
}

async function lstatOrUndefined(target: string): Promise<Stats | undefined> {
  try { return await fs.lstat(target); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function pathExists(target: string): Promise<boolean> {
  return (await lstatOrUndefined(target)) !== undefined;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Copy, fsync, verify, rename into place; the caller syncs the directory. */
async function copyVerified(from: string, to: string, digest: string): Promise<void> {
  const temporary = `${to}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyDurably(from, temporary);
    if (await sha256File(temporary) !== digest) {
      throw new DataRootRelocationError('data-root-relocation-copy-mismatch', `复制后的文件与原文件不一致：${from}`);
    }
    await fs.rename(temporary, to);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function copyDurably(from: string, to: string): Promise<void> {
  await fs.copyFile(from, to, constants.COPYFILE_EXCL);
  const handle = await fs.open(to, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJsonDurably(file: string, value: unknown): Promise<void> {
  await writeTextDurably(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A file's text, or undefined when it does not exist (any other read error throws). */
async function readTextIfPresent(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeTextDurably(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await syncDirectoryDurably(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function removeSqliteFiles(file: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) await fs.rm(`${file}${suffix}`, { force: true });
}

function dataRootUnavailableMessage(root: string, reason: DataRootUnavailableReason, detail?: string): string {
  if (reason === 'relocating') {
    return `数据目录暂时不能打开：${root} 里有一次还没完成的数据迁移（可能来自另一个 LimCode 安装），${detail ?? '发起它的进程还在运行或无法确认已经结束。'}`
      + '它完成或撤销之后才能打开这个目录；本窗口没有打开运行时。';
  }
  if (reason === 'relocation-undoing') {
    return `数据目录暂时不能打开：${root} 里有一次没有成功的数据迁移，发起它的 LimCode 窗口正在撤销它在这里的改动（或撤销停下了、还没做完）。`
      + '撤销完成之后才能打开这个目录；本窗口没有打开运行时。';
  }
  if (reason === 'unpublished') {
    return `数据目录暂时没有打开：${root} 里有一次没有生效的数据迁移（多半来自另一个 LimCode 安装）：数据已经复制进来，`
      + '但发起它的安装没有切换过去，它的进程也已经结束。可以撤销那次迁移后打开（只撤销那次迁移写入的内容；这之后有人写入过就不撤销），也可以暂不打开。';
  }
  if (reason === 'moved-work') {
    return `数据目录暂时没有打开：${root} 的数据已迁移到别处，迁走时还有没完成的任务；在这里打开会把它们再执行一次。`
      + '要在这里继续，这些任务先按中止收尾（它们可能已在新目录执行过）；也可以改用新目录，或暂不打开。';
  }
  if (reason === 'moved-work-unsettled') {
    return `数据目录这次没有打开：${root} 里迁走的任务还没有全部收尾${detail ? `（${detail}）` : ''}。`
      + '全部收尾之前这里不执行任何工作，以免它们在这里再执行一次；可以重试，重试时会先接着收尾，也可以改用新目录。';
  }
  if (reason === 'moved-notice-invalid') {
    return `数据目录这次没有打开：${root} 里的“数据已迁走”标记（${DATA_ROOT_MOVED_NOTICE_FILE}）读不懂${detail ? `（${detail}）` : ''}，`
      + '无法确认迁走的任务在这里是否已经收尾，为免它们再执行一次，本窗口没有打开运行时。可以改用新目录，或确认后自行处理这个标记。';
  }
  if (reason === 'unreadable') {
    return `数据目录暂时无法读取：${root}；本窗口没有打开运行时。${detail ?? ''}`;
  }
  const what = reason === 'missing' ? '目录不存在'
    : reason === 'not-directory' ? '这个位置不是文件夹'
      : reason === 'empty' ? '目录里没有 LimCode 数据'
        : reason === 'mismatch' ? '目录里不是原来那份 LimCode 数据' : '目录无法访问（例如没有权限）';
  return `数据目录不可用（${what}）：${root}。可能是外置盘没有接上或网络盘断开；为避免在这里新建一份空的历史，本窗口没有打开运行时。`;
}

/** 'unreadable' for a read error that usually passes, 'inaccessible' for any other. */
export function dataRootReadFailureReason(error: unknown): 'unreadable' | 'inaccessible' {
  return readFailureReason(error);
}

function readFailureReason(error: unknown): 'unreadable' | 'inaccessible' {
  return TRANSIENT_READ_ERRORS.has(String((error as NodeJS.ErrnoException | undefined)?.code ?? '')) ? 'unreadable' : 'inaccessible';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Only these mean "not there"; any other error proves nothing either way. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The disk (or the user's quota) is full. */
function isDiskFull(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT' || /SQLITE_FULL|database or disk is full/i.test(errorMessage(error));
}

/** `<inode>:<size>:<mtime ns>` of a file, undefined when it is not there: a rename keeps it, any write changes it. */
async function fileStamp(file: string): Promise<string | undefined> {
  try {
    const info = await fs.lstat(file, { bigint: true });
    return info.isFile() ? `${info.ino}:${info.size}:${info.mtimeNs}` : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** `<device>:<inode>` of a directory, undefined when it is not one (or cannot be read). */
async function directoryIdentity(directory: string): Promise<string | undefined> {
  try {
    const info = await fs.stat(directory, { bigint: true });
    return info.isDirectory() ? `${info.dev}:${info.ino}` : undefined;
  } catch {
    return undefined;
  }
}

/** See DataRootRelocationTargetAnchor; `keptInPlace`: the target exists and is not renamed aside. */
async function targetAnchor(target: string, keptInPlace: boolean): Promise<DataRootRelocationTargetAnchor> {
  const parent = await directoryIdentity(path.dirname(target));
  if (!parent) throw new DataRootRelocationError('data-root-relocation-target-missing', `新数据目录的上级文件夹不在了：${path.dirname(target)}`);
  const self = keptInPlace ? await directoryIdentity(target) : undefined;
  return { parent, ...(self ? { target: self } : {}) };
}

/**
 * A relocation that changed the target (it has an anchor) and finds no record of it there: whether
 * the directories it found are still the ones there. Otherwise the target is not visible right now
 * (a disconnected drive leaves its mount point empty) and nothing may be taken for undone.
 */
async function assertTargetVisible(target: string, anchor: DataRootRelocationTargetAnchor | undefined): Promise<void> {
  if (!anchor) return;
  const parent = await directoryIdentity(path.dirname(target));
  const self = anchor.target === undefined ? undefined : await directoryIdentity(target);
  if (parent === anchor.parent && self === anchor.target) return;
  throw new DataRootRelocationError('data-root-relocation-target-invisible',
    `新数据目录现在看不到，或已不是迁移时的那个位置（${target}；例如所在的盘没有接上、网络盘断开或盘符变了）。`
    + '那次迁移在那里做的改动还没有撤销，进行中记录保留，接上后会再撤销；旧目录没有改动。');
}

export function isDataRootRelocationTargetInvisible(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'data-root-relocation-target-invisible';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
