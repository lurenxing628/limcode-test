import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { DATA_ROOT_BACKUPS_DIR } from '../capabilities/vscodeStorage/constants';
import {
  createRuntimeRootPaths, ROOT_BINDING_POINTER_FILE, ROOT_BINDING_PENDING_FILE, RUNTIME_CAS_DIRECTORY, RUNTIME_DATABASE_FILE,
  RUNTIME_EPOCH_FILE, type RuntimeRootPaths
} from './contracts';
import { PROCESS_SPOOL_DIRECTORY } from './processProtocol';
import { CUTOVER_BACKUPS_DIRECTORY, CUTOVER_JOURNAL_FILE, CUTOVER_REQUEST_FILE } from './physicalCutover';
import type { RepositoryGetRead } from './repositories';
import { parseHistoricalRootBinding, type HistoricalRootBinding } from './rootAuthority';
import type { RuntimeDatabase } from './runtimeDatabase';
import { comparable } from './runtimeDataSetBulkCopy';
import {
  readRuntimeBackupFacts, readRuntimeCopyFacts, readRuntimeDataSetFacts, RUNTIME_HISTORY_RECORD_DOMAINS, runtimeDataSetFileState,
  type RuntimeDataSetContentBodies, type RuntimeDataSetHistoryIds
} from './runtimeDataSetFacts';
import {
  BACKUP_NAME as MERGE_BACKUP_NAME, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY, RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY
} from './runtimeDataSetMerge';
import {
  isReadableRuntimeDataSetFingerprint, isRuntimeLargeMergeTargetBackupLive, readRuntimeDataSetMergeLedger,
  readRuntimeDataSetMergeRequests, readRuntimeLargeMergeTargetBackups, runtimeDataSetFingerprint
} from './runtimeDataSetMergeLedger';
import {
  MIGRATION_COMPLETION_KIND, RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, RETIRED_EPOCH_TO_5_JOURNAL_FILE, RETIRED_EPOCH_TO_6_JOURNAL_FILE, RETIRED_EPOCH_TO_7_JOURNAL_FILE, RETIRED_EPOCH_TO_8_JOURNAL_FILE, RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
  RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE
} from './runtimeEpochMigration';
import {
  copyForeignRuntimeSqliteFiles, discoverForeignRuntimeHistory, foreignRuntimeHistoryId, ForeignRuntimeHistoryRejection,
  heldDatabaseFiles, inspectForeignRuntimeRoot, listRenamedForeignRuntimeRoots, readForeignRuntimePointerIdentity,
  readLocatedRuntimeFile, tryWithForeignRuntimeRootClaim, type DiscoveredForeignRuntimeRoot, type ForeignRuntimeHistoryEntry,
  type HeldDatabaseFiles
} from './runtimeForeignHistory';
import { liveForeignRuntimeHistoryViews } from './runtimeForeignHistoryViews';
import {
  RUNTIME_HOST_LIVENESS_DIRECTORY, withRuntimeDataRootAdmission, withRuntimeMaintenance, withRuntimeMaintenanceActivity,
  type RuntimeMaintenanceActivity
} from './runtimeHostControl';
import { sameLocatedRuntimeRoot, type LocatedRuntimeRoot } from './runtimeLocatedRoot';
import { assertNoSymbolicPath, requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import {
  inspectVscodeRuntimeDataSets, resolveVscodeRuntimeMergeLedgerRoot, VSCODE_RUNTIME_ACTIVE_DIRECTORY, VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN,
  VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY,
  type VscodeRuntimeDataSetCandidate
} from './vscodeRootAuthority';

/**
 * 清理备份 (migration.json#backupCleanup). Deletes only copies whose readable history is proven to
 * exist completely in one local data set of the same configuration root (see coverageIn): every
 * Conversation and MessageRevision id of the copy, the ids of the other history rows a person sees
 * (RUNTIME_HISTORY_RECORD_DOMAINS: turns, tool calls and results, file changes, interactions and
 * answers, processes and their output, attachments, compressions, child executions, collaboration
 * messages), every body as a regular file of its size in that data set's CAS, and what is visible:
 * every message the copy shows is shown there with the same current revision. Conversations are
 * hard-deleted (with everything of theirs); a copy holding one the local data set no longer has is
 * kept as history. A message deleted, edited or retried there is only soft-deleted or replaced: its
 * rows stay, but nothing shows it any more, so a copy that still shows it is deletable only when the
 * user ticks it knowingly (replacedMessages; never ticked by default).
 *
 * Three kinds of backups can be deleted: upgrade backups (epoch-migration-backups/), pre-merge
 * backups of the target (merge-backups/) and source backups before finalization
 * (merge-source-backups/), each holding only what its kind writes; and foreign history (see
 * "Foreign history" below): verified archives of 归档并重置 and data sets in directories copied
 * aside by a data-root relocation. A copied directory as a whole (its settings, rules and skills),
 * the old-format backups/ of a control root and .limcode-data-backups are only listed. Planning reads
 * the copies without claims (settling leftovers and copying another data set take theirs; the window
 * runs it as a write command, like the deletion); deletion re-verifies under configuration admission
 * and the control root's maintenance (publishing 清理备份 to waiting windows), compares the directory
 * once more as the last step before renaming it to `<name>.deleting-<id>`, checks the coverage and the
 * directory once more (deleting a Conversation or a message takes no claim) and only then marks it
 * verified (for this configuration root) and removes it. A leftover of a crash is removed by the next
 * cleanup when this installation verified it (from this configuration root, or from a data directory
 * it left: never given its name back half removed); otherwise it gets its name back and is checked
 * again. Symbolic links are never followed. A pre-merge backup a large-merge preparation registered
 * (preparing-backups/) stays while registered and unused, and never anchors the newest one kept.
 *
 * POSIX lock rule: the current data set is read only through its own worker reader (`snapshot`);
 * its files are never opened or closed by this process, and neither is any copy or other data set
 * whose database or WAL is the same inode (a hard link) as a local data set's database files (dev:ino
 * compared by stat before anything is copied). Other data sets and the copies are read in the facts
 * worker from private copies (runtimeDataSetFacts), straight from the tables. CAS files are only lstat'ed.
 *
 * Foreign history (runtimeForeignHistory): only roots that pass its verification, each deleted as
 * its located control root (a whole archive; in a copied directory only the data set, never the
 * directory with its settings, rules and skills). One is proven when a local data set other than the
 * open one has its identity and exactly its content digest, with every body in its CAS (the open one
 * has no safe digest: its files are not copied), or when its history and that of every backup its
 * control root keeps is covered by one local data set of this configuration root. Anything else in
 * it (old-format backups/, debug captures, output of a process, an unknown entry or type, unfinished
 * tasks when proven by coverage) keeps it whole. Its claim (.limcode-runtime-merges/foreign-claims/<id>)
 * is taken without waiting, and a read-only view that is open on it (runtimeForeignHistoryViews)
 * counts as holding it: busy, it is kept. Inside the claim it is located and verified again; the
 * configuration admission is held until its verified mark is durable, and the removal of its content
 * store follows under the claim alone. The only writes in a foreign directory are the rename, the
 * verified mark and the removal of the deleted root itself; SQLite files of it are copied only
 * through the foreign copy (dev:ino checks, state before and after). Two installations sharing a
 * previous data directory do not exclude each other (their claims live in their own configuration
 * roots): a known limitation.
 */

/** An upgrade backup can be deleted only this long after its upgrade completed. */
export const RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A pre-merge backup younger than this may belong to a merge batch still running in another window,
 * which removes it again when no transaction used it; it neither can be deleted nor count as the
 * newest backup that is kept.
 */
export const RUNTIME_BACKUP_CLEANUP_MERGE_BACKUP_MIN_AGE_MS = 60 * 60 * 1000;
/** Ids per read of the current data set's worker reader. */
export const RUNTIME_BACKUP_CLEANUP_READ_BATCH = 250;

export type RuntimeBackupKind =
  | 'epoch-migration' | 'merge-target' | 'merge-source' | 'foreign-history'
  | 'reset-archive' | 'copied-data-root' | 'legacy-cutover' | 'data-backups';

/** Kinds whose copies can be proven and deleted; every other kind is listed only. */
export const RUNTIME_BACKUP_DELETABLE_KINDS: readonly RuntimeBackupKind[] = Object.freeze(['epoch-migration', 'merge-target', 'merge-source', 'foreign-history']);

export interface RuntimeBackupCleanupItem {
  /** Stable for one plan: kind and path relative to the configuration root (or its parent). */
  key: string;
  kind: RuntimeBackupKind;
  name: string;
  path: string;
  /** The data set whose control root holds the copy (the three backup kinds). */
  dataSetCandidateId?: string;
  /** That data set as the history management names it (当前库, its project names, 旧工作区历史 or 默认历史库). */
  dataSetName?: string;
  /** Foreign history: where it comes from, in words (归档, 拷来目录里的库, …). */
  origin?: string;
  /** That data set is the one open in this window (never set for the kinds that are only listed). */
  inCurrentDataSet: boolean;
  /** Logical bytes of every regular file (decimal text). */
  bytes: string;
  /** Without files that have other hard links: deleting those frees nothing. */
  reclaimableBytes: string;
  fileCount: number;
  createdAt?: string;
  deletable: boolean;
  /** Deletable: what proves it; otherwise why it is kept. Never a raw error text. */
  reason: string;
  /** The technical cause behind a reason (for the log), when there is one. */
  detail?: string;
  conversations?: number;
  /** Message versions (MessageRevision rows): an edited message has several. */
  revisions?: number;
  missingConversations?: number;
  missingRevisions?: number;
  /**
   * Deletable, but messages visible in the copy are deleted or replaced (edited, retried) in the data
   * set that holds the rest: deleting it makes them unreadable. Only deleted when ticked explicitly
   * (never ticked by default).
   */
  replacedMessages?: number;
}

export interface RuntimeBackupCleanupPlan {
  configurationRootPath: string;
  checkedAt: string;
  items: RuntimeBackupCleanupItem[];
  /** Verified `.deleting-*` leftovers of an interrupted cleanup, removed before listing. */
  finishedDeletions: string[];
  /** Leftovers interrupted before their last check: back under their own names, checked again. */
  restoredDeletions: string[];
  /** What could not be listed or settled, in words. */
  problems: string[];
  /** The technical causes behind the problems (for the log). */
  details: string[];
  /** The data directories this installation left, looked in for foreign history (see ForeignRuntimeHistoryInput). */
  previousDataRootPaths?: readonly string[];
}

export interface RuntimeBackupCleanupResult {
  deleted: Array<{ key: string; name: string; path: string; bytes: string; reclaimableBytes: string }>;
  kept: Array<{ key: string; name: string; path: string; reason: string; detail?: string }>;
  /** Verified and renamed for deletion, but not removed completely; the next cleanup finishes them. */
  unfinished: Array<{ key: string; name: string; path: string; reason: string; detail?: string }>;
  /** Copied data directories that hold no data set any more after this deletion; the rest of them stays. */
  copiedDirectoriesWithoutDataSets: Array<{ name: string; path: string }>;
}

/** The data set open in this window: its binding and its worker reader. */
export type RuntimeBackupCleanupCurrent = Pick<RuntimeDatabase, 'binding' | 'snapshot'>;

/**
 * before-rename, after-rename and after-verify (the mark is durable) hold every claim of the deletion;
 * before-removal comes after the mark of a foreign root, when only its foreign claim is still held.
 */
export type RuntimeBackupCleanupFaultPoint = 'before-rename' | 'after-rename' | 'after-verify' | 'before-removal';

/** A point of the check (tests): after-local-digest follows reading a local data set's content digest. */
export type RuntimeBackupCleanupPlanningPoint = 'after-local-digest';

export interface RuntimeBackupCleanupOptions {
  onProgress?(message: string): void;
  /** The clock of the age rules (tests). */
  now?(): number;
  /** The data directories this installation left (see ForeignRuntimeHistoryInput): their archives and the directories copied aside beside them are foreign history too. */
  previousDataRootPaths?: readonly string[];
  /** Tests: called at a point of the check, with the local data set concerned. */
  onPlanningPoint?(point: RuntimeBackupCleanupPlanningPoint, candidateId: string): Promise<void> | void;
}

export interface RuntimeBackupDeletionOptions extends RuntimeBackupCleanupOptions {
  onFaultPoint?(point: RuntimeBackupCleanupFaultPoint, key: string): Promise<void> | void;
}

type StoragePaths = { globalStoragePath: string };

const RESET_ARCHIVES_DIRECTORY = '.limcode-runtime-backups';
const COPIED_ASIDE_MARKER = '.limcode-copied-';
const DELETING_MARKER = '.deleting-';
const DELETING_NAME = /^(.+)\.deleting-[0-9a-f]{16}$/;
/** Written into a renamed copy once its coverage was checked again after the rename. */
const VERIFIED_MARKER_FILE = '.limcode-backup-cleanup-verified';
const VERIFIED_MARKER_KIND = 'limcode-backup-cleanup-verified';
const EPOCH_BACKUP_NAME = /^[0-9TZ-]+-[a-f0-9]{8}$/;
const COVERAGE_DIRECTORY = 'coverage';
const COVERAGE_KIND = 'limcode-runtime-backup-coverage-history-3';
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const FINALIZATIONS_DIRECTORY = 'finalizations';
const CURRENT_LABEL = '当前库';
/** Whose database files a hard link is, when it is not the open data set's (never named by its id, which no one sees). */
const OTHER_DATA_SET_LABEL = '另一个历史库';
/** Files whose presence in a control root means an operation on it has not finished, and what it is. */
const IN_PROGRESS_FILES: ReadonlyArray<readonly [file: string, operation: string]> = Object.freeze([
  [ROOT_BINDING_PENDING_FILE, '未完成的历史库切换'],
  [RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE, '未完成的升级'],
  [RETIRED_EPOCH_TO_5_JOURNAL_FILE, '未完成的升级'],
  [RETIRED_EPOCH_TO_6_JOURNAL_FILE, '未完成的升级'],
  [RETIRED_EPOCH_TO_7_JOURNAL_FILE, '未完成的升级'],
  [RETIRED_EPOCH_TO_8_JOURNAL_FILE, '未完成的升级'],
  [RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, '旧版本未完成的 3→4 升级'],
  [CUTOVER_REQUEST_FILE, '未完成的旧格式数据切换'],
  [CUTOVER_JOURNAL_FILE, '未完成的旧格式数据切换']
] as const);
const DELETABLE_DIRECTORIES: Readonly<Record<'epoch-migration' | 'merge-target' | 'merge-source', string>> = Object.freeze({
  'epoch-migration': RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
  'merge-target': RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY,
  'merge-source': RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY
});
type DeletableKind = keyof typeof DELETABLE_DIRECTORIES;
const ACTIVITY = { operation: 'backup-cleanup', description: '清理备份' } as const;
/** The backup directories of a control root, in the order they are listed. */
const LOCAL_BACKUP_KINDS: readonly DeletableKind[] = Object.freeze(['epoch-migration', 'merge-target', 'merge-source']);
const BACKUP_LABELS: Readonly<Record<DeletableKind, string>> = Object.freeze({
  'epoch-migration': '升级前备份', 'merge-target': '合并前备份', 'merge-source': '合并来源的收尾前备份'
});
const ARCHIVE_NAME = new RegExp(`^${VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN}$`);
const FOREIGN_KEY_PREFIX = 'foreign-history:';
const COPIED_REST = '其余内容（设置、规则、技能）保留，可自行处理';
const FOREIGN_BUSY = '正在被另一个窗口或操作使用（只读查看、核验、合并或清理备份）';
/** This configuration root's identity for verified marks (a random token, created with the first mark). */
const CLEANUP_IDENTITY_FILE = 'backup-cleanup-identity.json';
const CLEANUP_IDENTITY_KIND = 'limcode-backup-cleanup-identity';
/** What the history rows of RUNTIME_HISTORY_RECORD_DOMAINS are called in a reason. */
const RECORD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  Turn: '轮次', TurnTermination: '轮次结束记录', ToolCall: '工具调用', ToolOutcome: '工具结果',
  ToolModelResult: '交给模型的工具结果', ToolResultArtifact: '工具产物', FileChangeSet: '文件修改', FileChangeSetMember: '文件修改明细',
  FileChangeDecision: '文件修改的确认', InteractionRequest: '交互请求', InteractionResponse: '你的回答', Process: '进程',
  ProcessOutputChunk: '进程输出', Attachment: '附件', AttachmentLink: '附件关联', CompressionBlock: '上下文压缩',
  ChildExecution: '子任务', CollaborationMessage: '协作消息'
});
/**
 * What a backup directory of each kind holds (L2): the database with its sidecars (read with it)
 * and LimCode's records; `.tmp` files mean it is still being written; anything else keeps it.
 */
const BACKUP_DATABASE_SIDECARS: readonly string[] = ['', '-wal', '-shm', '-journal'];
const MERGE_BACKUP_FILES: ReadonlySet<string> = new Set([
  ROOT_BINDING_POINTER_FILE, ...BACKUP_DATABASE_SIDECARS.map((suffix) => `${RUNTIME_DATABASE_FILE}${suffix}`)
]);
/** The diagnostic journal (diagnosticJournal: events.jsonl and its rotated files, deleted by it after 7 days). */
const DIAGNOSTIC_JOURNAL_FILE = /^events(?:\.[1-3])?\.jsonl$/;
/** A claim directory of runtimeHostControl (maintenance or admission, a candidate or a quarantined generation). */
const CLAIM_NAME = /^.+\.runtime-(?:maintenance|admission)(?:\.candidate-[0-9a-f-]{36}|\.generation-[A-Za-z0-9._-]+)?$/;
const CLAIM_FILE = /^(?:owner\.json|activity\.json|activity\.json\.[0-9a-f-]{36}\.tmp)$/;
/** A foreign root's own small records read here (completion records, saved bindings). */
const MAX_FOREIGN_RECORD_BYTES = 4 * 1024 * 1024;
/** Files LimCode keeps in a control root beside the pointer (bookkeeping deleted with the data set). */
const FOREIGN_CONTROL_ROOT_FILES: ReadonlySet<string> = new Set([
  ROOT_BINDING_POINTER_FILE, 'owner.json', 'kept-by-user.json', 'cutover-completion.json'
]);
/**
 * The data set itself and LimCode's own runtime files in its data root, each of its own type:
 * database files and the epoch manifest; content, Host liveness, conversation owners
 * (ConversationRuntimeOwnerManager), exclusive maintenance requests (runtimeExclusiveMaintenance) and
 * diagnostics (only the diagnostic journal; debug captures a person made keep it whole). An empty
 * process spool too.
 */
const FOREIGN_DATA_ROOT_FILES: ReadonlySet<string> = new Set([
  ...BACKUP_DATABASE_SIDECARS.map((suffix) => `${RUNTIME_DATABASE_FILE}${suffix}`), RUNTIME_EPOCH_FILE
]);
const FOREIGN_DATA_ROOT_DIRECTORIES: ReadonlySet<string> = new Set([
  RUNTIME_CAS_DIRECTORY, RUNTIME_HOST_LIVENESS_DIRECTORY, 'conversation-owners', 'exclusive-maintenance'
]);
const DIAGNOSTICS_DIRECTORY = 'diagnostics';
const DEBUG_CAPTURES_DIRECTORY = 'debug-captures';

