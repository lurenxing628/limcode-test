import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { inProcessSqliteDatabasePaths } from '../capabilities/filesystem/sqliteDatabaseFileGuard';
import { RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import { type HistoricalRootBinding } from './rootAuthority';
import { RuntimeDatabase } from './runtimeDatabase';
import { DOMAIN_REPOSITORIES } from './repositories';
import { runtimeDataSetFileState, runtimeDataSetFileStateBytes } from './runtimeDataSetFacts';
import { readRuntimeDataSetMergeLedger, readRuntimeDataSetMergeRecordDamage, sameRuntimeDataSetIdentity } from './runtimeDataSetMergeLedger';
import { withRuntimeDataRootAdmission, withRuntimeMaintenance, assertRuntimeHostsOffline } from './runtimeHostControl';
import { createRuntimeDataSetDatabaseSnapshot, requireCompleteRuntimeDataSet, assertNoSymbolicPath } from './runtimeStorageInspection';
import { auditRuntimeSnapshot } from './runtimeSnapshotAudit';
import { historyRepairCount, type RuntimeHistoryRepairInspection } from './runtimeHistoryRepairInspection';
import { historyRepairMarker, historyRepairWasCommitted, type RuntimeHistoryRepairInput, type RuntimeHistoryRepairResult } from './runtimeHistoryRepairTransaction';
import { sameOpenedFile } from './runtimeForeignHistory';
import { createVscodeRootAuthority, legacyWorkspaceRuntimeOwnerState, resolveVscodeRuntimeDataSet, type VscodeRuntimeDataSetCandidate } from './vscodeRootAuthority';

export const HISTORY_REPAIR_BACKUPS = 'history-repair-backups';
const JOURNAL_KIND = 'limcode-terminal-history-repair';
const MARGIN = 64 * 1024 * 1024;
type Paths = { globalStoragePath: string };
export interface RuntimeHistoryRepairTarget {
  candidateId: string;
  expectedDataSetId: string;
  expectedRootInstanceId: string;
}
export interface RuntimeHistoryRepairPlan extends RuntimeHistoryRepairInput, RuntimeHistoryRepairTarget {
  binding: HistoricalRootBinding;
  /** Exact database/WAL state at inspection, not a substitute for the transactional content fence. */
  files: string;
  previous: Array<{ backupPath: string; committed: boolean; input: RuntimeHistoryRepairInput }>;
}
export interface RuntimeHistoryRepairOutcome {
  result?: RuntimeHistoryRepairResult;
  backupPath?: string;
  /** A commit is still a commit when final journal publication or closing the instance fails. */
  warnings: string[];
}
interface Journal {
  kind: typeof JOURNAL_KIND;
  binding: HistoricalRootBinding;
  input: RuntimeHistoryRepairInput;
  state: 'prepared' | 'completed';
  result?: RuntimeHistoryRepairResult;
}

/** Source claims are held throughout: no opening a live DB, no foreign writes, no implicit upgrade. */
async function withSource<T>(paths: Paths, target: RuntimeHistoryRepairTarget,
  body: (candidate: VscodeRuntimeDataSetCandidate, binding: HistoricalRootBinding) => Promise<T>): Promise<T> {
  return withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
    const candidate = await resolveVscodeRuntimeDataSet(paths, target.candidateId);
    if (candidate.selected) throw new Error('不能在正在使用的当前库里修复历史残留；请先切换到另一个库并关闭使用这份库的窗口。');
    if (candidate.dataSetId !== target.expectedDataSetId || candidate.rootInstanceId !== target.expectedRootInstanceId) {
      throw new Error('历史库身份已经变化，请重新选择。');
    }
    if (candidate.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH || candidate.requiresRecovery) {
      throw new Error('历史库有未完成的恢复或还不是当前格式，请先完成已有升级或恢复；没有改动历史库。');
    }
    const binding = await requireCompleteRuntimeDataSet(candidate);
    return withRuntimeMaintenance(binding.paths, async () => {
      await assertRuntimeHostsOffline(binding.paths);
      if (await legacyWorkspaceRuntimeOwnerState(candidate) !== 'absent') throw new Error('旧版本窗口仍在使用这个历史库，不能修复。');
      await assertUnsharedFiles(binding.paths.databasePath);
      if ((await readRuntimeDataSetMergeRecordDamage(paths)).size > 0) throw new Error('合库账本存在不可读记录，无法排除未完成的提交，暂不修复。');
      for (const record of (await readRuntimeDataSetMergeLedger(paths)).values()) {
        if (record.state === 'committing' && (sameRuntimeDataSetIdentity(record.source, binding)
          || sameRuntimeDataSetIdentity(record.target, binding))) throw new Error('这份库涉及一次结果尚未确认的合并，请先完成合并恢复，不能改动它的证据。');
      }
      return body(candidate, binding);
    });
  });
}