interface TreeFacts {
  /** Every entry's name, type and exact file state: any change of the copy changes it. */
  digest: string;
  bytes: bigint;
  reclaimableBytes: bigint;
  fileCount: number;
  symbolicLink: boolean;
  unsupported: boolean;
  /** Last modification of the directory itself (an entry added, renamed or removed). */
  modifiedAt: number;
  /**
   * What sameShallowTree compares without reading every content object again: every directory by
   * its identity and the names in it, every other entry outside `objects` by its exact state,
   * relative to the root ('' is the root itself).
   */
  shallow: ReadonlyArray<readonly [relative: string, state: string]>;
}

/** What a local data set other than the open one holds, read from a private copy for exactly these files. */
interface LocalFacts {
  files: string;
  conversations: ReadonlySet<string>;
  messageRevisions: ReadonlySet<string>;
  records: ReadonlyMap<string, ReadonlySet<string>>;
  /** Visible message → its current revision. */
  visible: ReadonlyMap<string, string>;
  /** Content object → [storage key, byte length]. */
  contents: ReadonlyMap<string, readonly [string, string]>;
  projectNames: readonly string[];
}

/**
 * What a deletion checks again in the open data set (see recheckInCurrent): the copy's Conversations
 * and what it shows. Nothing else of its ids is kept once it is listed (other rows are deleted only
 * with their Conversation, bodies never; another data set is checked by its file state).
 */
type RecheckIds = Pick<RuntimeDataSetHistoryIds, 'conversations' | 'visibleMessages'>;

interface LocalDataSet {
  candidate: VscodeRuntimeDataSetCandidate;
  binding: HistoricalRootBinding;
  current: boolean;
  facts?: LocalFacts;
  /** Its content digest for exactly these files (runtimeDataSetFingerprint); never for the open one. */
  digest?: { files: string; digest: string };
}

/** How much of a copy's history one local data set holds (see coverageIn). */
interface Coverage {
  missingConversations: number;
  missingRevisions: number;
  /** Other history rows it lacks, by domain (in RUNTIME_HISTORY_RECORD_DOMAINS order). */
  missingRecords: Array<[domain: string, count: number]>;
  /** Bodies it lacks: no such content object, or no regular file of that size at its storage key. */
  missingContents: number;
  /** Messages visible in the copy that are deleted there, or show another current revision (edited, retried). */
  replaced: string[];
}

interface ControlRoot {
  scopeRootPath: string;
  controlRootPath: string;
  paths: RuntimeRootPaths;
  candidateId?: string;
  local?: LocalDataSet;
  /** Why nothing here can be proven (no readable local data set, a hard link of the current one, …). */
  unavailable?: string;
  unavailableDetail?: string;
  /** Unfinished operations in this control root (their files), in words. */
  inProgress: string[];
}

/**
 * dev:ino of the database, WAL and shared memory of the current data set and of every local data set,
 * and whose files they are ('当前库' or '另一个历史库'). Taken with stat only: no descriptor is opened.
 */
type DatabaseFiles = ReadonlyMap<string, string>;

interface ControlRoots {
  roots: ControlRoot[];
  databaseFiles: DatabaseFiles;
}

/** A reason already in words for the user (anything else thrown is described, never shown raw). */
class CleanupRefusal extends Error {}

interface LedgerFacts {
  /** Data sets (dataSetId:rootInstanceId) with a merge transaction in flight, as source or target. */
  committing: ReadonlySet<string>;
  /** The merge records could not be read: a merge in flight cannot be ruled out. */
  recordsUnreadable: boolean;
  finalizationBackups: ReadonlySet<string>;
  finalizationsUnreadable: boolean;
  /**
   * Target backups of a large-merge preparation (preparing-backups/, RuntimeLargeMergeTargetBackup)
   * that a preparation or its session may still use (the registration is live) or that no session
   * used yet (the merge removes those itself): by directory and by name. Neither deleted nor an anchor.
   */
  preparingBackups: { paths: ReadonlySet<string>; names: ReadonlySet<string>; live: ReadonlySet<string> };
  preparingUnreadable: boolean;
}

/** Everything a deletion re-verifies; kept in this process only, never shown or serialized. */
interface BackupProof {
  item: RuntimeBackupCleanupItem;
  kind: DeletableKind;
  controlRootPath: string;
  candidateId: string;
  /** The directory as listed: compared in full when verified again, and shallowly right before and after the rename. */
  tree: TreeFacts;
  binding: HistoricalRootBinding;
  current: boolean;
  /** Proven by the open data set: what is read again there. */
  recheck?: RecheckIds;
  /** Proven by another data set: its files as they were read. */
  localFiles?: string;
  /** Visible messages of the copy already deleted or replaced there when it was listed (ticked knowingly). */
  replaced: ReadonlySet<string>;
}

interface Evaluation {
  item: RuntimeBackupCleanupItem;
  proof?: BackupProof;
}

type RemovalOutcome =
  | { state: 'deleted' }
  | { state: 'kept'; reason: string; detail?: string }
  | { state: 'unfinished'; reason: string; detail?: string };

/** Everything a deletion of a foreign root re-verifies; kept in this process only. */
interface ForeignProof {
  item: RuntimeBackupCleanupItem;
  found: DiscoveredForeignRuntimeRoot;
  root: LocatedRuntimeRoot;
  /** The located control root: the directory that is deleted. */
  unit: string;
  tree: TreeFacts;
  method: 'identical' | 'coverage';
  contentDigest?: string;
  /** The local data set it is proven against (with its name), and its files as they were read (not the open one's). */
  by: { candidateId: string; binding: HistoricalRootBinding; current: boolean; name: string; files?: string };
  /** Proven by the open data set: what is read again there (its own and those of the backups it keeps). */
  recheck?: RecheckIds;
  /** Visible messages already deleted or replaced in that data set when it was listed (ticked knowingly). */
  replaced: ReadonlySet<string>;
  /** A data set of a copied directory: that directory (told when no data set is left in it). */
  copiedDirectory?: string;
}

/** A refusal of the whole check or deletion, already in words for the user (anything else is described by the caller, see its log). */
export class RuntimeBackupCleanupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RuntimeBackupCleanupError';
  }
}

/** Local time to the minute, as every time of 清理备份 and the foreign history list is shown. */
export function formatLocalTime(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const PROOFS = new WeakMap<RuntimeBackupCleanupPlan, ReadonlyMap<string, BackupProof>>();
const FOREIGN_PROOFS = new WeakMap<RuntimeBackupCleanupPlan, ReadonlyMap<string, ForeignProof>>();

/**
 * Lists every backup of the configuration root with its size and conclusion. Nothing is deleted
 * except `.deleting-*` leftovers verified by an earlier, already confirmed deletion.
 */
export async function planRuntimeBackupCleanup(
  configurationRootPathInput: string,
  current: RuntimeBackupCleanupCurrent,
  options: RuntimeBackupCleanupOptions = {}
): Promise<RuntimeBackupCleanupPlan> {
  const configurationRootPath = path.resolve(configurationRootPathInput);
  const previousDataRootPaths = options.previousDataRootPaths?.length ? [...options.previousDataRootPaths] : undefined;
  const now = options.now ?? Date.now;
  const report = options.onProgress ?? (() => undefined);
  const problems: string[] = [];
  const details: string[] = [];
  const problem = (text: string, error?: unknown) => {
    problems.push(text);
    if (error !== undefined) details.push(`${text} ${errorMessage(error)}`);
  };
  report('正在列出历史库…');
  let { roots, databaseFiles } = await listControlRoots(configurationRootPath, current, problem);
  report('正在收尾上次没有删完的备份…');
  let leftovers: { finished: string[]; restored: string[] } = { finished: [], restored: [] };
  try {
    leftovers = await settleInterruptedDeletions(configurationRootPath, roots, problem, { previousDataRootPaths, databaseFiles });
  } catch (error) {
    // Only what is left of an earlier cleanup: the next check tries again; this one goes on.
    problem('上次没有删完的备份这次没有收尾，下次检查时再试。', error);
  }
  if (leftovers.restored.length > 0) ({ roots, databaseFiles } = await listControlRoots(configurationRootPath, current, () => undefined));
  const ledger = await readLedgerFacts(configurationRootPath);
  const items: RuntimeBackupCleanupItem[] = [];
  const proofs = new Map<string, BackupProof>();
  const foreignProofs = new Map<string, ForeignProof>();
  const cache = new CoverageCache(configurationRootPath);
  const bodies: BodyCheck = new Map();
  report('正在列出外来历史库…');
  let found: DiscoveredForeignRuntimeRoot[] = [];
  try {
    found = await discoverForeignRuntimeHistory({ configurationRootPath, ...(previousDataRootPaths ? { previousDataRootPaths } : {}) });
  } catch (error) {
    problem('外来历史库（归档、拷来目录里的库）没有全部列出，没有列出的都保留。', error);
  }
  // Listed as foreign history (each with its own conclusion), never again as a listed-only entry.
  const handled = new Set(found.map((entry) => comparable(foreignListedPath(entry.location))));
  const copiedDirectories = new Set(found.filter((entry) => entry.location.kind === 'copied').map((entry) => comparable(entry.location.containerPath)));
  for (const root of roots) {
    try {
      let named = false;
      for (const kind of LOCAL_BACKUP_KINDS) {
        for (const entry of await listBackupEntries(configurationRootPath, root, kind)) {
          // Every item of this control root names its data set the same way.
          if (!named) {
            named = true;
            await nameLocal(root.local, cache, databaseFiles);
          }
          report(`正在核对 ${entry.name}…`);
          const evaluation = await evaluateBackup({
            configurationRootPath, root, kind, entry, ledger, current, cache, databaseFiles, bodies, now: now()
          });
          items.push(evaluation.item);
          if (evaluation.proof) proofs.set(evaluation.item.key, evaluation.proof);
        }
      }
      report('正在统计只列出的备份…');
      items.push(...await listKeptBackups(configurationRootPath, root, handled));
    } catch (error) {
      problem(`${root.controlRootPath} 里的备份没有全部列出。`, error);
    }
  }
  try {
    items.push(...await planForeignHistory({
      configurationRootPath, current, roots, databaseFiles, cache, bodies, now: now(), report,
      ...(options.onPlanningPoint ? { onPlanningPoint: options.onPlanningPoint } : {})
    }, found, foreignProofs));
  } catch (error) {
    problem('外来历史库（归档、拷来目录里的库）没有全部核对，没有核对的都保留。', error);
  }
  try {
    items.push(...await listConfigurationLevelBackups(configurationRootPath, copiedDirectories));
  } catch (error) {
    problem('数据目录里和旁边的旧备份没有全部列出。', error);
  }
  await cache.prune();
  const plan: RuntimeBackupCleanupPlan = {
    configurationRootPath, checkedAt: new Date(now()).toISOString(), items,
    finishedDeletions: leftovers.finished, restoredDeletions: leftovers.restored, problems, details,
    ...(previousDataRootPaths ? { previousDataRootPaths } : {})
  };
  PROOFS.set(plan, proofs);
  FOREIGN_PROOFS.set(plan, foreignProofs);
  return plan;
}

/**
 * Deletes the confirmed copies of a plan of this process. Each one is verified again under the
 * configuration admission and its control root's maintenance (published as 清理备份 to waiting
 * windows): the copy is exactly as listed and is not a hard link of a local database, the local
 * data set has the same identity and generation, no operation is in progress, the newest pre-merge
 * backup stays, and its history is still covered (nothing visible replaced beyond what was ticked);
 * right before the rename its directory is compared once more (the same directory, not a link put in
 * its place, with the same entries). After the rename the coverage and the directory are checked once
 * more; a copy that fails either gets its name back. Anything else keeps the copy. A foreign root is
 * verified and marked under the admission and its own foreign claim, taken without waiting (see
 * markForeignRoot), and removed after the admission is released, under the claim alone.
 */
export async function deleteRuntimeBackups(
  plan: RuntimeBackupCleanupPlan,
  current: RuntimeBackupCleanupCurrent,
  keys: readonly string[],
  options: RuntimeBackupDeletionOptions = {}
): Promise<RuntimeBackupCleanupResult> {
  const proofs = PROOFS.get(plan);
  const foreignProofs = FOREIGN_PROOFS.get(plan);
  if (!proofs || !foreignProofs) throw new RuntimeBackupCleanupError('这份备份清单不是本窗口刚才核对的结果，请重新检查。');
  const configurationRootPath = plan.configurationRootPath;
  const now = options.now ?? Date.now;
  const result: RuntimeBackupCleanupResult = { deleted: [], kept: [], unfinished: [], copiedDirectoriesWithoutDataSets: [] };
  const selected: BackupProof[] = [];
  const selectedForeign: ForeignProof[] = [];
  for (const key of new Set(keys)) {
    const proof = proofs.get(key);
    const foreign = foreignProofs.get(key);
    const item = plan.items.find((entry) => entry.key === key);
    if ((!proof && !foreign) || !item?.deletable) {
      if (item) result.kept.push({ key, name: item.name, path: item.path, reason: '不在可以删除的清单里' });
      continue;
    }
    if (proof) selected.push(proof);
    else selectedForeign.push(foreign!);
  }
  if (selected.length + selectedForeign.length === 0) return result;
  const byRoot = new Map<string, BackupProof[]>();
  for (const proof of selected) {
    const group = byRoot.get(comparable(proof.controlRootPath)) ?? [];
    group.push(proof);
    byRoot.set(comparable(proof.controlRootPath), group);
  }
  const total = selected.length + selectedForeign.length;
  let started = 0;
  const stage = () => `正在删除第 ${Math.max(started, 1)}/${total} 份备份`;
  if (selected.length > 0) {
    // Published in the admission as well as in each maintenance claim: a window waiting to open sees
    // why (清理备份) for as long as the deletion holds either.
    await withRuntimeDataRootAdmission(configurationRootPath, () => withRuntimeMaintenanceActivity({
      ...ACTIVITY, stage: stage()
    }, async (admission) => {
      const cache = new CoverageCache(configurationRootPath);
      for (const group of byRoot.values()) {
        const controlRootPath = group[0].controlRootPath;
        const paths = createRuntimeRootPaths(path.join(controlRootPath, VSCODE_RUNTIME_ACTIVE_DIRECTORY));
        await withRuntimeMaintenance(paths, () => withRuntimeMaintenanceActivity({ ...ACTIVITY, stage: stage() }, async (activity) => {
          const { roots, databaseFiles } = await listControlRoots(configurationRootPath, current, () => undefined);
          const root = roots.find((entry) => comparable(entry.controlRootPath) === comparable(controlRootPath));
          const ledger = await readLedgerFacts(configurationRootPath);
          for (const proof of group) {
            started += 1;
            activity.report(stage());
            const keep = (reason: string, detail?: string) => result.kept.push({
              key: proof.item.key, name: proof.item.name, path: proof.item.path, reason, ...(detail ? { detail } : {})
            });
            if (!root) { keep('所在历史库已不在原处，这一项没有删除'); continue; }
            const entry = await backupEntry(configurationRootPath, root, proof.kind, proof.item.name);
            if (!entry) { keep('已经不在原处（可能已被其它操作删除）'); continue; }
            const evaluation = await evaluateBackup({
              configurationRootPath, root, kind: proof.kind, entry, ledger, current, cache, databaseFiles, bodies: new Map(), now: now(), known: proof
            });
            if (!evaluation.proof) { keep(`${evaluation.item.reason}；这一项没有删除`, evaluation.item.detail); continue; }
            try {
              await options.onFaultPoint?.('before-rename', proof.item.key);
            } catch (error) {
              keep('没有删除', errorMessage(error));
              continue;
            }
            // The last step before the rename (its coverage was read again meanwhile): the same directory
            // (not a link put in its place), with the same entries in the same state.
            if (!await sameShallowTree(entry.path, proof.tree)) { keep('列出之后这份备份有变化，请重新检查；这一项没有删除'); continue; }
            const outcome = await removeBackupDirectory(entry.path, {
              configurationRootPath,
              afterRename: () => options.onFaultPoint?.('after-rename', proof.item.key),
              afterVerify: () => options.onFaultPoint?.('after-verify', proof.item.key),
              stillCovered: async (deleting) => await stillCovered(root, proof, current)
                ?? (await sameShallowTree(deleting, proof.tree) ? undefined : '改名前后这份备份有变化，请重新检查')
            });
            if (outcome.state === 'deleted') {
              result.deleted.push({
                key: proof.item.key, name: proof.item.name, path: proof.item.path,
                bytes: proof.item.bytes, reclaimableBytes: proof.item.reclaimableBytes
              });
              await cache.remove(backupSubject(configurationRootPath, entry.path));
            } else if (outcome.state === 'unfinished') {
              result.unfinished.push({
                key: proof.item.key, name: proof.item.name, path: proof.item.path, reason: outcome.reason,
                ...(outcome.detail ? { detail: outcome.detail } : {})
              });
            } else {
              keep(outcome.reason, outcome.detail);
            }
          }
        }));
        // Leaving the maintenance claim also took the marker out of the admission: publish it again.
        admission.report(`已处理 ${started}/${total} 份备份`);
      }
    }));
  }
  const cache = new CoverageCache(configurationRootPath);
  const emptied = new Map<string, string>();
  for (const proof of selectedForeign) {
    started += 1;
    let outcome: RemovalOutcome;
    // Known once the removal ran (a failed release of the claim afterwards does not undo it).
    let removal: RemovalOutcome | undefined;
    try {
      // Never waited for: another window or operation using it keeps it. The admission is held until
      // the mark is durable; the removal of a large content store then runs under the claim alone.
      const claimed = await withForeignClaimReleasingAdmission<RemovalOutcome>(configurationRootPath, proof.root.id,
        proof.root.located.rootPointerPath, { ...ACTIVITY, stage: stage() }, async () => {
          const marked = await markForeignRoot(proof, { configurationRootPath, current, options });
          if (marked.state !== 'marked') return { value: marked };
          try {
            await options.onFaultPoint?.('after-verify', proof.item.key);
          } catch (error) {
            return { value: unfinishedRemoval(marked.deleting, error) };
          }
          return {
            value: { state: 'deleted' },
            after: async () => {
              try {
                await options.onFaultPoint?.('before-removal', proof.item.key);
                removal = await removeMarked(marked.deleting);
              } catch (error) {
                removal = unfinishedRemoval(marked.deleting, error);
              }
              return removal;
            }
          };
        });
      outcome = claimed.acquired ? claimed.value : { state: 'kept', reason: `${FOREIGN_BUSY}，这一项没有删除` };
    } catch (error) {
      outcome = removal ?? { state: 'kept', reason: '没有删除：再次核对时出错', detail: errorMessage(error) };
    }
    if (outcome.state === 'deleted') {
      result.deleted.push({
        key: proof.item.key, name: proof.item.name, path: proof.item.path,
        bytes: proof.item.bytes, reclaimableBytes: proof.item.reclaimableBytes
      });
      await cache.remove(foreignSubject(proof.root.id));
      if (proof.copiedDirectory) emptied.set(comparable(proof.copiedDirectory), proof.copiedDirectory);
    } else if (outcome.state === 'unfinished') {
      result.unfinished.push({
        key: proof.item.key, name: proof.item.name, path: proof.item.path, reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {})
      });
    } else {
      result.kept.push({
        key: proof.item.key, name: proof.item.name, path: proof.item.path, reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {})
      });
    }
  }
  if (emptied.size > 0) {
    // A copied directory is never deleted as a whole: once no data set is left, the rest is the user's.
    const remaining = await discoverForeignRuntimeHistory({
      configurationRootPath, ...(plan.previousDataRootPaths?.length ? { previousDataRootPaths: plan.previousDataRootPaths } : {})
    }).catch(() => undefined);
    for (const [key, directory] of emptied) {
      if (remaining && !remaining.some((entry) => comparable(entry.location.containerPath) === key && hasDataRoot(entry.location))) {
        result.copiedDirectoriesWithoutDataSets.push({ name: path.basename(directory), path: directory });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Control roots and their local data sets

async function listControlRoots(
  configurationRootPath: string,
  current: RuntimeBackupCleanupCurrent,
  problem: (text: string, error?: unknown) => void
): Promise<ControlRoots> {
  const roots = new Map<string, ControlRoot>();
  const add = (scopeRootPath: string): ControlRoot => {
    const controlRootPath = path.join(scopeRootPath, VSCODE_RUNTIME_CONTROL_DIRECTORY);
    const key = comparable(controlRootPath);
    let root = roots.get(key);
    if (!root) {
      root = {
        scopeRootPath, controlRootPath, inProgress: [],
        paths: createRuntimeRootPaths(path.join(controlRootPath, VSCODE_RUNTIME_ACTIVE_DIRECTORY))
      };
      roots.set(key, root);
    }
    return root;
  };
  add(configurationRootPath);
  const scopes = path.join(configurationRootPath, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY);
  try {
    for (const name of await readDirectoryNames(scopes)) {
      const scope = path.join(scopes, name);
      const info = await lstatOrUndefined(scope);
      if (info?.isDirectory()) add(scope);
    }
  } catch (error) {
    // Every backup there stays: none of them is listed, so none can be deleted.
    problem('工作区历史库所在的目录无法读取，其中的备份没有列出，都按历史保留。', error);
  }
  let inspection: Awaited<ReturnType<typeof inspectVscodeRuntimeDataSets>> | undefined;
  try {
    inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: configurationRootPath });
  } catch (error) {
    problem('历史库列表无法读取，所有备份都按历史保留。', error);
  }
  for (const entry of inspection?.problems ?? []) {
    const root = add(entry.runtimeScopeRootPath);
    root.candidateId = entry.id;
    root.unavailable = '所在历史库无法读取，无法核对，按历史保留';
    root.unavailableDetail = entry.message;
  }
  // Whose database files are which inodes, before anything is copied: a hard link of a database
  // this process may hold open (the current one, or another one a merge of this window holds) is
  // never opened or closed by this process.
  const databaseFiles = new Map<string, string>();
  for (const identity of await fileIdentities(current.binding.paths.databasePath)) databaseFiles.set(identity, CURRENT_LABEL);
  const candidateFiles = new Map<string, Set<string>>();
  for (const candidate of inspection?.candidates ?? []) {
    if (!candidate.dataSetId) continue;
    const identities = await fileIdentities(createRuntimeRootPaths(candidate.runtimeDataRootPath).databasePath);
    candidateFiles.set(candidate.id, identities);
    for (const identity of identities) if (!databaseFiles.has(identity)) databaseFiles.set(identity, OTHER_DATA_SET_LABEL);
  }
  const currentFiles = new Set([...databaseFiles].filter(([, owner]) => owner === CURRENT_LABEL).map(([identity]) => identity));
  for (const candidate of inspection?.candidates ?? []) {
    const root = add(candidate.runtimeScopeRootPath);
    root.candidateId = candidate.id;
    if (comparable(path.dirname(candidate.runtimeDataRootPath)) !== comparable(root.controlRootPath)) {
      root.unavailable = '历史库的位置与目录不一致，按历史保留';
    } else if (candidate.requiresRecovery) {
      root.unavailable = '所在历史库有未完成的切换，打开它完成恢复之后再清理';
    } else if (!candidate.dataSetId) {
      root.unavailable = '所在位置没有已初始化的历史库，无法核对';
    } else {
      try {
        const binding = await requireCompleteRuntimeDataSet(candidate);
        const samePlace = comparable(binding.paths.databasePath) === comparable(current.binding.paths.databasePath);
        const own = [...candidateFiles.get(candidate.id) ?? []];
        const linkedTo = samePlace ? undefined
          : own.some((identity) => currentFiles.has(identity)) ? CURRENT_LABEL
            : [...candidateFiles].find(([id, files]) => id !== candidate.id && own.some((identity) => files.has(identity)))?.[0];
        if (samePlace && !sameBinding(binding, current.binding)) {
          root.unavailable = '这个库与本窗口打开的当前库记录不一致，暂不清理';
        } else if (linkedTo === CURRENT_LABEL) {
          root.unavailable = '所在历史库和当前库是同一个文件（硬链接）；为了不破坏当前库的锁，不读取它，按历史保留';
        } else if (linkedTo) {
          root.unavailable = '所在历史库和另一个历史库是同一个文件（硬链接），两个都不读取，按历史保留';
        } else {
          root.local = { candidate, binding, current: samePlace };
        }
      } catch (error) {
        root.unavailable = '所在历史库无法读取，无法核对，按历史保留';
        root.unavailableDetail = errorMessage(error);
      }
    }
  }
  for (const root of roots.values()) {
    if (!root.local && !root.unavailable) root.unavailable = '所在位置没有可以核对的历史库';
    try {
      for (const [file, operation] of IN_PROGRESS_FILES) {
        if (await lstatOrUndefined(path.join(root.controlRootPath, file)) && !root.inProgress.includes(operation)) root.inProgress.push(operation);
      }
    } catch (error) {
      // Whether an operation is in progress there cannot be told: nothing of it is proven.
      root.local = undefined;
      root.unavailable = '所在位置无法读取，无法确认没有进行中的操作，按历史保留';
      root.unavailableDetail = errorMessage(error);
    }
  }
  return { roots: [...roots.values()], databaseFiles };
}

/** dev:ino of a database, its WAL and shared memory (stat only: no descriptor is opened). */
async function fileIdentities(databasePath: string, suffixes: readonly string[] = ['', '-wal', '-shm']): Promise<Set<string>> {
  const result = new Set<string>();
  for (const suffix of suffixes) {
    const stat = await fs.stat(`${databasePath}${suffix}`, { bigint: true }).catch(() => undefined);
    if (stat) result.add(`${stat.dev}:${stat.ino}`);
  }
  return result;
}

/** Whose database a copy's SQLite file or WAL (what a private copy would read) is a hard link of, if anyone's. */
async function hardLinkedDatabase(databasePath: string, files: DatabaseFiles): Promise<string | undefined> {
  for (const identity of await fileIdentities(databasePath, ['', '-wal'])) {
    const owner = files.get(identity);
    if (owner) return owner;
  }
  return undefined;
}

function inProgressOperations(root: ControlRoot, ledger: LedgerFacts): string[] {
  const found = [...root.inProgress];
  if (ledger.recordsUnreadable) found.push('合并记录无法读取');
  else if (root.local && ledger.committing.has(identityKey(root.local.binding))) found.push('正在提交的合并');
  return found;
}

async function readLedgerFacts(configurationRootPath: string): Promise<LedgerFacts> {
  const paths: StoragePaths = { globalStoragePath: configurationRootPath };
  const committing = new Set<string>();
  let recordsUnreadable = false;
  try {
    for (const record of (await readRuntimeDataSetMergeLedger(paths)).values()) {
      if (record.state !== 'committing') continue;
      committing.add(identityKey(record.source));
      committing.add(identityKey(record.target));
    }
  } catch {
    recordsUnreadable = true;
  }
  const finalizationBackups = new Set<string>();
  let finalizationsUnreadable = false;
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot(paths), FINALIZATIONS_DIRECTORY);
  try {
    await assertNoSymbolicPrefix(configurationRootPath, directory);
    for (const name of await readDirectoryNames(directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as { sourceBackupPath?: unknown } | null;
        if (typeof value?.sourceBackupPath === 'string') finalizationBackups.add(comparable(value.sourceBackupPath));
        else finalizationsUnreadable = true;
      } catch {
        finalizationsUnreadable = true;
      }
    }
  } catch {
    finalizationsUnreadable = true;
  }
  const preparing = { paths: new Set<string>(), names: new Set<string>(), live: new Set<string>() };
  let preparingUnreadable = false;
  try {
    for (const { file, backup } of await readRuntimeLargeMergeTargetBackups(paths)) {
      if (!backup) {
        // Not a registration this version can read: whichever backup it names stays.
        preparing.names.add(file.replace(/\.json$/, ''));
        continue;
      }
      const live = isRuntimeLargeMergeTargetBackupLive(backup);
      // A used one whose window is gone is any merge's pre-merge backup now (only its registration is left).
      if (!live && backup.used) continue;
      preparing.paths.add(comparable(path.resolve(backup.backupPath)));
      preparing.names.add(backup.name);
      if (live) preparing.live.add(backup.name);
    }
  } catch {
    preparingUnreadable = true;
  }
  return { committing, recordsUnreadable, finalizationBackups, finalizationsUnreadable, preparingBackups: preparing, preparingUnreadable };
}

/**
 * Why a pre-merge backup a large-merge preparation registered stays (see LedgerFacts.preparingBackups),
 * undefined for any other.
 */
function preparingBackupReason(ledger: LedgerFacts, directory: string): string | undefined {
  if (ledger.preparingUnreadable) return '大库合并准备的备份登记无法读取，不能确认它没有被使用，保留';
  const name = path.basename(directory);
  if (!ledger.preparingBackups.paths.has(comparable(directory)) && !ledger.preparingBackups.names.has(name)) return undefined;
  return ledger.preparingBackups.live.has(name)
    ? '大库合并的准备正在使用它（准备登记仍然有效），保留'
    : '大库合并准备时做的，还没有被合并用上（由合并自己清理），保留';
}

// ---------------------------------------------------------------------------------------------
// The three kinds that can be proven

interface BackupEntry {
  name: string;
  path: string;
  /** Why it is not a copy of this kind at all (a link, a file, an unknown name). */
  foreign?: string;
}

async function listBackupEntries(configurationRootPath: string, root: ControlRoot, kind: DeletableKind): Promise<BackupEntry[]> {
  const directory = path.join(root.controlRootPath, DELETABLE_DIRECTORIES[kind]);
  const info = await lstatOrUndefined(directory);
  if (!info) return [];
  try {
    await assertNoSymbolicPath(configurationRootPath, directory);
  } catch {
    return [{ name: DELETABLE_DIRECTORIES[kind], path: directory, foreign: '目录路径里有符号链接，不跟随也不删除' }];
  }
  if (!info.isDirectory()) return [{ name: DELETABLE_DIRECTORIES[kind], path: directory, foreign: '不是目录，不处理' }];
  const entries: BackupEntry[] = [];
  for (const name of (await readDirectoryNames(directory)).sort()) {
    if (DELETING_NAME.test(name)) continue;
    const entry = await backupEntry(configurationRootPath, root, kind, name);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function backupEntry(configurationRootPath: string, root: ControlRoot, kind: DeletableKind, name: string): Promise<BackupEntry | undefined> {
  const entryPath = path.join(root.controlRootPath, DELETABLE_DIRECTORIES[kind], name);
  const info = await lstatOrUndefined(entryPath);
  if (!info) return undefined;
  if (info.isSymbolicLink()) return { name, path: entryPath, foreign: '是符号链接，不跟随也不删除' };
  try {
    await assertNoSymbolicPath(configurationRootPath, entryPath);
  } catch {
    return { name, path: entryPath, foreign: '路径里有符号链接，不跟随也不删除' };
  }
  if (!info.isDirectory()) return { name, path: entryPath, foreign: '不是备份目录，不处理' };
  const known = kind === 'epoch-migration' ? EPOCH_BACKUP_NAME.test(name) : MERGE_BACKUP_NAME.test(name);
  if (!known) return { name, path: entryPath, foreign: '不认识的目录名，不处理' };
  return { name, path: entryPath };
}

interface EvaluationInput {
  configurationRootPath: string;
  root: ControlRoot;
  kind: DeletableKind;
  entry: BackupEntry;
  ledger: LedgerFacts;
  current: RuntimeBackupCleanupCurrent;
  cache: CoverageCache;
  databaseFiles: DatabaseFiles;
  bodies: BodyCheck;
  now: number;
  /** The proof of the listing, when re-verifying for deletion. */
  known?: BackupProof;
}

async function evaluateBackup(input: EvaluationInput): Promise<Evaluation> {
  const { configurationRootPath, root, kind, entry, now } = input;
  const tree = entry.foreign ? undefined : await describeTree(entry.path).catch(() => undefined);
  const local = root.local;
  const item: RuntimeBackupCleanupItem = {
    key: itemKey(kind, configurationRootPath, entry.path),
    kind, name: entry.name, path: entry.path,
    ...(root.candidateId ? { dataSetCandidateId: root.candidateId } : {}),
    ...(local ? { dataSetName: localName(local) } : {}),
    inCurrentDataSet: local?.current === true,
    bytes: (tree?.bytes ?? 0n).toString(),
    reclaimableBytes: (tree?.reclaimableBytes ?? 0n).toString(),
    fileCount: tree?.fileCount ?? 0,
    deletable: false,
    reason: ''
  };
  const createdAt = backupCreatedAt(kind, entry.name);
  if (createdAt !== undefined) item.createdAt = new Date(createdAt).toISOString();
  const keep = (reason: string, detail?: string): Evaluation => ({ item: { ...item, reason, ...(detail ? { detail } : {}) } });
  if (entry.foreign) return keep(entry.foreign);
  if (!tree) return keep('无法读取这个目录，按历史保留');
  if (input.known && tree.digest !== input.known.tree.digest) return keep('列出之后这份备份有变化，请重新检查');
  if (tree.symbolicLink) return keep('目录里有符号链接，不跟随也不删除');
  if (tree.unsupported) return keep('目录里有无法识别的文件类型，不处理');
  const operations = inProgressOperations(root, input.ledger);
  if (operations.length > 0) return keep(`有进行中的操作（${operations.join('、')}），完成之后再清理`);
  if (!local) return keep(root.unavailable ?? '所在位置没有可以核对的历史库', root.unavailableDetail);
  if (input.known && (!sameBinding(local.binding, input.known.binding) || local.current !== input.known.current)) {
    return keep('所在历史库在检查之后发生了变化，请重新检查');
  }

  let recorded: HistoricalRootBinding;
  let databasePath: string;
  let backupBinding: HistoricalRootBinding;
  if (kind === 'epoch-migration') {
    const completion = await readUpgradeCompletion(entry.path);
    if (typeof completion === 'string') return keep(completion);
    // The latest of every time the upgrade left behind (its record, the directory name, the record
    // file's mtime and ctime): a clock that was behind then, or is ahead now, gains nothing.
    const completedAt = Math.max(completion.completedAt, createdAt ?? 0, completion.recordedAt);
    if (completedAt > now) return keep('升级完成的时间晚于现在，时间不可信，按历史保留');
    if (now - completedAt < RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS) {
      return keep(`升级完成不满 7 天，${formatLocalTime(completedAt + RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS)} 之后才可以删除`);
    }
    const content = await backupContentProblem(entry.path, kind, completion.fromEpoch);
    if (content) return keep(`${content}，保留`);
    recorded = completion.nextBinding;
    backupBinding = completion.previousBinding;
    databasePath = path.join(entry.path, `limcode.epoch-${completion.fromEpoch}.sqlite`);
  } else {
    const content = await backupContentProblem(entry.path, kind);
    if (content) return keep(content === BACKUP_UNFINISHED ? '备份还没有写完（目录里有临时文件），保留' : `${content}，保留`);
    if (kind === 'merge-target') {
      const preparing = preparingBackupReason(input.ledger, entry.path);
      if (preparing) return keep(preparing);
      if (now - backupTime(createdAt, tree.modifiedAt, now) < RUNTIME_BACKUP_CLEANUP_MERGE_BACKUP_MIN_AGE_MS) {
        return keep('创建不满 1 小时，可能正被合并使用，保留');
      }
      const protection = await newestMergeBackupProtection(root, entry.name, now, input.ledger);
      if (protection) return keep(protection);
    } else {
      if (input.ledger.finalizationsUnreadable) return keep('合并收尾记录无法读取，不能确认它没有被引用，保留');
      if (input.ledger.finalizationBackups.has(comparable(entry.path))) return keep('被尚未报告的合并收尾记录引用，保留');
    }
    const saved = await readBindingFile(path.join(entry.path, ROOT_BINDING_POINTER_FILE));
    if (typeof saved === 'string') return keep(saved);
    recorded = saved;
    backupBinding = saved;
    databasePath = path.join(entry.path, 'limcode.sqlite');
  }
  const database = await lstatOrUndefined(databasePath);
  if (!database?.isFile()) return keep('备份里没有数据库文件，不处理');
  if (!sameDataSet(recorded, local.binding)) return keep('不是所在历史库的备份（身份不一致），按历史保留');
  if (local.binding.rootGeneration < recorded.rootGeneration) return keep('所在历史库比这份备份更旧（代数更低），按历史保留');
  // Copying it would open and close that database's inode in this process (POSIX locks).
  const linked = await hardLinkedDatabase(databasePath, input.databaseFiles);
  if (linked) return keep(`它和${linked}是同一个文件（硬链接）；为了不破坏${linked === CURRENT_LABEL ? CURRENT_LABEL : '那个库'}的锁，不读取它，按历史保留`);

  if (input.known) {
    // Deleting: the same proof, verified again (the open data set by its Conversations and what is
    // visible, another one by its exact files; see recheckInCurrent).
    try {
      const refusal = local.current
        ? await recheckInCurrent(input.current, input.known.recheck, input.known.replaced, '这份备份里有', false)
        : await localUnchanged(local, input.databaseFiles, input.known.localFiles);
      if (refusal) return keep(refusal);
    } catch (error) {
      return keep(error instanceof CleanupRefusal ? error.message : unreadableReason(error, local.current ? CURRENT_LABEL : '所在历史库'), errorMessage(error));
    }
    return { item: input.known.item, proof: input.known };
  }
  let backupIds: RuntimeDataSetHistoryIds;
  try {
    backupIds = await input.cache.backupIds(databasePath, backupBinding);
  } catch (error) {
    return keep(error instanceof CleanupRefusal ? error.message : unreadableReason(error, '这份备份'), errorMessage(error));
  }
  let coverage: Coverage;
  try {
    if (!local.current) await localFacts(local, input.cache, input.databaseFiles);
    coverage = await coverageIn(local, backupIds, input.current, input.bodies);
  } catch (error) {
    return keep(error instanceof CleanupRefusal ? error.message : unreadableReason(error, local.current ? CURRENT_LABEL : '所在历史库'), errorMessage(error));
  }
  const where = localName(local);
  const counts = {
    conversations: backupIds.conversations.length, revisions: backupIds.messageRevisions.length,
    missingConversations: coverage.missingConversations, missingRevisions: coverage.missingRevisions
  };
  const refusal = coverageRefusal(coverage, where);
  if (refusal) return { item: { ...item, ...counts, reason: refusal } };
  const replaced = coverage.replaced.length;
  const proven: RuntimeBackupCleanupItem = {
    ...item, ...counts, deletable: true, ...(replaced > 0 ? { replacedMessages: replaced } : {}),
    reason: replaced > 0 ? replacedReason(replaced, where)
      : `可以删除：内容已完整在${where}里（其中 ${counts.conversations} 个对话、${counts.revisions} 个消息版本都在，显示的消息相同，正文文件也都在）`
  };
  return {
    item: proven,
    proof: {
      item: proven, kind, controlRootPath: root.controlRootPath, candidateId: local.candidate.id, tree,
      binding: local.binding, current: local.current, replaced: new Set(coverage.replaced),
      ...(local.current ? { recheck: recheckIds(backupIds) } : local.facts ? { localFiles: local.facts.files } : {})
    }
  };
}

/** A backup directory still being written (a `.tmp` file in it). */
const BACKUP_UNFINISHED = '还没有写完（目录里有临时文件）';

/**
 * What a backup directory holds beyond what its kind writes (L2): the database of the backup with
 * its sidecars, the saved binding or the upgrade's records, and a verified mark of this cleanup (a
 * directory that got its name back). A `.tmp` file means it is still being written
 * (BACKUP_UNFINISHED); anything else, or an entry of another type, is unknown and keeps it.
 */
async function backupContentProblem(directory: string, kind: DeletableKind, fromEpoch?: number): Promise<string | undefined> {
  const allowed = kind === 'epoch-migration'
    ? new Set([
      `root-binding.epoch-${fromEpoch}.json`, `runtime-kernel-epoch.epoch-${fromEpoch}.json`, 'epoch-migration-journal.completed.json',
      RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE, ...BACKUP_DATABASE_SIDECARS.map((suffix) => `limcode.epoch-${fromEpoch}.sqlite${suffix}`)
    ])
    : MERGE_BACKUP_FILES;
  const unknown: string[] = [];
  let unfinished = false;
  for (const name of (await fs.readdir(directory)).sort()) {
    const info = await fs.lstat(path.join(directory, name));
    if (info.isFile() && (allowed.has(name) || name === VERIFIED_MARKER_FILE)) continue;
    if (info.isFile() && name.endsWith('.tmp')) unfinished = true;
    else unknown.push(name);
  }
  if (unknown.length > 0) return `备份目录里有不认识的内容（${unknown.slice(0, 5).join('、')}${unknown.length > 5 ? ' 等' : ''}）`;
  return unfinished ? BACKUP_UNFINISHED : undefined;
}

/** When a pre-merge backup was made: its name, or the directory's last change when that is later. */
function backupTime(createdAt: number | undefined, modifiedAt: number, now: number): number {
  return Math.max(createdAt ?? now, modifiedAt);
}

/**
 * The newest complete pre-merge backup at least an hour old anchors the protection: it and every
 * newer one stay. A younger one may still be removed by the merge batch that wrote it (when no
 * transaction used it), so it never takes the anchor's place; nor does a large-merge preparation's
 * that is still registered (see preparingBackupReason): its merge may remove it however old it is.
 */
async function newestMergeBackupProtection(root: ControlRoot, name: string, now: number, ledger: LedgerFacts): Promise<string | undefined> {
  const directory = path.join(root.controlRootPath, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY);
  const names = (await readDirectoryNames(directory)).flatMap((entry) => {
    const match = MERGE_BACKUP_NAME.exec(entry);
    return match ? [{ name: entry, time: match[1], sequence: Number(match[2]) }] : [];
  }).sort((left, right) => left.time.localeCompare(right.time) || left.sequence - right.sequence
    || left.name.localeCompare(right.name)).map((entry) => entry.name);
  let anchor = -1;
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const backup = path.join(directory, names[index]);
    const info = await lstatOrUndefined(backup);
    const database = await lstatOrUndefined(path.join(backup, 'limcode.sqlite'));
    const temporary = (await readDirectoryNames(backup)).some((entry) => entry.endsWith('.tmp'));
    const made = backupTime(backupCreatedAt('merge-target', names[index]), info ? info.mtimeMs : now, now);
    if (info?.isDirectory() && database?.isFile() && !temporary && now - made >= RUNTIME_BACKUP_CLEANUP_MERGE_BACKUP_MIN_AGE_MS
      && !preparingBackupReason(ledger, backup)) {
      anchor = index;
      break;
    }
  }
  const position = names.indexOf(name);
  if (anchor < 0) return '这个库还没有满 1 小时的完整合并前备份，全部保留';
  if (position === anchor) return '这是这个库最新的一份满 1 小时的完整合并前备份，保留';
  if (position > anchor) return '比这个库最新的一份满 1 小时的完整合并前备份还新，保留';
  return undefined;
}

interface UpgradeCompletion {
  fromEpoch: 3 | 4 | 5 | 6 | 7 | 8;
  previousBinding: HistoricalRootBinding;
  nextBinding: HistoricalRootBinding;
  completedAt: number;
  /** When the completion record was last written (the later of its mtime and ctime). */
  recordedAt: number;
}

/** Reads a small record as text: the local file, or a foreign root's through readLocatedRuntimeFile. */
type TextReader = (file: string) => Promise<string>;
const readLocalText: TextReader = (file) => fs.readFile(file, 'utf8');

async function readUpgradeCompletion(directory: string, read: TextReader = readLocalText): Promise<UpgradeCompletion | string> {
  const file = path.join(directory, RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE);
  const info = await lstatOrUndefined(file);
  if (!info) return '没有升级完成记录（可能是旧版本或没有完成的升级留下的），按历史保留';
  if (!info.isFile()) return '升级完成记录不是普通文件，不处理';
  let record: Record<string, unknown>;
  try {
    const value = JSON.parse(await read(file)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    record = value as Record<string, unknown>;
  } catch {
    return '升级完成记录无法读取，按历史保留';
  }
  // v0.0.15–0.0.21 wrote the same kind for their 3→4 upgrade into the same directory.
  if (record.kind === MIGRATION_COMPLETION_KIND && record.toEpoch === 4) return '旧版本 3→4 升级留下的备份，一律保留';
  const completedAt = typeof record.completedAt === 'string' ? Date.parse(record.completedAt) : Number.NaN;
  const recognizedUpgrade = (record.toEpoch === 5 && (record.fromEpoch === 3 || record.fromEpoch === 4))
    || (record.toEpoch === 6 && (record.fromEpoch === 3 || record.fromEpoch === 4 || record.fromEpoch === 5))
    || (record.toEpoch === 7 && (record.fromEpoch === 3 || record.fromEpoch === 4 || record.fromEpoch === 5 || record.fromEpoch === 6))
    || (record.toEpoch === 8 && (record.fromEpoch === 3 || record.fromEpoch === 4 || record.fromEpoch === 5 || record.fromEpoch === 6 || record.fromEpoch === 7))
    || (record.toEpoch === 9 && (record.fromEpoch === 3 || record.fromEpoch === 4 || record.fromEpoch === 5 || record.fromEpoch === 6 || record.fromEpoch === 7 || record.fromEpoch === 8));
  if (record.kind !== MIGRATION_COMPLETION_KIND || !recognizedUpgrade || !Number.isFinite(completedAt)) {
    return '升级完成记录无法识别，按历史保留';
  }
  let previousBinding: HistoricalRootBinding;
  let nextBinding: HistoricalRootBinding;
  try {
    previousBinding = parseHistoricalRootBinding(record.previousBinding);
    nextBinding = parseHistoricalRootBinding(record.nextBinding);
  } catch {
    return '升级完成记录里的身份无法识别，按历史保留';
  }
  const saved = await readBindingFile(path.join(directory, `root-binding.epoch-${record.fromEpoch}.json`), read);
  if (typeof saved === 'string' || !sameBinding(saved, previousBinding) || previousBinding.runtimeKernelEpoch !== record.fromEpoch
    || nextBinding.runtimeKernelEpoch !== record.toEpoch || !sameDataSet(previousBinding, nextBinding)) {
    return '升级完成记录与备份里的身份记录不一致，按历史保留';
  }
  return {
    fromEpoch: record.fromEpoch as UpgradeCompletion['fromEpoch'], previousBinding, nextBinding, completedAt,
    recordedAt: Math.max(info.mtimeMs, info.ctimeMs)
  };
}

async function readBindingFile(file: string, read: TextReader = readLocalText): Promise<HistoricalRootBinding | string> {
  const info = await lstatOrUndefined(file);
  if (!info?.isFile()) return '备份里没有身份记录（root-binding），不处理';
  try {
    return parseHistoricalRootBinding(JSON.parse(await read(file)) as unknown);
  } catch {
    return '备份里的身份记录无法识别，不处理';
  }
}

function backupCreatedAt(kind: RuntimeBackupKind, name: string): number | undefined {
  if (kind === 'merge-target' || kind === 'merge-source') {
    const match = MERGE_BACKUP_NAME.exec(name)?.[1];
    return match ? utcSlugTime(match) : undefined;
  }
  return utcSlugTime(name);
}

/**
 * `YYYYMMDDTHHMMSS[mmm]Z` (merge engine, epoch migration), `YYYYMMDD-HHMMSS-mmm` (归档) or
 * `YYYY-MM-DDTHH-MM-SS-mmmZ` (directories a relocation copied aside).
 */
function utcSlugTime(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})[T-](\d{2})(\d{2})(\d{2})-?(\d{3})?Z?/.exec(value)
    ?? /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond ?? 0));
  return Number.isFinite(time) ? time : undefined;
}