/** lstat only: even opening/closing a hard link could release another worker's POSIX SQLite locks. */
async function assertUnsharedFiles(databasePath: string): Promise<void> {
  const held = inProcessSqliteDatabasePaths();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = `${databasePath}${suffix}`;
    let info;
    try { info = await fs.lstat(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.nlink !== 1n) throw new Error('历史库文件不是独立的普通文件（可能是链接），为保护原件不进行修复。');
    for (const open of held) {
      for (const openSuffix of ['', '-wal', '-shm', '-journal']) {
        const other = await fs.stat(`${open}${openSuffix}`, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (other && other.dev === info.dev && other.ino === info.ino) throw new Error('这份数据库文件已在本进程打开，不能复制或修复。');
      }
    }
  }
}

/** Only reads the original, its journals and a private snapshot. No backup, cleanup or Runtime is started. */
export async function inspectRuntimeHistoryRepair(paths: Paths, target: RuntimeHistoryRepairTarget): Promise<RuntimeHistoryRepairPlan> {
  return withSource(paths, target, async (candidate, binding) => {
    const files = await runtimeDataSetFileState(binding.paths.databasePath);
    let expected: RuntimeHistoryRepairInspection | undefined;
    const snapshot = await createRuntimeDataSetDatabaseSnapshot(candidate, binding, { beforeOpen: async (file) => {
      expected = (await auditRuntimeSnapshot(file, { binding: binding as RootBinding, historyRepair: true })).historyRepair;
    } });
    try {
      const previous = [] as RuntimeHistoryRepairPlan['previous'];
      for (const { backupPath, journal } of await journals(binding)) {
        previous.push({ backupPath, input: journal.input, committed: historyRepairWasCommitted(snapshot.database, journal.input) });
      }
      if (await runtimeDataSetFileState(binding.paths.databasePath) !== files) throw new Error('检查期间历史库发生变化，请重新检查。');
      return { ...target, repairId: randomUUID(), expected: expected!, binding, files, previous };
    } finally { await snapshot.close(); }
  });
}

export interface RuntimeHistoryRepairOptions {
  signal?: AbortSignal;
  /** Test-only fault boundaries; never executes injected SQL. */
  onFaultPoint?(point: 'before-backup' | 'after-backup' | 'before-transaction' | 'after-transaction' | 'before-completion'): void | Promise<void>;
  freeSpace?(directory: string): Promise<number>;
}

/**
 * Explicit repair, not a merge fallback. A verified, fsynced Backup API copy and durable journal
 * precede the worker's fixed, FULL transaction. Re-executing the same confirmed plan reconciles its
 * commit marker, even after a lost response or crash; it never repeats a committed repair. The
 * source remains the source: no selection change, no dispatch, no invented result, no ledger erasure.
 */
export async function repairRuntimeHistory(paths: Paths, plan: RuntimeHistoryRepairPlan,
  options: RuntimeHistoryRepairOptions = {}): Promise<RuntimeHistoryRepairOutcome> {
  const marker = historyRepairMarker(plan);
  const finished: { value?: RuntimeHistoryRepairOutcome } = {};
  try {
    return await withSource(paths, plan, async (candidate, binding) => {
      if (JSON.stringify(binding) !== JSON.stringify(plan.binding)) throw new Error('检查后的 RootBinding 已变化，请重新检查。');
      const warnings: string[] = [];
      const prior = (await journals(binding)).find(({ journal }) => journal.input.repairId === plan.repairId);
      if (prior && historyRepairMarker(prior.journal.input).key !== marker.key) throw new Error('同一次修复的计划证据不一致。');
      // Preflight stays on a private copy before opening the maintenance Runtime.
      let current: RuntimeHistoryRepairInspection | undefined;
      const copy = await createRuntimeDataSetDatabaseSnapshot(candidate, binding, { beforeOpen: async (file) => {
        current = (await auditRuntimeSnapshot(file, { binding: binding as RootBinding, historyRepair: true })).historyRepair;
      } });
      let applied: boolean;
      try { applied = historyRepairWasCommitted(copy.database, plan); }
      finally { await copy.close(); }
      const expectedResult = (alreadyApplied: boolean): RuntimeHistoryRepairResult => ({
        repairId: plan.repairId, removedOperations: plan.expected.orphanOperations,
        removedAttempts: plan.expected.orphanAttempts, restoredUnknownProcesses: plan.expected.restoredUnknownProcesses, alreadyApplied
      });
      if (applied) {
        if (!prior) throw new Error('修复已提交，但备份日志缺失；未重新修复，请保留现有数据并检查备份。');
        const result = expectedResult(true);
        await completeJournal(prior.backupPath, { ...prior.journal, state: 'completed', result }, warnings);
        return finished.value = { result, backupPath: prior.backupPath, warnings };
      }
      if (current!.contentDigest !== plan.expected.contentDigest || current!.preservedDigest !== plan.expected.preservedDigest) {
        throw new Error('历史库在检查后发生了变化，请重新检查并确认；没有进行修复。');
      }
      if (current!.refused || plan.expected.refused) throw new Error('仍有不能自动清理的依赖或非终态记录，没有进行修复。');
      if (historyRepairCount(current!) === 0) return { warnings };
      options.signal?.throwIfAborted();
      const backupParent = path.join(path.dirname(binding.paths.dataRootPath), HISTORY_REPAIR_BACKUPS);
      await assertBackupPrefix(binding, backupParent);
      const need = 2 * (runtimeDataSetFileStateBytes(await runtimeDataSetFileState(binding.paths.databasePath)) ?? 0) + MARGIN;
      const available = options.freeSpace ? await options.freeSpace(path.dirname(binding.paths.dataRootPath))
        : await fs.statfs(path.dirname(binding.paths.dataRootPath)).then((s) => Number(s.bavail) * Number(s.bsize));
      if (available < need) throw Object.assign(new Error(`磁盘空间不足：备份及修复事务预写日志至少需要约 ${Math.ceil(need / 1048576)} MiB 可用空间；没有进行修复。`), { code: 'runtime-history-repair-disk-full' });
      // A retry may use an existing verified backup only after checking that it really is this plan.
      const backupPath = prior?.backupPath ?? path.join(backupParent, `${new Date().toISOString().replace(/[:.]/g, '-')}-${plan.repairId}`);
      const input: RuntimeHistoryRepairInput = { repairId: plan.repairId, expected: plan.expected };
      const journal: Journal = { kind: JOURNAL_KIND, binding, input, state: 'prepared' };
      let runtime: RuntimeDatabase | undefined;
      let committed: RuntimeHistoryRepairResult | undefined;
      try {
        options.signal?.throwIfAborted();
        await options.onFaultPoint?.('before-backup');
        await assertUnsharedFiles(binding.paths.databasePath);
        runtime = await RuntimeDatabase.open(createVscodeRootAuthority(candidate), { maintenance: true, hostBootId: `history-repair-${plan.repairId}` });
        if (!prior) {
          await fs.mkdir(backupParent, { recursive: true, mode: 0o700 });
          await assertBackupPrefix(binding, backupParent);
          await fs.mkdir(backupPath, { mode: 0o700 });
          const backup = path.join(backupPath, 'limcode.sqlite');
          await runtime.backupTo(backup);
          const audit = await auditRuntimeSnapshot(backup, { binding: binding as RootBinding, contentDigest: true });
          if (audit.contentDigest !== plan.expected.contentDigest) throw new Error('备份内容与已确认的检查结果不一致，没有进行修复。');
          await durableJson(path.join(backupPath, 'root-binding.json'), binding);
          await durableJson(path.join(backupPath, 'repair.json'), journal);
        } else {
          const audit = await auditRuntimeSnapshot(path.join(backupPath, 'limcode.sqlite'), { binding: binding as RootBinding, contentDigest: true });
          if (audit.contentDigest !== plan.expected.contentDigest) throw new Error('原修复备份已变化，不能续修。');
        }
        // A visible prepared journal is not proof that its publish (or either parent) was
        // fsynced: an earlier attempt can have failed after rename. Re-establish the whole
        // backup durability barrier on both creation and reuse before any destructive work.
        await syncFile(path.join(backupPath, 'limcode.sqlite'));
        await syncFile(path.join(backupPath, 'root-binding.json'));
        await syncFile(path.join(backupPath, 'repair.json'));
        await syncDirectoryDurably(backupPath);
        await syncDirectoryDurably(backupParent);
        await syncDirectoryDurably(path.dirname(backupParent));
        await options.onFaultPoint?.('after-backup');
        options.signal?.throwIfAborted();
        await options.onFaultPoint?.('before-transaction');
        try {
          committed = await runtime.maintenanceRepairHistory(input);
        } catch (error) {
          // A worker response can be lost after COMMIT. The receipt, never the outside journal, is proof.
          const record = (await runtime.snapshot([DOMAIN_REPOSITORIES.domain('CommandReceipt').get(marker.id)]).catch(() => undefined))?.snapshot[0];
          if (!record || Array.isArray(record) || record.source_kind !== 'internal' || record.source_key !== marker.key) throw error;
          committed = expectedResult(true);
        }
        await options.onFaultPoint?.('after-transaction');
        await options.onFaultPoint?.('before-completion');
        await completeJournal(backupPath, { ...journal, state: 'completed', result: committed }, warnings);
        return finished.value = { result: committed, backupPath, warnings };
      } catch (error) {
        if (committed) {
          warnings.push(`修复已经提交，结果日志尚未完成：${describe(error)}；再次检查会按库内提交标记确认，不会重复修复。`);
          return finished.value = { result: committed, backupPath, warnings };
        }
        throw Object.assign(new Error(`历史残留修复没有得到提交确认：${describe(error)}。已写成的备份文件会保留，目录：${backupPath}；重新检查会确认提交结果。`), {
          code: (error as { code?: unknown } | null)?.code ?? 'runtime-history-repair-not-confirmed', cause: error
        });
      } finally {
        if (runtime) await runtime.close().catch((error) => { warnings.push(`关闭维护实例时出错：${describe(error)}`); });
      }
    });
  } catch (error) {
    if (!finished.value?.result) throw error;
    finished.value.warnings.push(`修复已提交，但释放维护声明时出错：${describe(error)}。`);
    return finished.value;
  }
}

async function completeJournal(backupPath: string, journal: Journal, warnings: string[]): Promise<void> {
  await durableJson(path.join(backupPath, 'repair.json'), journal).catch((error) => {
    warnings.push(`修复已提交，但结果日志未写完：${describe(error)}；之后按库内标记确认。`);
  });
}

async function assertBackupPrefix(binding: HistoricalRootBinding, directory: string): Promise<void> {
  try { await assertNoSymbolicPath(path.dirname(binding.paths.dataRootPath), directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function journals(binding: HistoricalRootBinding): Promise<Array<{ backupPath: string; journal: Journal }>> {
  const root = path.join(path.dirname(binding.paths.dataRootPath), HISTORY_REPAIR_BACKUPS);
  await assertBackupPrefix(binding, root);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result: Array<{ backupPath: string; journal: Journal }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T[0-9TZ-]+-[0-9a-f-]{36}$/.test(entry.name)) throw new Error('历史修复备份目录有不认识的条目，请先检查，未改动它。');
    const backupPath = path.join(root, entry.name);
    const file = path.join(backupPath, 'repair.json');
    let stat;
    try { stat = await fs.lstat(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; } // never mutated before journal exists
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 1048576n) throw new Error('历史修复日志不是普通小文件。');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let journal: Journal;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameOpenedFile(stat, opened) || opened.size !== stat.size) throw new Error('历史修复日志在读取时被替换。');
      journal = JSON.parse(await handle.readFile('utf8')) as Journal;
    }
    finally { await handle.close(); }
    if (journal.kind !== JOURNAL_KIND || !['prepared', 'completed'].includes(journal.state)
      || JSON.stringify(journal.binding) !== JSON.stringify(binding) || !entry.name.endsWith(journal.input?.repairId)) {
      throw new Error('历史修复日志身份或格式不一致，不能自动忽略。');
    }
    historyRepairMarker(journal.input);
    const backup = path.join(backupPath, 'limcode.sqlite');
    await assertNoSymbolicPath(root, backup);
    await assertUnsharedFiles(backup);
    if (!(await fs.lstat(backup)).isFile()) throw new Error('历史修复备份缺失。');
    result.push({ backupPath, journal });
  }
  return result;
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, file); await syncDirectoryDurably(path.dirname(file)); }
  finally { await fs.rm(temporary, { force: true }); }
}
function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