/**
 * A reason in words for a copy or data set that could not be read: a state that stays (a damaged
 * or foreign database) keeps the copy as history, one that may pass says so. The error text itself
 * only goes to `detail`.
 */
function unreadableReason(error: unknown, subject: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = errorMessage(error);
  if (code === 'ENOSPC' || /ENOSPC|no space/i.test(message)) return '暂时无法核对：磁盘空间不足，腾出空间后再试';
  if (code === 'runtime-backup-changed-while-reading') return `暂时无法核对：${subject}在读取期间有变化，稍后再试`;
  if (subject === CURRENT_LABEL) return '暂时无法读取当前库，这次不删除，稍后再试';
  if (/RootBinding|root_binding/.test(message)) return `${subject}里的数据库与它的身份记录不一致，按历史保留`;
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || /malformed|not a database/i.test(message)) {
    return `${subject}的数据库已损坏，无法核对，按历史保留`;
  }
  if (/rollback journal/i.test(message)) return `${subject}有未完成的回滚日志，无法核对，按历史保留`;
  return `${subject}无法读取，无法核对，按历史保留`;
}

// ---------------------------------------------------------------------------------------------
// Coverage: the copy's history is in one local data set, and shows the same there

/**
 * lstat results of CAS files in this check, per CAS root by storage key (the size of a regular file,
 * undefined for anything else): a body is looked up once per data set.
 */
type BodyCheck = Map<string, Map<string, number | undefined>>;

/**
 * How much of a copy's history (`ids`) one local data set holds. Conversations first (they are
 * hard-deleted, with everything of theirs), then message versions, the other history rows and the
 * bodies, each only while nothing before it is missing. Then what is visible: every message the copy
 * shows must be shown there too, with the same current revision (a message deleted, edited or retried
 * there is soft-deleted or replaced: its rows stay, but no reader shows it any more). The open data
 * set is read through its own worker reader; another one from its facts. A body counts only as a
 * regular file of its recorded size at its storage key in that data set's CAS (lstat only).
 */
async function coverageIn(
  local: LocalDataSet,
  ids: RuntimeDataSetHistoryIds,
  current: RuntimeBackupCleanupCurrent,
  bodies: BodyCheck
): Promise<Coverage> {
  const coverage: Coverage = { missingConversations: 0, missingRevisions: 0, missingRecords: [], missingContents: 0, replaced: [] };
  const casRoot = local.binding.paths.casRootPath;
  if (local.current) {
    coverage.missingConversations = await countMissingInCurrent(current, 'Conversation', ids.conversations);
    if (coverage.missingConversations > 0) return coverage;
    coverage.missingRevisions = await countMissingInCurrent(current, 'MessageRevision', ids.messageRevisions);
    if (coverage.missingRevisions > 0) return coverage;
    for (const domain of RUNTIME_HISTORY_RECORD_DOMAINS) {
      const missing = await countMissingInCurrent(current, domain.key, ids.records[domain.key] ?? []);
      if (missing > 0) coverage.missingRecords.push([domain.key, missing]);
    }
    if (coverage.missingRecords.length > 0) return coverage;
    coverage.missingContents = await missingBodiesInCurrent(current, ids.contents, bodies);
    if (coverage.missingContents > 0) return coverage;
    coverage.replaced = [...new Set(await replacedInCurrent(current, ids.visibleMessages))];
    return coverage;
  }
  const facts = local.facts;
  if (!facts) throw new Error('所在历史库的内容还没有读出来');
  coverage.missingConversations = ids.conversations.filter((id) => !facts.conversations.has(id)).length;
  if (coverage.missingConversations > 0) return coverage;
  coverage.missingRevisions = ids.messageRevisions.filter((id) => !facts.messageRevisions.has(id)).length;
  if (coverage.missingRevisions > 0) return coverage;
  for (const domain of RUNTIME_HISTORY_RECORD_DOMAINS) {
    const held = facts.records.get(domain.key);
    const missing = (ids.records[domain.key] ?? []).filter((id) => !held?.has(id)).length;
    if (missing > 0) coverage.missingRecords.push([domain.key, missing]);
  }
  if (coverage.missingRecords.length > 0) return coverage;
  for (const id of ids.contents) {
    const body = facts.contents.get(id);
    if (!body || !await bodyPresent(casRoot, body[0], body[1], bodies)) coverage.missingContents += 1;
  }
  if (coverage.missingContents > 0) return coverage;
  coverage.replaced = [...new Set(ids.visibleMessages.filter(([message, , revision]) => facts.visible.get(message) !== revision)
    .map(([message]) => message))];
  return coverage;
}

/** Anything the copy has that the data set does not: it stays as history. */
function hardMissing(coverage: Coverage): boolean {
  return coverage.missingConversations > 0 || coverage.missingRevisions > 0 || coverage.missingRecords.length > 0 || coverage.missingContents > 0;
}

/** Which of two coverages misses less (conversations first, then versions, other rows and bodies; then what is replaced). */
function lessMissing(left: Coverage, right: Coverage): boolean {
  const key = (coverage: Coverage) => [
    coverage.missingConversations, coverage.missingRevisions,
    coverage.missingRecords.reduce((sum, [, count]) => sum + count, 0), coverage.missingContents, coverage.replaced.length
  ];
  const [a, b] = [key(left), key(right)];
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] < b[index];
  return false;
}

/** Why a copy the data set does not hold completely is kept (undefined when it holds all of it). */
function coverageRefusal(coverage: Coverage, where: string, others = ''): string | undefined {
  if (coverage.missingConversations > 0) return `含 ${coverage.missingConversations} 个${where}没有的对话（可能是你删掉的）${others}，按历史保留`;
  if (coverage.missingRevisions > 0) return `含 ${coverage.missingRevisions} 个${where}没有的消息版本${others}，按历史保留`;
  if (coverage.missingRecords.length > 0) {
    const listed = coverage.missingRecords.slice(0, 3).map(([domain, count]) => `${RECORD_LABELS[domain] ?? domain} ${count} 条`);
    return `含${where}没有的记录（${listed.join('、')}${coverage.missingRecords.length > 3 ? ' 等' : ''}）${others}，按历史保留`;
  }
  if (coverage.missingContents > 0) return `${where}里缺 ${coverage.missingContents} 个它引用的正文文件（可能已损坏或丢失）${others}，按历史保留`;
  return undefined;
}

/** A copy whose visible messages are partly deleted or replaced where the rest is: deletable only when ticked knowingly. */
function replacedReason(count: number, where: string): string {
  return `其中 ${count} 条消息在${where}里已被你删除、编辑或重试替换，删除这份后它们就再也看不到了`;
}

async function countMissingInCurrent(current: RuntimeBackupCleanupCurrent, domain: string, ids: readonly string[]): Promise<number> {
  let missing = 0;
  for (let offset = 0; offset < ids.length; offset += RUNTIME_BACKUP_CLEANUP_READ_BATCH) {
    const rows = await readCurrent(current, ids.slice(offset, offset + RUNTIME_BACKUP_CLEANUP_READ_BATCH).map((id) => ({ kind: 'get', domain, id })));
    for (const row of rows) if (row === null || row === undefined) missing += 1;
  }
  return missing;
}

/** Bodies of the copy the open data set lacks: its content object (read through its reader) and a regular file of that size at its storage key. */
async function missingBodiesInCurrent(
  current: RuntimeBackupCleanupCurrent,
  contents: readonly string[],
  bodies: BodyCheck
): Promise<number> {
  let missing = 0;
  for (let offset = 0; offset < contents.length; offset += RUNTIME_BACKUP_CLEANUP_READ_BATCH) {
    const batch = contents.slice(offset, offset + RUNTIME_BACKUP_CLEANUP_READ_BATCH);
    const rows = await readCurrent(current, batch.map((id) => ({ kind: 'get', domain: 'ContentObject', id })));
    for (const row of rows) {
      const storageKey = row?.storage_key;
      const byteLength = row?.byte_length;
      if (typeof storageKey !== 'string' || (typeof byteLength !== 'bigint' && typeof byteLength !== 'number')
        || !await bodyPresent(current.binding.paths.casRootPath, storageKey, String(byteLength), bodies)) missing += 1;
    }
  }
  return missing;
}

/** Visible messages of the copy the open data set shows deleted, with another current revision, or not at all. */
async function replacedInCurrent(
  current: RuntimeBackupCleanupCurrent,
  visible: ReadonlyArray<readonly [string, string, string]>
): Promise<string[]> {
  const replaced: string[] = [];
  // Two reads per message: never more than a batch in one request.
  const size = Math.max(1, Math.floor(RUNTIME_BACKUP_CLEANUP_READ_BATCH / 2));
  for (let offset = 0; offset < visible.length; offset += size) {
    const batch = visible.slice(offset, offset + size);
    const rows = await readCurrent(current, [
      ...batch.map(([message]): RepositoryGetRead => ({ kind: 'get', domain: 'Message', id: message })),
      ...batch.map(([, link]): RepositoryGetRead => ({ kind: 'get', domain: 'MessageCurrentRevisionLink', id: link }))
    ]);
    batch.forEach(([message, , revision], index) => {
      const row = rows[index];
      const link = rows[batch.length + index];
      if (!row || row.deleted_at !== null || !link || link.message_id !== message || link.revision_id !== revision) replaced.push(message);
    });
  }
  return replaced;
}

async function readCurrent(current: RuntimeBackupCleanupCurrent, reads: RepositoryGetRead[]): Promise<Array<Record<string, unknown> | null | undefined>> {
  const rows = (await current.snapshot(reads)).snapshot as Array<Record<string, unknown> | null | undefined>;
  if (rows.length !== reads.length) throw new Error('当前库的读取结果数量不对');
  return rows;
}

/** A body is present as a regular file of exactly its size at its storage key below `casRoot` (lstat: never followed, never opened). */
async function bodyPresent(casRoot: string, storageKey: string, byteLength: string, bodies: BodyCheck): Promise<boolean> {
  if (!/^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(storageKey) || !/^(0|[1-9][0-9]*)$/.test(byteLength)) return false;
  let sizes = bodies.get(casRoot);
  if (!sizes) bodies.set(casRoot, sizes = new Map());
  if (!sizes.has(storageKey)) {
    const info = await fs.lstat(path.join(casRoot, ...storageKey.split('/')), { bigint: true }).catch(() => undefined);
    sizes.set(storageKey, info?.isFile() ? Number(info.size) : undefined);
  }
  const size = sizes.get(storageKey);
  return size !== undefined && BigInt(size) === BigInt(byteLength);
}

/**
 * Still proven in the open data set, under the deletion's claims: merges, upgrades and resets are
 * excluded by them (and the proving data set has the same identity and generation), but deleting a
 * Conversation takes no claim, nor does deleting, editing or retrying a message. Every other history
 * row is deleted only with its Conversation, and bodies never are: the Conversations and what is
 * visible are read again, and nothing visible may be replaced beyond what was ticked knowingly.
 */
async function recheckInCurrent(
  current: RuntimeBackupCleanupCurrent,
  ids: RecheckIds | undefined,
  planned: ReadonlySet<string>,
  subject: string,
  afterRename: boolean
): Promise<string | undefined> {
  if (!ids) return '检查时没有记下要再次核对的内容，请重新检查';
  const conversations = await countMissingInCurrent(current, 'Conversation', ids.conversations);
  if (conversations > 0) {
    return afterRename ? `当前库刚刚少了 ${conversations} 个${subject}的对话` : `含 ${conversations} 个当前库没有的对话（可能是你删掉的），按历史保留`;
  }
  const replaced = new Set((await replacedInCurrent(current, ids.visibleMessages)).filter((id) => !planned.has(id))).size;
  if (replaced > 0) {
    return afterRename
      ? `当前库里刚刚又有 ${replaced} 条${subject}的消息被删除、编辑或重试替换`
      : `列出之后当前库里又有 ${replaced} 条${subject}的消息被删除、编辑或重试替换，请重新检查`;
  }
  return undefined;
}

/**
 * After the rename, under the same claims (see recheckInCurrent); another data set must still be
 * exactly the files that were read. Undefined when still covered, else why not.
 */
async function stillCovered(root: ControlRoot, proof: BackupProof, current: RuntimeBackupCleanupCurrent): Promise<string | undefined> {
  const local = root.local;
  if (!local || !sameBinding(local.binding, proof.binding)) return '所在历史库在检查之后发生了变化';
  if (local.current) return recheckInCurrent(current, proof.recheck, proof.replaced, '这份备份里有', true);
  return await runtimeDataSetFileState(local.binding.paths.databasePath) === proof.localFiles
    ? undefined : '所在历史库在检查之后有改动';
}

/** The ids a deletion reads again in the open data set (the rest of them is not kept, see RecheckIds). */
function recheckIds(ids: RecheckIds): RecheckIds {
  return { conversations: ids.conversations, visibleMessages: ids.visibleMessages };
}

/**
 * Another data set is still exactly the files its facts were read from (`files`); never the open one.
 * Undefined when unchanged, else why not.
 */
async function localUnchanged(local: LocalDataSet, databaseFiles: DatabaseFiles, files: string | undefined): Promise<string | undefined> {
  if (local.current || await hardLinkedDatabase(local.binding.paths.databasePath, databaseFiles) === CURRENT_LABEL) {
    return '当前库只经它自己的读取线程查询，不复制它的文件，按历史保留';
  }
  return files !== undefined && await runtimeDataSetFileState(local.binding.paths.databasePath) === files
    ? undefined : '所在历史库在检查之后有改动，请重新检查';
}

/**
 * What a data set this window does not have open holds, from a private copy in the facts worker, taken
 * under its control root's maintenance: a merge of this process that holds that data set open
 * (source backup, finalization) holds the same claim, so its SQLite locks are never released by
 * this copy. The facts count only while the files are exactly as they were read.
 */
async function localFacts(
  local: LocalDataSet,
  cache: CoverageCache,
  databaseFiles: DatabaseFiles
): Promise<LocalFacts> {
  if (local.current || await hardLinkedDatabase(local.binding.paths.databasePath, databaseFiles) === CURRENT_LABEL) {
    // A second fence: listControlRoots already keeps such a data set out.
    throw new CleanupRefusal('当前库只经它自己的读取线程查询，不复制它的文件，按历史保留');
  }
  const files = await runtimeDataSetFileState(local.binding.paths.databasePath);
  if (local.facts?.files === files) return local.facts;
  const subject = dataSetSubject(local.candidate.id);
  const cached = await cache.read(subject, files, local.binding);
  const read = cached?.bodies ? { ids: cached.ids, bodies: cached.bodies, projectNames: cached.projectNames }
    : await withRuntimeMaintenance(local.binding.paths, () => withRuntimeMaintenanceActivity({
      ...ACTIVITY, stage: `正在核对${local.facts ? localName(local) : '一个历史库'}`
    }, async () => {
      const facts = await readRuntimeDataSetFacts(local.candidate, { historyIds: true, contentBodies: true, summary: true });
      if (!facts.historyIds || !facts.contentBodies || !facts.summary || !sameBinding(facts.binding, local.binding)
        || await runtimeDataSetFileState(local.binding.paths.databasePath) !== files) {
        throw new CleanupRefusal('暂时无法核对：所在历史库在读取期间有变化，稍后再试');
      }
      return { ids: facts.historyIds, bodies: facts.contentBodies, projectNames: facts.summary.projectNames };
    }));
  if (!cached?.bodies) await cache.write(subject, files, local.binding, read.ids, { bodies: read.bodies, projectNames: read.projectNames ?? [] });
  local.facts = {
    files,
    conversations: new Set(read.ids.conversations),
    messageRevisions: new Set(read.ids.messageRevisions),
    records: new Map(Object.entries(read.ids.records).map(([domain, ids]) => [domain, new Set(ids)])),
    visible: new Map(read.ids.visibleMessages.map(([message, , revision]) => [message, revision])),
    contents: new Map(read.bodies.map(([id, key, length]) => [id, [key, length] as const])),
    projectNames: read.projectNames ?? []
  };
  return local.facts;
}

/** Read (and so named) before its backups are listed; a data set that cannot be read keeps its fallback name. */
async function nameLocal(local: LocalDataSet | undefined, cache: CoverageCache, databaseFiles: DatabaseFiles): Promise<void> {
  if (local && !local.current) await localFacts(local, cache, databaseFiles).catch(() => undefined);
}

/**
 * A data set as the history management names it (dataSetLabel): 当前库, or 历史库 with its project
 * names, or 旧工作区历史 / 默认历史库 when it has none (or they could not be read).
 */
function localName(local: LocalDataSet): string {
  if (local.current) return CURRENT_LABEL;
  const names = local.facts?.projectNames ?? [];
  return `历史库“${names.length > 0 ? names.join('、') : local.candidate.source === 'workspace' ? '旧工作区历史' : '默认历史库'}”`;
}

/**
 * Non-authoritative history (see RuntimeDataSetHistoryIds) by exact file state in
 * `.limcode-runtime-merges/coverage/`, gzip-compressed JSON: a copy's ids (its bodies only by id, they
 * are checked in the proving data set), and for a local data set also where each of its bodies is
 * stored and its project names. A changed file (any rewrite, copy or restore changes its state) is
 * simply read again.
 */
class CoverageCache {
  private readonly directory: string;
  private readonly used = new Set<string>();

  public constructor(private readonly configurationRootPath: string) {
    this.directory = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: configurationRootPath }), COVERAGE_DIRECTORY);
  }

  public async backupIds(databasePath: string, binding: HistoricalRootBinding): Promise<RuntimeDataSetHistoryIds> {
    const subject = backupSubject(this.configurationRootPath, path.dirname(databasePath));
    const files = await runtimeDataSetFileState(databasePath);
    const cached = await this.read(subject, files, binding);
    if (cached) return cached.ids;
    const read = await readRuntimeBackupFacts({ configurationRootPath: this.configurationRootPath, databasePath, binding }, { historyIds: true });
    if (!read.facts.historyIds) throw new Error('备份的对话清单没有读出来');
    if (read.files === files) await this.write(subject, files, binding, read.facts.historyIds);
    return read.facts.historyIds;
  }

  public async read(
    subject: string,
    files: string,
    binding: HistoricalRootBinding
  ): Promise<{ ids: RuntimeDataSetHistoryIds; bodies?: RuntimeDataSetContentBodies; projectNames?: string[] } | undefined> {
    this.used.add(this.fileName(subject));
    try {
      await assertNoSymbolicPrefix(this.configurationRootPath, this.directory);
      const file = path.join(this.directory, this.fileName(subject));
      if (!(await fs.lstat(file)).isFile()) return undefined;
      const value = JSON.parse((await gunzipAsync(await fs.readFile(file))).toString('utf8')) as Record<string, unknown> | null;
      if (value?.kind !== COVERAGE_KIND || value.subject !== subject || value.files !== files
        || value.identity !== identityWithGeneration(binding)) return undefined;
      const ids = value.ids as Partial<RuntimeDataSetHistoryIds> | undefined;
      const records = ids?.records;
      if (!ids || !isTextArray(ids.conversations) || !isTextArray(ids.messageRevisions)
        || !records || typeof records !== 'object' || Array.isArray(records)
        || !RUNTIME_HISTORY_RECORD_DOMAINS.every((domain) => isTextArray(records[domain.key]))
        || !isTextTuples(ids.visibleMessages, 3) || !isTextArray(ids.contents)
        || (value.bodies !== undefined && !isTextTuples(value.bodies, 3))
        || (value.projectNames !== undefined && !isTextArray(value.projectNames))) return undefined;
      return {
        ids: ids as RuntimeDataSetHistoryIds,
        ...(value.bodies !== undefined ? { bodies: value.bodies as RuntimeDataSetContentBodies } : {}),
        ...(value.projectNames !== undefined ? { projectNames: value.projectNames } : {})
      };
    } catch {
      return undefined;
    }
  }

  public async write(
    subject: string,
    files: string,
    binding: HistoricalRootBinding,
    ids: RuntimeDataSetHistoryIds,
    local?: { bodies: RuntimeDataSetContentBodies; projectNames: readonly string[] }
  ): Promise<void> {
    const file = path.join(this.directory, this.fileName(subject));
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await assertNoSymbolicPrefix(this.configurationRootPath, this.directory);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const compressed = await gzipAsync(Buffer.from(`${JSON.stringify({
        kind: COVERAGE_KIND, subject, files, identity: identityWithGeneration(binding), ids,
        ...(local ? { bodies: local.bodies, projectNames: local.projectNames } : {})
      })}\n`, 'utf8'));
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(compressed);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      await syncDirectoryDurably(this.directory);
    } catch {
      // Only a cache: the next check reads the copy again.
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  public async remove(subject: string): Promise<void> {
    await fs.rm(path.join(this.directory, this.fileName(subject)), { force: true }).catch(() => undefined);
  }

  /** After a complete listing: entries of copies and data sets that were not looked at are gone (and any other file of an earlier format). */
  public async prune(): Promise<void> {
    try {
      await assertNoSymbolicPrefix(this.configurationRootPath, this.directory);
      for (const name of await readDirectoryNames(this.directory)) {
        if (/\.json(?:\.gz)?$/.test(name) && !this.used.has(name)) await fs.rm(path.join(this.directory, name), { force: true });
      }
    } catch {
      // Only a cache.
    }
  }

  private fileName(subject: string): string {
    return `${createHash('sha256').update(subject).digest('hex').slice(0, 32)}.json.gz`;
  }
}

// ---------------------------------------------------------------------------------------------
// Listed only

/**
 * The old-format backups/ of a control root, and what the archives directory of its scope holds
 * that is not foreign history (`handled`: a name no archive has, or a directory that cannot be read).
 */
async function listKeptBackups(configurationRootPath: string, root: ControlRoot, handled: ReadonlySet<string>): Promise<RuntimeBackupCleanupItem[]> {
  const items: RuntimeBackupCleanupItem[] = [];
  const legacy = path.join(root.controlRootPath, CUTOVER_BACKUPS_DIRECTORY);
  if (await lstatOrUndefined(legacy)) {
    items.push(await keptItem(configurationRootPath, configurationRootPath, 'legacy-cutover', legacy, root.candidateId,
      '旧格式备份（升级到 SQLite 内核之前的数据），从未导入；本版本只列出，不删除'));
  }
  const archives = path.join(root.scopeRootPath, RESET_ARCHIVES_DIRECTORY);
  if (handled.has(comparable(archives))) return items;
  const info = await lstatOrUndefined(archives);
  if (info?.isDirectory() && await noSymbolicPath(configurationRootPath, archives)) {
    for (const name of (await readDirectoryNames(archives)).sort()) {
      const entry = path.join(archives, name);
      // A leftover of an interrupted cleanup is settled, not listed; an archive is foreign history.
      const base = DELETING_NAME.exec(name)?.[1];
      if (handled.has(comparable(entry)) || (base && ARCHIVE_NAME.test(base))) continue;
      items.push(await keptItem(configurationRootPath, configurationRootPath, 'reset-archive', entry, root.candidateId, ARCHIVE_NAME.test(name)
        ? '“归档并重置”的归档，这次没能作为外来历史库核对，保留'
        : '归档目录里不是“归档并重置”留下的归档（名字不认识）；只列出，不删除'));
    }
  } else if (info) {
    items.push(await keptItem(configurationRootPath, configurationRootPath, 'reset-archive', archives, root.candidateId,
      '“归档并重置”的归档目录是符号链接或不是目录，不跟随；只列出，不删除'));
  }
  return items;
}

/** .limcode-data-backups, and the directories beside the data directory that are no copied directory of foreign history. */
async function listConfigurationLevelBackups(configurationRootPath: string, copiedDirectories: ReadonlySet<string>): Promise<RuntimeBackupCleanupItem[]> {
  const items: RuntimeBackupCleanupItem[] = [];
  const dataBackups = path.join(configurationRootPath, DATA_ROOT_BACKUPS_DIR);
  if (await lstatOrUndefined(dataBackups)) {
    items.push(await keptItem(configurationRootPath, configurationRootPath, 'data-backups', dataBackups, undefined,
      '旧版本开发数据的重置备份；本版本只列出，不删除'));
  }
  const parent = path.dirname(configurationRootPath);
  const prefix = `${path.basename(configurationRootPath)}${COPIED_ASIDE_MARKER}`;
  for (const name of (await readDirectoryNames(parent)).filter((entry) => entry.startsWith(prefix)).sort()) {
    if (copiedDirectories.has(comparable(path.join(parent, name)))) continue;
    // Only the entry itself is checked for a link: the data directory's parent is not LimCode's.
    items.push(await keptItem(configurationRootPath, path.join(parent, name), 'copied-data-root', path.join(parent, name), undefined,
      '名字像迁移时挪到旁边的拷来目录，但不完全符合它的命名规则，不当作外来历史库；只列出，不删除'));
  }
  return items;
}

/**
 * A listed-only item; nothing is read through a symbolic link on its path from `containerRoot` on
 * (such an item is not measured).
 */
async function keptItem(
  configurationRootPath: string,
  containerRoot: string,
  kind: RuntimeBackupKind,
  itemPath: string,
  candidateId: string | undefined,
  reason: string,
  /** Parts listed as items of their own: not measured here. */
  exclude: readonly string[] = []
): Promise<RuntimeBackupCleanupItem> {
  const linkFree = await noSymbolicPath(containerRoot, itemPath);
  const tree = linkFree ? await describeTree(itemPath, exclude).catch(() => undefined) : undefined;
  const createdAt = utcSlugTime(path.basename(itemPath).split(COPIED_ASIDE_MARKER).pop() ?? '');
  return {
    key: itemKey(kind, configurationRootPath, itemPath), kind, name: path.basename(itemPath), path: itemPath,
    ...(candidateId ? { dataSetCandidateId: candidateId } : {}), inCurrentDataSet: false,
    bytes: (tree?.bytes ?? 0n).toString(), reclaimableBytes: (tree?.reclaimableBytes ?? 0n).toString(),
    fileCount: tree?.fileCount ?? 0,
    ...(createdAt !== undefined ? { createdAt: new Date(createdAt).toISOString() } : {}),
    deletable: false,
    reason: !linkFree ? `${reason}（路径里有符号链接，没有跟随，也没有统计大小）`
      : tree?.symbolicLink ? `${reason}（其中有符号链接，没有跟随）` : reason
  };
}

// ---------------------------------------------------------------------------------------------
// Deleting

/**
 * The rename hides the copy. Its coverage is then checked once more (deleting a Conversation takes
 * no claim); only a copy still covered is marked verified (a file inside it naming the renamed
 * directory and this configuration root) and removed. A copy no longer covered, or one whose check or
 * mark failed, gets its name back and is reported kept; when even that fails it keeps the `.deleting-`
 * name without a valid mark, and the next cleanup gives it its name back instead of deleting it. A
 * failure after the mark reports the copy as not removed completely (the next cleanup finishes it),
 * never as kept.
 */
async function removeBackupDirectory(directory: string, hooks: RenameHooks & { afterVerify(): Promise<void> | void }): Promise<RemovalOutcome> {
  const marked = await renameAndMark(directory, hooks);
  if (marked.state !== 'marked') return marked;
  try {
    await hooks.afterVerify();
  } catch (error) {
    return unfinishedRemoval(marked.deleting, error);
  }
  return removeMarked(marked.deleting);
}

interface RenameHooks {
  configurationRootPath: string;
  afterRename(): Promise<void> | void;
  /** Checked on the renamed directory (its path is given). */
  stillCovered(deleting: string): Promise<string | undefined>;
  /** More for the verified mark (a foreign root's id: the claim its leftover is settled under). */
  mark?: Readonly<Record<string, string>>;
}

/** Renamed, checked once more and marked verified (durably); anything short of that gets the name back. */
async function renameAndMark(directory: string, hooks: RenameHooks): Promise<{ state: 'marked'; deleting: string } | RemovalOutcome> {
  const parent = path.dirname(directory);
  const deleting = `${directory}${DELETING_MARKER}${randomBytes(8).toString('hex')}`;
  try {
    await fs.rename(directory, deleting);
  } catch (error) {
    return { state: 'kept', reason: '没有删除：改名失败', detail: errorMessage(error) };
  }
  let refusal: { reason: string; detail?: string } | undefined;
  try {
    // Not final yet whether the rename is durable: nothing is deleted before the mark is.
    await syncDirectoryDurably(parent).catch(() => undefined);
    await hooks.afterRename();
    const uncovered = await hooks.stillCovered(deleting);
    if (uncovered) refusal = { reason: uncovered };
    else await writeVerifiedMark(deleting, hooks.configurationRootPath, hooks.mark);
  } catch (error) {
    refusal = { reason: '改名之后没能再次核对', detail: errorMessage(error) };
  }
  if (!refusal) return { state: 'marked', deleting };
  await fs.rm(path.join(deleting, VERIFIED_MARKER_FILE), { force: true }).catch(() => undefined);
  try {
    await fs.rename(deleting, directory);
  } catch (error) {
    return {
      state: 'kept',
      reason: `${refusal.reason}；没能改回原名，现在名为 ${path.basename(deleting)}，下次检查时会改回原名，不会删除`,
      detail: [refusal.detail, errorMessage(error)].filter(Boolean).join('; ')
    };
  }
  await syncDirectoryDurably(parent).catch(() => undefined);
  return { state: 'kept', reason: `${refusal.reason}，已改回原名，保留`, ...(refusal.detail ? { detail: refusal.detail } : {}) };
}

/** A marked directory removed; a failure leaves a verified leftover the next cleanup finishes. */
async function removeMarked(deleting: string): Promise<RemovalOutcome> {
  try {
    await removeVerifiedDirectory(deleting);
  } catch (error) {
    return unfinishedRemoval(deleting, error);
  }
  // Gone; were the removal lost to a crash, the verified leftover is removed by the next cleanup.
  await syncDirectoryDurably(path.dirname(deleting)).catch(() => undefined);
  return { state: 'deleted' };
}

function unfinishedRemoval(deleting: string, error: unknown): RemovalOutcome {
  return {
    state: 'unfinished',
    reason: `已核对并改名为 ${path.basename(deleting)}，但没有删完；下次清理备份时会删完`,
    detail: errorMessage(error)
  };
}

/**
 * The mark names the renamed directory, this configuration root and its cleanup identity: a mark
 * left inside a copy that got its name back never counts, nor does one written for another
 * configuration root (a copied directory, another installation or machine).
 */
async function writeVerifiedMark(directory: string, configurationRootPath: string, extra: Readonly<Record<string, string>> = {}): Promise<void> {
  const identity = await cleanupIdentity(configurationRootPath, true);
  const file = path.join(directory, VERIFIED_MARKER_FILE);
  // A stale mark (or anything else of that name, never followed) goes first; the new one is created exclusively.
  await fs.rm(file, { force: true });
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      ...extra, kind: VERIFIED_MARKER_KIND, name: path.basename(directory),
      configurationRoot: path.resolve(configurationRootPath), cleanupIdentity: identity
    })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryDurably(directory);
}

/**
 * The mark goes last: a removal that fails halfway stays a verified leftover, finished by the next
 * cleanup. Only a real directory is removed: a link put in its place is never followed.
 */
async function removeVerifiedDirectory(directory: string): Promise<void> {
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error(`Not a directory (a link or a file was put in its place): ${directory}`);
  for (const name of await fs.readdir(directory)) {
    if (name === VERIFIED_MARKER_FILE) continue;
    await fs.rm(path.join(directory, name), { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
  }
  await fs.rm(path.join(directory, VERIFIED_MARKER_FILE), { force: true });
  await fs.rmdir(directory);
}

/**
 * The mark of this very directory (it names it), with what it records: `ours` when this installation
 * wrote it, from this configuration root (its path and cleanup identity) or from a data directory it
 * left (`previousDataRootPaths`, globalStatus): a mark naming that directory counts when its cleanup
 * identity is still the one there, or when that directory's bookkeeping is gone with its last data set
 * (deleting the old directory removes it). Any other mark proves nothing here (a copied directory,
 * another installation or machine at the same path). Throws when the mark or an identity cannot be
 * read now: undecided, the leftover is neither removed nor given its name back this time.
 */
async function readVerifiedMark(
  directory: string,
  configurationRootPath: string,
  read: TextReader = readLocalText,
  previousDataRootPaths: readonly string[] = []
): Promise<{ foreignId?: string; ours: boolean } | undefined> {
  const file = path.join(directory, VERIFIED_MARKER_FILE);
  const info = await lstatOrUndefined(file);
  if (!info?.isFile() || info.size > MAX_VERIFIED_MARK_BYTES) return undefined;
  let value: { kind?: unknown; name?: unknown; foreignId?: unknown; configurationRoot?: unknown; cleanupIdentity?: unknown } | null;
  const text = await read(file);
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    return undefined;
  }
  if (value?.kind !== VERIFIED_MARKER_KIND || value.name !== path.basename(directory)) return undefined;
  const foreignId = typeof value.foreignId === 'string' ? { foreignId: value.foreignId } : {};
  if (typeof value.configurationRoot !== 'string' || typeof value.cleanupIdentity !== 'string') return { ...foreignId, ours: false };
  const written = comparable(path.resolve(value.configurationRoot));
  if (written === comparable(path.resolve(configurationRootPath))) {
    return { ...foreignId, ours: await cleanupIdentity(configurationRootPath, false) === value.cleanupIdentity };
  }
  const previous = previousDataRootPaths.find((root) => comparable(path.resolve(root)) === written);
  if (!previous) return { ...foreignId, ours: false };
  const there = await readCleanupIdentity(path.resolve(previous));
  return { ...foreignId, ours: there === undefined || there === value.cleanupIdentity };
}

/** A verified mark is a few hundred bytes: anything larger is no mark of this cleanup. */
const MAX_VERIFIED_MARK_BYTES = 64 * 1024;

/**
 * This configuration root's identity for verified marks: a random token in its merge ledger root,
 * created (exclusively, durably) with the first mark. A copy of the directory carries the token, but
 * not the path; another installation or machine at the same path has another token.
 */
async function cleanupIdentity(configurationRootPath: string, create: boolean): Promise<string | undefined> {
  const directory = resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: configurationRootPath });
  const file = path.join(directory, CLEANUP_IDENTITY_FILE);
  const read = async (): Promise<string | undefined> => {
    const token = await readCleanupIdentity(configurationRootPath);
    return token === null ? undefined : token;
  };
  const existing = await read();
  if (existing || !create) return existing;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ kind: CLEANUP_IDENTITY_KIND, token })}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectoryDurably(directory);
    return token;
  } catch (error) {
    // Another window created it first: that one counts.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const written = await read();
    if (!written) throw new Error('清理备份的身份记录无法读取');
    return written;
  }
}

/**
 * The cleanup identity recorded in a configuration root: its token, undefined when there is no record
 * (never written, or removed with the directory's bookkeeping), null when the file there is no
 * identity record (it matches no mark). Throws when it cannot be read now (or a link is in its path).
 */
async function readCleanupIdentity(configurationRootPath: string): Promise<string | null | undefined> {
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: configurationRootPath }), CLEANUP_IDENTITY_FILE);
  await assertNoSymbolicPrefix(configurationRootPath, file);
  let text: string;
  try {
    if (!(await fs.lstat(file)).isFile()) return null;
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(text) as { kind?: unknown; token?: unknown } | null;
    return value?.kind === CLEANUP_IDENTITY_KIND && typeof value.token === 'string' && /^[0-9a-f-]{36}$/.test(value.token) ? value.token : null;
  } catch {
    return null;
  }
}

/**
 * The foreign claim of `id`, taken without waiting inside the configuration admission: `decide`
 * runs under both; the admission is released as soon as it returns, and its `after` (the removal of
 * a verified directory, however long) runs under the foreign claim alone. Lock order stays admission,
 * then claim; nothing is taken while only the claim is held.
 */
async function withForeignClaimReleasingAdmission<T>(
  configurationRootPath: string,
  id: string,
  rootPointerPath: string,
  activity: RuntimeMaintenanceActivity,
  decide: () => Promise<{ value: T; after?: () => Promise<T> }>
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  let decided!: () => void;
  const decision = new Promise<void>((resolve) => { decided = resolve; });
  let claimed: Promise<{ acquired: true; value: T } | { acquired: false }> | undefined;
  await withRuntimeDataRootAdmission(configurationRootPath, () => withRuntimeMaintenanceActivity(activity, async () => {
    claimed = tryWithForeignRuntimeRootClaim(configurationRootPath, id, rootPointerPath, async () => {
      let step: { value: T; after?: () => Promise<T> };
      try {
        step = await withRuntimeMaintenanceActivity(activity, decide);
      } finally {
        decided();
      }
      return step.after ? step.after() : step.value;
    });
    await Promise.race([decision, claimed.then(() => undefined, () => undefined)]);
  }));
  return claimed!;
}

/**
 * `.deleting-*` leftovers of an interrupted cleanup, under the same claims as a deletion: one this
 * configuration root verified is removed; any other gets its name back and is checked again. A
 * foreign root's leftover is found where discovery would find the root under its name, and settled
 * under the admission and that root's foreign claim (the id its mark records, else the one discovery
 * gives it from its pointer), taken without waiting; a verified one is removed after the admission
 * is released, under the claim alone.
 */
async function settleInterruptedDeletions(
  configurationRootPath: string,
  roots: readonly ControlRoot[],
  problem: (text: string, error?: unknown) => void,
  context: { previousDataRootPaths?: readonly string[]; databaseFiles: DatabaseFiles }
): Promise<{ finished: string[]; restored: string[] }> {
  const finished: string[] = [];
  const restored: string[] = [];
  const previous = context.previousDataRootPaths ?? [];
  const pending: Array<{ root: ControlRoot; leftovers: Array<{ path: string; original: string }> }> = [];
  for (const root of roots) {
    const leftovers: Array<{ path: string; original: string }> = [];
    try {
      for (const kind of LOCAL_BACKUP_KINDS) {
        const directory = path.join(root.controlRootPath, DELETABLE_DIRECTORIES[kind]);
        for (const name of await readDirectoryNames(directory)) {
          const base = DELETING_NAME.exec(name)?.[1];
          if (base && (kind === 'epoch-migration' ? EPOCH_BACKUP_NAME.test(base) : MERGE_BACKUP_NAME.test(base))) {
            leftovers.push({ path: path.join(directory, name), original: path.join(directory, base) });
          }
        }
      }
    } catch (error) {
      problem(`${root.controlRootPath} 里上次没有删完的备份没有全部找到，下次检查时再试。`, error);
    }
    if (leftovers.length > 0) pending.push({ root, leftovers });
  }
  let foreign: Awaited<ReturnType<typeof listRenamedForeignRuntimeRoots>> = [];
  try {
    foreign = await listRenamedForeignRuntimeRoots({
      configurationRootPath, ...(context.previousDataRootPaths?.length ? { previousDataRootPaths: context.previousDataRootPaths } : {})
    }, DELETING_NAME);
  } catch (error) {
    problem('外来历史库里上次没有删完的目录没有全部找到，下次检查时再试。', error);
  }
  const record = (outcome: 'finished' | 'restored' | undefined, leftover: { path: string; original: string }) => {
    if (outcome === 'finished') finished.push(leftover.path);
    else if (outcome === 'restored') restored.push(leftover.original);
  };
  const stage = '正在收尾上次没有删完的备份';
  if (pending.length > 0) {
    await withRuntimeDataRootAdmission(configurationRootPath, () => withRuntimeMaintenanceActivity({ ...ACTIVITY, stage }, async (admission) => {
      for (const { root, leftovers } of pending) {
        await withRuntimeMaintenance(root.paths, () => withRuntimeMaintenanceActivity({ ...ACTIVITY, stage }, async () => {
          for (const leftover of leftovers) {
            const decision = await decideLeftover(leftover, configurationRootPath, configurationRootPath, readLocalText, problem, previous);
            record(decision === 'verified' ? await finishLeftover(leftover, problem) : decision, leftover);
          }
        }));
        // Leaving a claim also took the marker out of the admission: publish it again.
        admission.report(`${stage}（${path.basename(root.controlRootPath)}）`);
      }
    }));
  }
  if (foreign.length === 0) return { finished, restored };
  const held = await heldFiles(configurationRootPath, context.databaseFiles);
  const read: TextReader = async (file) => (await readLocatedRuntimeFile(file, held, MAX_FOREIGN_RECORD_BYTES)).toString('utf8');
  for (const leftover of foreign) {
    const name = path.basename(leftover.path);
    const entry = { path: leftover.path, original: leftover.originalPath };
    try {
      if (!(await lstatOrUndefined(leftover.path))?.isDirectory()) {
        if (await lstatOrUndefined(leftover.path)) problem(`上次没有删完的 ${name} 不是普通目录，没有处理。`);
        continue;
      }
      const mark = await readVerifiedMark(leftover.path, configurationRootPath, read, previous);
      const id = (mark?.ours ? mark.foreignId : undefined)
        ?? foreignRuntimeHistoryId(leftover.location, await leftoverIdentity(leftover.path, read));
      const settled = await withForeignClaimReleasingAdmission<'finished' | 'restored' | undefined>(configurationRootPath, id,
        path.join(leftover.originalPath, ROOT_BINDING_POINTER_FILE), { ...ACTIVITY, stage: '正在收尾上次没有删完的外来历史库' }, async () => {
          const decision = await decideLeftover(entry, path.dirname(leftover.path), configurationRootPath, read, problem, previous);
          return decision === 'verified' ? { value: undefined, after: () => finishLeftover(entry, problem) } : { value: decision };
        });
      if (!settled.acquired) {
        problem(`上次没有删完的 ${name} ${FOREIGN_BUSY}，这次没有处理，下次检查时再试。`);
        continue;
      }
      record(settled.value, entry);
    } catch (error) {
      problem(`上次没有删完的 ${name} 这次没有处理完，保留，下次检查时再试。`, error);
    }
  }
  return { finished, restored };
}

/**
 * One leftover (reached without links from `root`): 'verified' when this installation marked it (see
 * readVerifiedMark; then finishLeftover removes it, it never gets its name back half removed);
 * otherwise it gets its name back ('restored') unless that name is taken again, or its mark cannot be
 * read now (undefined, reported: next time).
 */
async function decideLeftover(
  leftover: { path: string; original: string },
  root: string,
  configurationRootPath: string,
  read: TextReader,
  problem: (text: string, error?: unknown) => void,
  previousDataRootPaths: readonly string[]
): Promise<'verified' | 'restored' | undefined> {
  const name = path.basename(leftover.path);
  try {
    const info = await lstatOrUndefined(leftover.path);
    if (!info) return undefined;
    if (!info.isDirectory() || !await noSymbolicPath(root, leftover.path)) {
      problem(`上次没有删完的 ${name} 不是普通目录，没有处理。`);
      return undefined;
    }
    if ((await readVerifiedMark(leftover.path, configurationRootPath, read, previousDataRootPaths))?.ours) return 'verified';
    if (await lstatOrUndefined(leftover.original)) {
      problem(`上次没有删完的 ${name} 没有核对完，原来的名字已被占用，没有改回，也没有删除。`);
      return undefined;
    }
    await fs.rm(path.join(leftover.path, VERIFIED_MARKER_FILE), { force: true });
    await fs.rename(leftover.path, leftover.original);
    await syncDirectoryDurably(path.dirname(leftover.path)).catch(() => undefined);
    return 'restored';
  } catch (error) {
    problem(`上次没有删完的 ${name} 这次没有处理完，保留，下次检查时再试。`, error);
    return undefined;
  }
}

async function finishLeftover(leftover: { path: string }, problem: (text: string, error?: unknown) => void): Promise<'finished' | undefined> {
  try {
    await removeVerifiedDirectory(leftover.path);
    await syncDirectoryDurably(path.dirname(leftover.path)).catch(() => undefined);
    return 'finished';
  } catch (error) {
    problem(`上次没有删完的 ${path.basename(leftover.path)} 这次没有处理完，保留，下次检查时再试。`, error);
    return undefined;
  }
}

/** The identity a renamed foreign control root's pointer names, as discovery reads it for the id. */
async function leftoverIdentity(directory: string, read: TextReader): Promise<{ dataSetId: string; rootInstanceId: string } | undefined> {
  try {
    const value = JSON.parse(await read(path.join(directory, ROOT_BINDING_POINTER_FILE))) as { dataSetId?: unknown; rootInstanceId?: unknown } | null;
    return typeof value?.dataSetId === 'string' && typeof value.rootInstanceId === 'string'
      ? { dataSetId: value.dataSetId, rootInstanceId: value.rootInstanceId } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Foreign history: archives and the data sets of copied directories (runtimeForeignHistory)

interface ForeignPlanning {
  configurationRootPath: string;
  current: RuntimeBackupCleanupCurrent;
  roots: readonly ControlRoot[];
  databaseFiles: DatabaseFiles;
  cache: CoverageCache;
  bodies: BodyCheck;
  now: number;
  report(message: string): void;
  onPlanningPoint?(point: RuntimeBackupCleanupPlanningPoint, candidateId: string): Promise<void> | void;
}

/** A backup a foreign root's control root keeps: proven together with the root, or the root stays whole. */
interface ForeignCopy {
  label: string;
  name: string;
  /** Below the control root, '/' separated (its coverage cache subject). */
  relative: string;
  databasePath: string;
  binding: HistoricalRootBinding;
}

type ForeignRead =
  | { refusal: string; detail?: string; tree?: TreeFacts }
  | {
    entry: ForeignRuntimeHistoryEntry;
    root: LocatedRuntimeRoot;
    tree: TreeFacts;
    copies: number;
    /** The history of the backups it keeps. */
    nested: RuntimeDataSetHistoryIds;
    /** A local data set other than the open one with its identity and exactly its content digest. */
    identical?: LocalDataSet;
    /** Its own history: read only when it is not identical to a local data set. */
    own?: RuntimeDataSetHistoryIds;
  };

/**
 * One item per discovered foreign root (its conclusion), and per copied directory one listed-only
 * item for everything in it that is no data set (never deleted as a whole).
 */
async function planForeignHistory(
  input: ForeignPlanning,
  found: readonly DiscoveredForeignRuntimeRoot[],
  proofs: Map<string, ForeignProof>
): Promise<RuntimeBackupCleanupItem[]> {
  if (found.length === 0) return [];
  const held = await heldFiles(input.configurationRootPath, input.databaseFiles);
  const items: RuntimeBackupCleanupItem[] = [];
  const copied = new Map<string, { path: string; units: string[]; whole?: ForeignRuntimeHistoryEntry }>();
  for (const entry of found) {
    input.report(`正在核对外来历史库 ${foreignName(entry)}…`);
    const container = entry.location.kind === 'copied' ? copiedContainer(copied, entry.location.containerPath) : undefined;
    if (!hasDataRoot(entry.location)) {
      // A directory that cannot be listed, or holds nothing recognizable: its verification says why.
      const { entry: checked } = await inspectForeignRuntimeRoot(input.configurationRootPath, entry, held);
      if (container && entry.location.dataRootRelativePath === '') {
        container.whole = checked;
        continue;
      }
      const listed = foreignListedPath(entry.location);
      container?.units.push(listed);
      items.push(foreignItem(entry, listed, await linkFreeTree(entry.location.containerPath, listed), foreignRefusal(checked)));
      continue;
    }
    const unit = foreignUnit(entry.location);
    container?.units.push(unit);
    const evaluation = await evaluateForeign(input, entry, unit, held);
    items.push(evaluation.item);
    if (evaluation.proof) proofs.set(evaluation.item.key, evaluation.proof);
  }
  for (const container of copied.values()) {
    const reason = container.units.length > 0
      ? '迁移数据目录时挪到旁边的拷来目录。其中的库在“外来历史库”一组里逐个核对，只删能证明内容已完整在本地库里的库；目录本身和其余内容（设置、规则、技能）不删除'
      : !container.whole || container.whole.code === 'foreign-history-no-runtime'
        ? `拷来目录里已经没有库；${COPIED_REST}`
        : `${bare(container.whole.reason ?? '无法读取')}；${COPIED_REST}`;
    items.push(await keptItem(input.configurationRootPath, container.path, 'copied-data-root', container.path, undefined, reason, container.units));
  }
  return items;
}

function copiedContainer(
  containers: Map<string, { path: string; units: string[]; whole?: ForeignRuntimeHistoryEntry }>,
  containerPath: string
): { path: string; units: string[]; whole?: ForeignRuntimeHistoryEntry } {
  const key = comparable(containerPath);
  let container = containers.get(key);
  if (!container) {
    container = { path: containerPath, units: [] };
    containers.set(key, container);
  }
  return container;
}

/**
 * A merge from this foreign root still to happen keeps it: one whose transaction may have committed
 * without its record (a crash; it converges from the ledger alone, but only a rolled-back one merges
 * again, from this root), and one the user asked for that has not run yet (deleting the root would
 * leave the request to fail later with nothing to merge; it is kept until merged or given up).
 */
async function foreignMergePending(configurationRootPath: string, foreignId: string): Promise<string | undefined> {
  try {
    const paths = { globalStoragePath: configurationRootPath };
    const record = (await readRuntimeDataSetMergeLedger(paths)).get(foreignId);
    if (record?.state === 'committing') return '有进行中的操作（正在提交的合并），完成之后再清理';
    if ((await readRuntimeDataSetMergeRequests(paths)).has(foreignId)) {
      return '你已请求把它合并进当前库，合并还没完成；合并完成或请求过期之后再清理';
    }
    return undefined;
  } catch {
    return '合并记录无法读取，不能确认它没有正在提交的合并或等待中的合并请求，这次不能删除';
  }
}

/**
 * Proof 1: a local data set other than the open one with its identity and exactly its content
 * digest (the digest of the open one is never computed: its files are not copied), every body in
 * that data set's CAS, and the backups it keeps covered there. Proof 2: its history and that of
 * those backups covered by one local data set (the ones with its identity first, then the open one,
 * then the others; see coverageIn). Either way a copy whose visible messages are partly deleted or
 * replaced there is deletable only when ticked knowingly (replacedMessages). Its files are read under
 * its claim, taken without waiting; a local data set's digest and facts under that data set's own
 * maintenance, never inside the foreign claim.
 */
async function evaluateForeign(
  input: ForeignPlanning,
  found: DiscoveredForeignRuntimeRoot,
  unit: string,
  held: HeldDatabaseFiles
): Promise<{ item: RuntimeBackupCleanupItem; proof?: ForeignProof }> {
  const listed = (reason: string, detail?: string, tree?: TreeFacts) => ({ item: foreignItem(found, unit, tree, reason, detail) });
  const committing = await foreignMergePending(input.configurationRootPath, found.id);
  if (committing) return listed(committing, undefined, await linkFreeTree(found.location.containerPath, unit));
  const locals = input.roots.flatMap((root) => root.local ? [root.local] : []);
  const hint = await readForeignRuntimePointerIdentity(found.location, held).catch(() => undefined);
  const twins = hint ? locals.filter((local) => sameIdentity(local.binding, hint)) : [];
  for (const twin of twins) {
    await localDigest(twin, input.databaseFiles);
    if (twin.digest) await input.onPlanningPoint?.('after-local-digest', twin.candidate.id);
  }
  let claimed: { acquired: true; value: ForeignRead } | { acquired: false };
  try {
    claimed = await tryWithForeignRuntimeRootClaim(input.configurationRootPath, found.id, foreignPointer(found.location),
      () => readForeignUnderClaim(input, found, unit, held, twins));
  } catch (error) {
    return listed('暂时无法核对它，这次不能删除，稍后再检查', errorMessage(error), await linkFreeTree(found.location.containerPath, unit));
  }
  if (!claimed.acquired) return listed(`${FOREIGN_BUSY}，这次不能删除，稍后再检查`, undefined, await linkFreeTree(found.location.containerPath, unit));
  const read = claimed.value;
  if ('refusal' in read) return listed(read.refusal, read.detail, read.tree);
  // Identical: its own rows are the twin's (only the backups it keeps are read here).
  const ids = unionIds(read.nested, read.own);
  const counted = (item: RuntimeBackupCleanupItem, coverage?: Coverage): RuntimeBackupCleanupItem => ({
    ...item, conversations: ids.conversations.length, revisions: ids.messageRevisions.length,
    missingConversations: coverage?.missingConversations ?? 0, missingRevisions: coverage?.missingRevisions ?? 0
  });
  let best: { local: LocalDataSet; coverage: Coverage } | undefined;
  let closest: { local: LocalDataSet; coverage: Coverage } | undefined;
  let failure: { reason: string; detail: string } | undefined;
  let checked = 0;
  const candidates = read.identical ? [read.identical] : [...new Set([...twins, ...locals.filter((local) => local.current), ...locals])];
  for (const local of candidates) {
    try {
      if (!local.current) {
        const facts = await localFacts(local, input.cache, input.databaseFiles);
        // The digest and the facts are read one after the other: both must be of the same files.
        if (read.identical && facts.files !== local.digest?.files) {
          throw new CleanupRefusal('暂时无法核对：所在历史库在读取期间有变化，稍后再试');
        }
      }
      const coverage = await coverageIn(local, ids, input.current, input.bodies);
      // Identical: its bodies are the twin's own, each of which must be in the twin's CAS.
      if (read.identical && !hardMissing(coverage)) coverage.missingContents += await missingOwnBodies(local, input.bodies);
      checked += 1;
      if (!hardMissing(coverage)) {
        if (!best || coverage.replaced.length < best.coverage.replaced.length) best = { local, coverage };
        if (coverage.replaced.length === 0) break;
      } else if (!closest || lessMissing(coverage, closest.coverage)) {
        closest = { local, coverage };
      }
    } catch (error) {
      failure ??= {
        reason: error instanceof CleanupRefusal ? error.message : unreadableReason(error, local.current ? CURRENT_LABEL : '所在历史库'),
        detail: errorMessage(error)
      };
    }
  }
  if (!best) {
    if (closest) {
      const others = checked > 1 ? '，也没有别的本地库完整包含它' : '';
      return { item: counted(foreignItem(found, unit, read.tree, coverageRefusal(closest.coverage, localName(closest.local), others)!), closest.coverage) };
    }
    if (failure) return listed(failure.reason, failure.detail, read.tree);
    return listed('没有可以核对的本地库，按历史保留', undefined, read.tree);
  }
  const where = localName(best.local);
  const replaced = best.coverage.replaced.length;
  const method: ForeignProof['method'] = read.identical ? 'identical' : 'coverage';
  const reason = replaced > 0 ? replacedReason(replaced, where)
    : method === 'identical'
      ? `可以删除：内容已完整在${where}里（与它身份相同、内容完全相同，正文文件也都在${read.copies > 0 ? `；它保留的 ${read.copies} 份备份也都在那里` : ''}）`
      : `可以删除：内容已完整在${where}里（其中 ${ids.conversations.length} 个对话、${ids.messageRevisions.length} 个消息版本都在，显示的消息相同，正文文件也都在${read.copies > 0 ? `，包括它保留的 ${read.copies} 份备份` : ''}）`;
  const item: RuntimeBackupCleanupItem = {
    ...counted(foreignItem(found, unit, read.tree, reason)), deletable: true, ...(replaced > 0 ? { replacedMessages: replaced } : {})
  };
  return {
    item,
    proof: {
      item, found, root: read.root, unit, tree: read.tree, method,
      ...(read.entry.contentDigest ? { contentDigest: read.entry.contentDigest } : {}),
      by: {
        candidateId: best.local.candidate.id, binding: best.local.binding, current: best.local.current, name: where,
        ...(!best.local.current && best.local.facts ? { files: best.local.facts.files } : {})
      },
      ...(best.local.current ? { recheck: recheckIds(ids) } : {}), replaced: new Set(best.coverage.replaced),
      ...(found.location.kind === 'copied' ? { copiedDirectory: found.location.containerPath } : {})
    }
  };
}

/** Bodies a local data set's own content objects lack in its CAS (identical proof: they are the copy's too). */
async function missingOwnBodies(local: LocalDataSet, bodies: BodyCheck): Promise<number> {
  let missing = 0;
  for (const [key, length] of local.facts?.contents.values() ?? []) {
    if (!await bodyPresent(local.binding.paths.casRootPath, key, length, bodies)) missing += 1;
  }
  return missing;
}

/** Under the foreign claim: not viewed, verified again, its directory described, the backups it keeps and (when needed) itself read. */
async function readForeignUnderClaim(
  input: ForeignPlanning,
  found: DiscoveredForeignRuntimeRoot,
  unit: string,
  held: HeldDatabaseFiles,
  twins: readonly LocalDataSet[]
): Promise<ForeignRead> {
  // An open read-only view reads bodies from it until it is closed (runtimeForeignHistoryViews).
  if (await liveForeignRuntimeHistoryViews(input.configurationRootPath, found.id) > 0) {
    return { refusal: `${FOREIGN_BUSY}，这次不能删除，稍后再检查`, tree: await linkFreeTree(found.location.containerPath, unit) };
  }
  const { entry, root } = await inspectForeignRuntimeRoot(input.configurationRootPath, found, held);
  if (entry.status !== 'verified' || !root) {
    return { refusal: foreignRefusal(entry), tree: await linkFreeTree(found.location.containerPath, unit) };
  }
  if (root.id !== found.id || comparable(path.dirname(root.located.rootPointerPath)) !== comparable(unit)) {
    return { refusal: '核对期间它发生了变化，这次不能删除，稍后再检查' };
  }
  let tree: TreeFacts;
  try {
    tree = await describeTree(unit, [], root.located.casRootPath);
  } catch (error) {
    return { refusal: '无法读取它的目录，按历史保留', detail: errorMessage(error) };
  }
  if (tree.symbolicLink) return { refusal: '目录里有符号链接，不跟随也不删除，整份保留', tree };
  if (tree.unsupported) return { refusal: '目录里有无法识别的文件类型，整份保留', tree };
  let content: { copies: ForeignCopy[] } | { refusal: string };
  try {
    content = await foreignUnitContent(unit, held, input.now);
  } catch (error) {
    return { refusal: '无法读取它的目录，按历史保留', detail: errorMessage(error), tree };
  }
  if ('refusal' in content) return { refusal: content.refusal, tree };
  const nested: RuntimeDataSetHistoryIds[] = [];
  for (const copy of content.copies) {
    try {
      nested.push(await foreignIds(input.cache, foreignSubject(root.id, copy.relative), root.containerRoot, copy.databasePath, copy.binding, held));
    } catch (error) {
      return { refusal: `它保留的${copy.label} ${copy.name}：${foreignReadProblem(error, '这份备份')}，整份保留`, detail: errorMessage(error), tree };
    }
  }
  const kept = unionIds(...nested);
  const identical = entry.contentDigest === undefined ? undefined : twins.find((twin) =>
    !twin.current && twin.digest?.digest === entry.contentDigest && sameIdentity(twin.binding, root.recorded));
  if (identical) return { entry, root, tree, copies: content.copies.length, nested: kept, identical };
  if (entry.unfinishedWork) {
    const count = entry.unfinishedWork.finalizable + entry.unfinishedWork.refused;
    return { refusal: `有 ${count} 项未结束的任务（旧窗口中断时留下），覆盖核对不包括它们，按历史保留`, tree };
  }
  try {
    const own = await foreignIds(input.cache, foreignSubject(root.id), root.containerRoot, root.located.databasePath, root.recorded, held);
    return { entry, root, tree, copies: content.copies.length, nested: kept, own };
  } catch (error) {
    return { refusal: `${foreignReadProblem(error, '这个外来库')}，按历史保留`, detail: errorMessage(error), tree };
  }
}

/**
 * What a foreign root's control root holds besides the data set itself: the backups it keeps (each
 * proven with it), or why it stays whole (old-format backups/, debug captures, output of a process,
 * anything unknown, an entry of another type than LimCode writes there).
 */
async function foreignUnitContent(unit: string, held: HeldDatabaseFiles, now: number): Promise<{ copies: ForeignCopy[] } | { refusal: string }> {
  const copies: ForeignCopy[] = [];
  const unknown: string[] = [];
  let legacy = false;
  for (const name of (await fs.readdir(unit)).sort()) {
    const entry = path.join(unit, name);
    const info = await fs.lstat(entry);
    if (name === VSCODE_RUNTIME_ACTIVE_DIRECTORY && info.isDirectory()) {
      const problem = await foreignDataRootProblem(entry);
      if (problem) return { refusal: problem };
      continue;
    }
    if (info.isFile() && (FOREIGN_CONTROL_ROOT_FILES.has(name) || isLimCodeTransient(name))) continue;
    if (await isClaimDirectory(entry, name, info)) continue;
    const kind = LOCAL_BACKUP_KINDS.find((candidate) => DELETABLE_DIRECTORIES[candidate] === name);
    if (kind && info.isDirectory()) {
      for (const backup of (await fs.readdir(entry)).sort()) {
        const copy = await foreignBackupCopy(unit, kind, path.join(entry, backup), held, now);
        if (typeof copy === 'string') return { refusal: copy };
        copies.push(copy);
      }
      continue;
    }
    if (name === CUTOVER_BACKUPS_DIRECTORY) legacy = true;
    else unknown.push(name);
  }
  if (legacy) return { refusal: '里面有旧格式备份 backups/（升级到 SQLite 内核之前的数据，从未导入），整份保留，可自行处理' };
  if (unknown.length > 0) {
    return { refusal: `里面有不认识的内容（${unknown.slice(0, 5).join('、')}${unknown.length > 5 ? ' 等' : ''}），整份保留，可自行处理` };
  }
  return { copies };
}

/**
 * Why a foreign data root keeps its root whole, if anything in it is more than the data set and
 * LimCode's runtime files (each of its own type): a process spool with output, diagnostics with more
 * than the diagnostic journal (debug captures, anything else), or an unknown entry.
 */
async function foreignDataRootProblem(dataRoot: string): Promise<string | undefined> {
  const unknown: string[] = [];
  for (const name of (await fs.readdir(dataRoot)).sort()) {
    const entry = path.join(dataRoot, name);
    const info = await fs.lstat(entry);
    if (info.isFile() && (FOREIGN_DATA_ROOT_FILES.has(name) || isLimCodeTransient(name))) continue;
    if (info.isDirectory() && FOREIGN_DATA_ROOT_DIRECTORIES.has(name)) continue;
    if (await isClaimDirectory(entry, name, info)) continue;
    if (name === PROCESS_SPOOL_DIRECTORY && info.isDirectory()) {
      if ((await fs.readdir(entry)).length > 0) return '里面的进程输出暂存（process-spool）还有内容，整份保留，可自行处理';
      continue;
    }
    if (name === DIAGNOSTICS_DIRECTORY && info.isDirectory()) {
      const problem = await foreignDiagnosticsProblem(entry);
      if (problem) return problem;
      continue;
    }
    unknown.push(name);
  }
  if (unknown.length > 0) {
    return `数据目录里有不认识的内容（${unknown.slice(0, 5).join('、')}${unknown.length > 5 ? ' 等' : ''}），整份保留，可自行处理`;
  }
  return undefined;
}

/**
 * diagnostics/ holds the diagnostic journal (events.jsonl and its rotated files: runtime events
 * without conversation content, which the journal itself deletes after 7 days) and debug captures a
 * person made (kept). Anything else in it keeps the root whole too.
 */
async function foreignDiagnosticsProblem(directory: string): Promise<string | undefined> {
  const unknown: string[] = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const info = await fs.lstat(path.join(directory, name));
    if (info.isFile() && DIAGNOSTIC_JOURNAL_FILE.test(name)) continue;
    if (name === DEBUG_CAPTURES_DIRECTORY && info.isDirectory()) {
      if ((await fs.readdir(path.join(directory, name))).length > 0) return '里面有调试取证（diagnostics/debug-captures），整份保留，可自行处理';
      continue;
    }
    unknown.push(name);
  }
  if (unknown.length > 0) {
    return `诊断目录里有不认识的内容（${unknown.slice(0, 5).map((name) => `diagnostics/${name}`).join('、')}${unknown.length > 5 ? ' 等' : ''}），整份保留，可自行处理`;
  }
  return undefined;
}

/**
 * A claim directory runtimeHostControl may have left (maintenance or admission, a candidate or a
 * quarantined generation), recognized by its exact name format, its type and its content (only the
 * claim record, its activity marker and the marker's temporary).
 */
async function isClaimDirectory(entry: string, name: string, info: { isDirectory(): boolean }): Promise<boolean> {
  if (!info.isDirectory() || !CLAIM_NAME.test(name)) return false;
  for (const file of await fs.readdir(entry)) {
    if (!CLAIM_FILE.test(file) || !(await fs.lstat(path.join(entry, file))).isFile()) return false;
  }
  return true;
}

/**
 * One backup a foreign control root keeps, by the rules of its kind: an upgrade backup needs its
 * exact completion record to epoch 5, 6, 7, 8 or 9 (published 3→4 ones are kept) and 7 days since the latest of its
 * times; a pre-merge or source backup its saved binding; and its directory only what its kind writes
 * (see backupContentProblem). Records are read as small regular files of the foreign root. A string
 * says why the root stays whole.
 */
async function foreignBackupCopy(
  unit: string,
  kind: DeletableKind,
  directory: string,
  held: HeldDatabaseFiles,
  now: number
): Promise<ForeignCopy | string> {
  const name = path.basename(directory);
  const label = BACKUP_LABELS[kind];
  const refuse = (problem: string) => `它保留的${label} ${name}${problem}，整份保留`;
  const content = (problem: string) => refuse(problem === BACKUP_UNFINISHED ? ` ${problem}` : `：${problem}`);
  const base = DELETING_NAME.exec(name)?.[1] ?? name;
  const info = await fs.lstat(directory);
  if (!info.isDirectory()) return refuse(' 不是目录');
  if (!(kind === 'epoch-migration' ? EPOCH_BACKUP_NAME.test(base) : MERGE_BACKUP_NAME.test(base))) return refuse(' 的名字不认识');
  const read: TextReader = async (file) => (await readLocatedRuntimeFile(file, held, MAX_FOREIGN_RECORD_BYTES)).toString('utf8');
  let databasePath: string;
  let binding: HistoricalRootBinding;
  if (kind === 'epoch-migration') {
    const completion = await readUpgradeCompletion(directory, read);
    if (typeof completion === 'string') return refuse(`：${bare(completion)}`);
    const completedAt = Math.max(completion.completedAt, backupCreatedAt(kind, base) ?? 0, completion.recordedAt);
    if (completedAt > now) return refuse('：升级完成的时间晚于现在，时间不可信');
    if (now - completedAt < RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS) {
      return refuse(`：升级完成不满 7 天，${formatLocalTime(completedAt + RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS)} 之后才可以删除`);
    }
    const problem = await backupContentProblem(directory, kind, completion.fromEpoch);
    if (problem) return content(problem);
    databasePath = path.join(directory, `limcode.epoch-${completion.fromEpoch}.sqlite`);
    binding = completion.previousBinding;
  } else {
    const problem = await backupContentProblem(directory, kind);
    if (problem) return content(problem);
    const saved = await readBindingFile(path.join(directory, ROOT_BINDING_POINTER_FILE), read);
    if (typeof saved === 'string') return refuse(`：${bare(saved)}`);
    databasePath = path.join(directory, RUNTIME_DATABASE_FILE);
    binding = saved;
  }
  if (!(await lstatOrUndefined(databasePath))?.isFile()) return refuse(' 里没有数据库文件');
  return { label, name, relative: path.relative(unit, directory).split(path.sep).join('/'), databasePath, binding };
}

/**
 * Ids of a SQLite database below a foreign container: never one whose files are a file of a
 * database this process holds (stat only), copied only by the foreign copy (dev:ino checked again,
 * state before and after) and read in the facts worker; cached by exact file state.
 */
async function foreignIds(
  cache: CoverageCache,
  subject: string,
  containerRoot: string,
  databasePath: string,
  binding: HistoricalRootBinding,
  held: HeldDatabaseFiles
): Promise<RuntimeDataSetHistoryIds> {
  if (await isHeldDatabase(databasePath, held)) {
    throw new CleanupRefusal('它和本窗口可能正在使用的数据库是同一个文件（硬链接）；为了不破坏那个库的锁，不读取它');
  }
  const files = await runtimeDataSetFileState(databasePath);
  const cached = await cache.read(subject, files, binding);
  if (cached) return cached.ids;
  const copy = await copyForeignRuntimeSqliteFiles(containerRoot, databasePath, held);
  try {
    const facts = await readRuntimeCopyFacts(copy.databasePath, binding, { historyIds: true });
    if (!facts.historyIds) throw new Error('对话清单没有读出来');
    if (copy.files === files) await cache.write(subject, files, binding, facts.historyIds);
    return facts.historyIds;
  } finally {
    await copy.remove();
  }
}

/**
 * The content digest of a local data set other than the open one, for exactly its files as they were
 * (runtimeDataSetFingerprint, shared with merges), read under its maintenance; nothing on any doubt.
 */
async function localDigest(local: LocalDataSet, databaseFiles: DatabaseFiles): Promise<void> {
  if (local.current || await hardLinkedDatabase(local.binding.paths.databasePath, databaseFiles) === CURRENT_LABEL) return;
  try {
    if (local.digest && local.digest.files === await runtimeDataSetFileState(local.binding.paths.databasePath)) return;
    await withRuntimeMaintenance(local.binding.paths, () => withRuntimeMaintenanceActivity({
      ...ACTIVITY, stage: `正在核对${local.facts ? localName(local) : '一个历史库'}`
    }, async () => {
      const files = await runtimeDataSetFileState(local.binding.paths.databasePath);
      const fingerprint = await runtimeDataSetFingerprint(local.candidate);
      if (!isReadableRuntimeDataSetFingerprint(fingerprint) || fingerprint.dataSetId !== local.binding.dataSetId
        || fingerprint.rootInstanceId !== local.binding.rootInstanceId || fingerprint.rootGeneration !== local.binding.rootGeneration
        || fingerprint.pointerRevision !== local.binding.pointerRevision
        || await runtimeDataSetFileState(local.binding.paths.databasePath) !== files) return;
      local.digest = { files, digest: fingerprint.contentDigest };
    }));
  } catch {
    // No digest: the identity proof is not available, coverage still is.
  }
}

/**
 * Under the admission and the foreign claim: no view open, located and verified again from where it
 * was found (the audit joins the claim), exactly as listed (see sameShallowTree), the proving data set
 * with the same identity and generation, and still covered (the open one by its Conversations and
 * what is visible through its reader, another one by its file state); the tree once more as the last
 * step before the rename (L7); then renamed, checked once more (coverage and tree) and marked (with
 * its id and this configuration root). The removal itself follows outside the admission.
 */
async function markForeignRoot(
  proof: ForeignProof,
  context: { configurationRootPath: string; current: RuntimeBackupCleanupCurrent; options: RuntimeBackupDeletionOptions }
): Promise<{ state: 'marked'; deleting: string } | RemovalOutcome> {
  const { configurationRootPath, current, options } = context;
  const kept = (reason: string, detail?: string): RemovalOutcome => ({ state: 'kept', reason: `${reason}；这一项没有删除`, ...(detail ? { detail } : {}) });
  if (await liveForeignRuntimeHistoryViews(configurationRootPath, proof.root.id) > 0) {
    return { state: 'kept', reason: `${FOREIGN_BUSY}，这一项没有删除` };
  }
  const committing = await foreignMergePending(configurationRootPath, proof.found.id);
  if (committing) return kept(committing);
  const { roots, databaseFiles } = await listControlRoots(configurationRootPath, current, () => undefined);
  const held = await heldFiles(configurationRootPath, databaseFiles);
  const { entry, root } = await inspectForeignRuntimeRoot(configurationRootPath, proof.found, held);
  if (entry.status !== 'verified' || !root) return kept(foreignRefusal(entry));
  if (!sameLocatedRuntimeRoot(root, proof.root)) return kept('检查之后它发生了变化，请重新检查');
  if (proof.method === 'identical' ? entry.contentDigest !== proof.contentDigest : entry.unfinishedWork !== undefined) {
    return kept('检查之后它的内容有变化，请重新检查');
  }
  if (!await sameShallowTree(proof.unit, proof.tree)) return kept('列出之后它有变化，请重新检查');
  const local = roots.find((candidate) => candidate.local?.candidate.id === proof.by.candidateId)?.local;
  if (!local || !sameBinding(local.binding, proof.by.binding) || local.current !== proof.by.current) {
    return kept('证明它的本地库在检查之后发生了变化，请重新检查');
  }
  let uncovered: string | undefined;
  try {
    uncovered = await foreignStillCovered(local, proof, current, false);
  } catch (error) {
    return kept(local.current ? '暂时无法读取当前库，稍后再试' : '暂时无法核对证明它的历史库，稍后再试', errorMessage(error));
  }
  if (uncovered) return kept(uncovered);
  try {
    await options.onFaultPoint?.('before-rename', proof.item.key);
  } catch (error) {
    return { state: 'kept', reason: '没有删除', detail: errorMessage(error) };
  }
  // The last step before the rename: nothing was written into it while its coverage was read again.
  if (!await sameShallowTree(proof.unit, proof.tree)) return kept('列出之后它有变化，请重新检查');
  return renameAndMark(proof.unit, {
    configurationRootPath,
    afterRename: () => options.onFaultPoint?.('after-rename', proof.item.key),
    stillCovered: async (deleting) => await foreignStillCovered(local, proof, current, true)
      ?? (await sameShallowTree(deleting, proof.tree) ? undefined : '改名前后它有变化，请重新检查'),
    mark: { foreignId: proof.root.id }
  });
}

/**
 * Still proven: the open data set by its Conversations and what is visible, through its reader (see
 * recheckInCurrent), another one by its file state.
 */
async function foreignStillCovered(
  local: LocalDataSet,
  proof: ForeignProof,
  current: RuntimeBackupCleanupCurrent,
  afterRename: boolean
): Promise<string | undefined> {
  if (local.current) return recheckInCurrent(current, proof.recheck, proof.replaced, '它有', afterRename);
  return await runtimeDataSetFileState(local.binding.paths.databasePath) === proof.by.files
    ? undefined : `证明它的${proof.by.name}在检查之后有改动，请重新检查`;
}

function foreignItem(
  found: DiscoveredForeignRuntimeRoot,
  itemPath: string,
  tree: TreeFacts | undefined,
  reason: string,
  detail?: string
): RuntimeBackupCleanupItem {
  const createdAt = foreignCreatedAt(found);
  return {
    key: `${FOREIGN_KEY_PREFIX}${found.id}`, kind: 'foreign-history', name: foreignName(found), path: itemPath,
    origin: foreignOrigin(found), inCurrentDataSet: false,
    bytes: (tree?.bytes ?? 0n).toString(), reclaimableBytes: (tree?.reclaimableBytes ?? 0n).toString(), fileCount: tree?.fileCount ?? 0,
    ...(createdAt !== undefined ? { createdAt: new Date(createdAt).toISOString() } : {}),
    deletable: false, reason, ...(detail ? { detail } : {})
  };
}

function foreignName(found: DiscoveredForeignRuntimeRoot): string {
  const key = found.scope.startsWith('workspace:') ? found.scope.slice('workspace:'.length).replace(/-([a-f0-9]{8})[a-f0-9]{56}$/, '-$1') : '';
  const scope = key ? ` · 工作区库 ${key}` : '';
  if (found.location.kind === 'archive') return `${found.name}${scope}`;
  return `${found.name}${scope}${found.archiveName ? ` · 归档 ${found.archiveName}` : ''}`;
}

function foreignOrigin(found: DiscoveredForeignRuntimeRoot): string {
  const workspace = found.scope.startsWith('workspace:') ? '（工作区库）' : '';
  if (found.location.kind === 'archive') {
    return found.location.side === 'previous' ? `以前的数据目录里的归档${workspace}` : `“归档并重置”的归档${workspace}`;
  }
  const beside = found.location.side === 'previous' ? '以前的数据目录旁的' : '';
  return `${beside}拷来目录里的${found.archiveName ? '归档' : '库'}${workspace}`;
}

function foreignCreatedAt(found: DiscoveredForeignRuntimeRoot): number | undefined {
  if (found.location.kind === 'archive') return utcSlugTime(found.name);
  if (found.archiveName) return utcSlugTime(found.archiveName);
  return utcSlugTime(found.location.containerName.split(COPIED_ASIDE_MARKER).pop() ?? '');
}

/** Why a foreign root that did not pass verification is kept, in its own words. */
function foreignRefusal(entry: ForeignRuntimeHistoryEntry): string {
  const reason = bare(entry.reason ?? '原因未知');
  if (entry.status === 'failed') return `未通过核验：${reason}，原样保留`;
  return reason.startsWith('暂时无法核验') ? `${reason}，这次不能删除` : `暂时无法核验：${reason}，这次不能删除`;
}

/** A reason in words (without its closing verdict) for a database of a foreign root that could not be read. */
function foreignReadProblem(error: unknown, subject: string): string {
  if (error instanceof CleanupRefusal) return bare(error.message);
  if (error instanceof ForeignRuntimeHistoryRejection) {
    const text = bare(error.message);
    return error.status === 'unavailable' && !text.startsWith('暂时无法') ? `暂时无法核对：${text}` : text;
  }
  return bare(unreadableReason(error, subject));
}

/** A reason without its closing punctuation and verdict, to be completed by the caller's. */
function bare(text: string): string {
  let result = text.trim();
  for (;;) {
    const next = result.replace(/[。.，,；;\s]+$/u, '').replace(/(?:它原样保留，不会被删除|原样保留|按历史保留|一律保留|不处理)$/u, '');
    if (next === result) return result;
    result = next;
  }
}

function hasDataRoot(location: { dataRootRelativePath: string }): boolean {
  return location.dataRootRelativePath === VSCODE_RUNTIME_ACTIVE_DIRECTORY
    || location.dataRootRelativePath.endsWith(`/${VSCODE_RUNTIME_ACTIVE_DIRECTORY}`);
}

/** The located control root of a foreign root: `<archive>`, or `.limcode-runtime`/an archive inside a copied directory. */
function foreignUnit(location: { containerPath: string; dataRootRelativePath: string }): string {
  return path.dirname(path.join(location.containerPath, ...location.dataRootRelativePath.split('/')));
}

function foreignPointer(location: { containerPath: string; dataRootRelativePath: string }): string {
  return path.join(foreignUnit(location), ROOT_BINDING_POINTER_FILE);
}

/** Where a discovered entry is listed: its control root, or the directory itself when it has no data root. */
function foreignListedPath(location: { containerPath: string; dataRootRelativePath: string }): string {
  return hasDataRoot(location)
    ? foreignUnit(location)
    : path.join(location.containerPath, ...location.dataRootRelativePath.split('/').filter(Boolean));
}

function foreignSubject(id: string, relative?: string): string {
  return `foreign:${id}${relative ? `:${relative}` : ''}`;
}

/** Files of databases this process may hold SQLite locks on (runtimeForeignHistory) and of every local data set. */
async function heldFiles(configurationRootPath: string, databaseFiles: DatabaseFiles): Promise<HeldDatabaseFiles> {
  return new Set([...await heldDatabaseFiles(configurationRootPath), ...databaseFiles.keys()]);
}

/** Whether any file of a database (main, -wal, -shm, -journal) is one of `held` (lstat only). */
async function isHeldDatabase(databasePath: string, held: HeldDatabaseFiles): Promise<boolean> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const info = await fs.lstat(`${databasePath}${suffix}`, { bigint: true }).catch(() => undefined);
    if (info && held.has(`${info.dev}:${info.ino}`)) return true;
  }
  return false;
}

/** Measured only when reached without a link from its container. */
async function linkFreeTree(containerPath: string, target: string): Promise<TreeFacts | undefined> {
  return await noSymbolicPath(containerPath, target) ? describeTree(target).catch(() => undefined) : undefined;
}

/** LimCode's atomic-write temporaries. */
function isLimCodeTransient(name: string): boolean {
  return name.endsWith('.tmp');
}

/**
 * The history of several databases together (a root and the backups it keeps). A message visible in
 * two of them with different current revisions stays twice: each version shown must still be shown.
 */
function unionIds(...parts: Array<RuntimeDataSetHistoryIds | undefined>): RuntimeDataSetHistoryIds {
  const conversations = new Set<string>();
  const messageRevisions = new Set<string>();
  const records = new Map<string, Set<string>>(RUNTIME_HISTORY_RECORD_DOMAINS.map((domain) => [domain.key, new Set<string>()]));
  const visible = new Map<string, [string, string, string]>();
  const contents = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const id of part.conversations) conversations.add(id);
    for (const id of part.messageRevisions) messageRevisions.add(id);
    for (const [domain, ids] of Object.entries(part.records)) {
      const target = records.get(domain) ?? new Set<string>();
      for (const id of ids) target.add(id);
      records.set(domain, target);
    }
    for (const entry of part.visibleMessages) visible.set(`${entry[0]}\0${entry[2]}`, [entry[0], entry[1], entry[2]]);
    for (const id of part.contents) contents.add(id);
  }
  return {
    conversations: [...conversations], messageRevisions: [...messageRevisions],
    records: Object.fromEntries([...records].map(([domain, ids]) => [domain, [...ids]])),
    visibleMessages: [...visible.values()], contents: [...contents]
  };
}

function sameIdentity(left: { dataSetId: string; rootInstanceId: string }, right: { dataSetId: string; rootInstanceId: string }): boolean {
  return left.dataSetId === right.dataSetId && left.rootInstanceId === right.rootInstanceId;
}

// ---------------------------------------------------------------------------------------------
// Filesystem helpers (never follow symbolic links)

/**
 * Every entry below `root` (never following a link), with sizes and a digest of every entry's exact
 * state. `objects` (a content store: files published once by link(), never written in place) is
 * described in `shallow` only by its directories.
 */
async function describeTree(root: string, exclude: readonly string[] = [], objects?: string): Promise<TreeFacts> {
  const skipped = new Set(exclude.map(comparable));
  const objectRoot = objects === undefined ? undefined : comparable(objects);
  const lines: string[] = [];
  const shallow: Array<readonly [string, string]> = [];
  let bytes = 0n;
  let reclaimableBytes = 0n;
  let fileCount = 0;
  let symbolicLink = false;
  let unsupported = false;
  const rootInfo = await fs.lstat(root, { bigint: true });
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const info = current === root ? rootInfo : await fs.lstat(current, { bigint: true });
    const relative = path.relative(root, current).split(path.sep).join('/');
    const state = entryState(info);
    if (info.isSymbolicLink()) {
      symbolicLink = true;
      lines.push(`l ${relative} ${state}`);
      shallow.push([relative, `l ${state}`]);
    } else if (info.isFile()) {
      fileCount += 1;
      bytes += info.size;
      if (info.nlink <= 1n) reclaimableBytes += info.size;
      lines.push(`f ${relative} ${state}`);
      if (objectRoot === undefined || !isBelow(objectRoot, comparable(current))) shallow.push([relative, `f ${state}`]);
    } else if (info.isDirectory()) {
      lines.push(`d ${relative} ${state}`);
      const names = (await fs.readdir(current)).filter((name) => !skipped.has(comparable(path.join(current, name))));
      shallow.push([relative, directoryState(info, names)]);
      for (const name of names) queue.push(path.join(current, name));
    } else {
      unsupported = true;
      lines.push(`o ${relative} ${state}`);
      shallow.push([relative, `o ${state}`]);
    }
  }
  lines.sort();
  return {
    digest: createHash('sha256').update(lines.join('\n')).digest('hex'),
    bytes, reclaimableBytes, fileCount, symbolicLink, unsupported,
    modifiedAt: Number(rootInfo.mtimeMs),
    shallow
  };
}

/**
 * The tree is still as described (M1, L7), read without a walk of its content store: every directory
 * is the same one (dev:ino) with exactly the same names in it, so nothing was added, removed,
 * renamed or replaced anywhere; every entry outside the store keeps its exact state (databases,
 * records, the backups it keeps). A content object is only compared by its name: it is published
 * once and never written in place, and no proof relies on this copy's bodies (they are checked in the
 * proving data set's CAS). The same after the rename (the root keeps its dev:ino and names).
 */
async function sameShallowTree(root: string, tree: TreeFacts): Promise<boolean> {
  try {
    for (const [relative, expected] of tree.shallow) {
      const entry = relative ? path.join(root, ...relative.split('/')) : root;
      const info = await fs.lstat(entry, { bigint: true });
      const actual = info.isDirectory() ? directoryState(info, await fs.readdir(entry))
        : `${info.isFile() ? 'f' : info.isSymbolicLink() ? 'l' : 'o'} ${entryState(info)}`;
      if (actual !== expected) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function entryState(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.nlink}`;
}

/** A directory by identity and names (not by its times, whose resolution a quick change can slip under). */
function directoryState(info: BigIntStats, names: readonly string[]): string {
  return `d ${info.dev}:${info.ino} ${createHash('sha256').update([...names].sort().join('\0')).digest('hex')}`;
}

function isBelow(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function noSymbolicPath(root: string, target: string): Promise<boolean> {
  try { await assertNoSymbolicPath(root, target); return true; }
  catch { return false; }
}

/** Like assertNoSymbolicPath, but a not-yet-created tail is allowed. */
async function assertNoSymbolicPrefix(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Backup cleanup path escapes its configuration root.');
  }
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment);
    const info = await lstatOrUndefined(current);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Backup cleanup path is a symbolic link: ${current}`);
  }
}

async function lstatOrUndefined(file: string) {
  try { return await fs.lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  try { return await fs.readdir(directory); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Identities and keys

function itemKey(kind: RuntimeBackupKind, configurationRootPath: string, itemPath: string): string {
  const base = kind === 'copied-data-root' ? path.dirname(configurationRootPath) : configurationRootPath;
  return `${kind}:${path.relative(base, itemPath).split(path.sep).join('/')}`;
}

function backupSubject(configurationRootPath: string, backupDirectory: string): string {
  return `backup:${comparable(path.relative(configurationRootPath, backupDirectory)).split(path.sep).join('/')}`;
}

function dataSetSubject(candidateId: string): string {
  return `data-set:${candidateId}`;
}

function identityKey(identity: { dataSetId: string; rootInstanceId: string }): string {
  return `${identity.dataSetId}:${identity.rootInstanceId}`;
}

function identityWithGeneration(binding: HistoricalRootBinding): string {
  return `${binding.dataSetId}:${binding.rootInstanceId}:${binding.rootGeneration}:${binding.pointerRevision}:${binding.runtimeKernelEpoch}`;
}

/** Same data set at the same place: identity and every path (platform path comparison). */
function sameDataSet(left: HistoricalRootBinding, right: HistoricalRootBinding): boolean {
  return left.dataSetId === right.dataSetId && left.rootInstanceId === right.rootInstanceId
    && (Object.keys(right.paths) as Array<keyof RuntimeRootPaths>).every((key) => comparable(left.paths[key]) === comparable(right.paths[key]))
    && Object.keys(left.paths).length === Object.keys(right.paths).length;
}

/** Same data set, generation, pointer revision and epoch. */
function sameBinding(left: HistoricalRootBinding, right: HistoricalRootBinding): boolean {
  return sameDataSet(left, right) && left.rootGeneration === right.rootGeneration
    && left.pointerRevision === right.pointerRevision && left.runtimeKernelEpoch === right.runtimeKernelEpoch;
}

function isTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

function isTextTuples(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === length && isTextArray(entry));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
