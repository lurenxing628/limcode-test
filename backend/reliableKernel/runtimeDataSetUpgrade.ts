import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RUNTIME_KERNEL_EPOCH, freezeRootBinding, type RootBinding } from './contracts';
import { assertCurrentSchema, auditDatabaseIntegrity } from './databaseSchema';
import { physicalCutoverRecoveryRequired, readPhysicalCutoverRequest } from './physicalCutover';
import { RootAuthorityError } from './rootAuthority';
import {
  migratePreviousRuntimeEpochIfRequired, previousRuntimeEpochMigrationRequired, type RuntimeEpochMigrationOptions
} from './runtimeEpochMigration';
import {
  assertRuntimeHostsOffline, runtimeHostLivenessDirectory, withRuntimeDataRootAdmission, withRuntimeMaintenance
} from './runtimeHostControl';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import {
  assertNoSymbolicPath, createRuntimeDataSetDatabaseSnapshot, requireCompleteRuntimeDataSet
} from './runtimeStorageInspection';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import {
  createVscodeRootAuthority, inspectVscodeRuntimeDataSets, resolveVscodeRuntimeDataSet,
  type VscodeRuntimeDataSetCandidate, type VscodeRuntimeDataSetInspection
} from './vscodeRootAuthority';

export interface RuntimeDataSetUpgradeInput {
  candidateId: string;
  expectedDataSetId: string;
  expectedRootInstanceId: string;
}

export interface RuntimeDataSetUpgradeResult {
  candidateId: string;
  binding: RootBinding;
  migrated: boolean;
  previousEpoch?: 3 | 4;
  backupPath?: string;
}

export interface RuntimeDataSetUpgradeFailure {
  candidateId?: string;
  stage: 'discovery' | 'upgrade';
  code: string;
  /** Includes the bounded error cause chain so a wrapped migration failure stays actionable. */
  message: string;
}

export interface RuntimeDataSetUpgradeBatchOptions {
  /** Startup already prepares the selected Runtime before registering its Host. Defaults to true. */
  excludeSelected?: boolean;
  excludeCandidateIds?: readonly string[];
  /** Stop before the next root when activation ends or its configuration root changes. */
  shouldContinue?(): boolean;
}

export interface RuntimeDataSetUpgradeBatchResult {
  results: RuntimeDataSetUpgradeResult[];
  failures: RuntimeDataSetUpgradeFailure[];
  stopped: boolean;
}

/**
 * Automatically handles recognized predecessors one at a time. Inventory is read-only; each
 * target reacquires admission and rechecks identity, releasing it before the next target so
 * normal Host registration and configuration maintenance are not blocked for the entire batch.
 */
export async function upgradeDiscoveredRuntimeDataSets(
  paths: { globalStoragePath: string },
  options: RuntimeDataSetUpgradeBatchOptions = {}
): Promise<RuntimeDataSetUpgradeBatchResult> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  const excluded = new Set(options.excludeCandidateIds ?? []);
  const report: RuntimeDataSetUpgradeBatchResult = { results: [], failures: [], stopped: false };
  const keepGoing = (): boolean => {
    if (options.shouldContinue?.() !== false) return true;
    report.stopped = true;
    return false;
  };
  if (!keepGoing()) return report;
  let inspection: VscodeRuntimeDataSetInspection;
  try { inspection = await inspectVscodeRuntimeDataSets(storagePaths); }
  catch (error) {
    report.failures.push(upgradeFailure('discovery', error));
    return report;
  }
  for (const problem of inspection.problems) {
    if (!excluded.has(problem.id)) {
      report.failures.push(upgradeFailure('discovery', new Error(problem.message), problem.id));
    }
  }
  for (const candidate of inspection.candidates) {
    if (excluded.has(candidate.id) || (options.excludeSelected !== false && candidate.selected)) continue;
    if (!keepGoing()) break;
    if (!candidate.dataSetId) continue; // An uninitialized reservation has no predecessor to upgrade.
    try {
      const authority = createVscodeRootAuthority(candidate);
      if (candidate.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) {
        // The current pointer may already have been published before its exact migration
        // journal was finalized. Do not scan ordinary current databases just to discover this.
        if (!await previousRuntimeEpochMigrationRequired(authority)) {
          try {
            await fs.lstat(authority.expectedPaths().rootPendingPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          throw new RootAuthorityError(
            'runtime-data-set-upgrade-pending-unsupported',
            '此历史库有未认证的 pending 状态，不能自动推断为旧格式升级；原数据保持不变。'
          );
        }
      } else if (candidate.runtimeKernelEpoch !== 3 && candidate.runtimeKernelEpoch !== 4) {
        throw new RootAuthorityError(
          'runtime-epoch-migration-unsupported',
          `第 ${candidate.runtimeKernelEpoch} 代运行数据没有已验证的无损升级路径；原数据保持不变。`
        );
      }
      if (!keepGoing()) break;
      report.results.push(await upgradeRuntimeDataSet(storagePaths, {
        candidateId: candidate.id,
        expectedDataSetId: candidate.dataSetId,
        expectedRootInstanceId: candidate.rootInstanceId ?? ''
      }));
    } catch (error) {
      report.failures.push(upgradeFailure('upgrade', error, candidate.id));
    }
  }
  return report;
}

/**
 * Backs up and upgrades one exact published Runtime in place. Selection and shared
 * configuration remain untouched; only this target must be offline. This command never creates
 * a Runtime, runs physical cutover, registers a Host, or resumes historical work.
 */
export async function upgradeRuntimeDataSet(
  paths: { globalStoragePath: string },
  input: RuntimeDataSetUpgradeInput,
  options: RuntimeEpochMigrationOptions = {}
): Promise<RuntimeDataSetUpgradeResult> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  const request = Object.freeze({ ...input });
  return withRuntimeDataRootAdmission(storagePaths.globalStoragePath, async () => {
    const candidate = await resolveVscodeRuntimeDataSet(storagePaths, request.candidateId);
    assertExpectedIdentity(candidate, request);
    const authority = createVscodeRootAuthority(candidate);
    return withRuntimeMaintenance(authority.expectedPaths(), async () => {
      const current = await resolveVscodeRuntimeDataSet(storagePaths, request.candidateId);
      assertExpectedIdentity(current, request);
      try {
        await assertNoSymbolicPath(current.configurationRootPath, runtimeHostLivenessDirectory(authority.expectedPaths()));
      } catch (error) {
        // A never-opened or fully cleaned offline Runtime may have no liveness directory.
        // Existing links (including dangling ones) are rejected by lstat before this branch.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await assertRuntimeHostsOffline(authority.expectedPaths());
      if (current.requiresRecovery
        || await physicalCutoverRecoveryRequired(current.runtimeScopeRootPath)
        || await readPhysicalCutoverRequest(current.runtimeScopeRootPath)) {
        throw new RootAuthorityError(
          'runtime-data-set-upgrade-cutover-required',
          '此历史库存在独立的归档或重置恢复流程，不能通过格式升级执行；原数据保持不变。'
        );
      }

      // Do not require a complete root before migration: the exact predecessor journal owns
      // recovery of valid 3→4 and 3/4→5 pending boundaries, including a committed SQLite file.
      const migration = await migratePreviousRuntimeEpochIfRequired(authority, options);
      const upgraded = await resolveVscodeRuntimeDataSet(storagePaths, request.candidateId);
      assertExpectedIdentity(upgraded, request);
      const historical = await requireCompleteRuntimeDataSet(upgraded);
      if (historical.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
        throw new RootAuthorityError(
          'runtime-epoch-migration-unsupported',
          `第 ${historical.runtimeKernelEpoch} 代运行数据没有已验证的无损升级路径；原数据保持不变。`
        );
      }
      const binding = freezeRootBinding(historical as RootBinding);
      // Validate idempotent current-epoch calls as strictly as a newly upgraded target, opening
      // only an offline copy so a validation-only command cannot create source WAL/SHM files.
      const snapshot = await createRuntimeDataSetDatabaseSnapshot(upgraded, historical);
      try {
        assertCurrentSchema(snapshot.database, binding);
        assertRuntimePhysicalSchemaFingerprint(snapshot.database, RUNTIME_DOMAIN_SCHEMAS);
        auditDatabaseIntegrity(snapshot.database);
      } finally { await snapshot.close(); }
      return {
        candidateId: request.candidateId,
        binding,
        migrated: migration?.migrated ?? false,
        ...(migration?.previousEpoch !== undefined ? { previousEpoch: migration.previousEpoch } : {}),
        ...(migration?.backupPath !== undefined ? { backupPath: migration.backupPath } : {})
      };
    });
  });
}

function assertExpectedIdentity(candidate: VscodeRuntimeDataSetCandidate, input: RuntimeDataSetUpgradeInput): void {
  if (!input.expectedDataSetId || !input.expectedRootInstanceId
    || candidate.dataSetId !== input.expectedDataSetId
    || candidate.rootInstanceId !== input.expectedRootInstanceId) {
    throw new RootAuthorityError(
      'runtime-data-set-upgrade-identity-mismatch',
      '待升级历史库的身份与本次检查结果不一致；请重新检查后重试。'
    );
  }
}

function upgradeFailure(
  stage: RuntimeDataSetUpgradeFailure['stage'], error: unknown, candidateId?: string
): RuntimeDataSetUpgradeFailure {
  const seen = new Set<unknown>();
  const messages: string[] = [];
  let current: unknown = error;
  let code: string | undefined;
  for (let depth = 0; current !== undefined && !seen.has(current) && depth < 8; depth += 1) {
    seen.add(current);
    const record = current && typeof current === 'object' ? current as Record<string, unknown> : undefined;
    if (!code && typeof record?.code === 'string') code = record.code;
    const message = typeof record?.message === 'string' ? record.message : String(current);
    if (messages[messages.length - 1] !== message) messages.push(message);
    current = record?.cause;
  }
  return {
    ...(candidateId !== undefined ? { candidateId } : {}), stage,
    code: code ?? `runtime-data-set-${stage}-failed`,
    message: messages.join(' → ') || '历史库升级失败，未获得具体错误信息。'
  };
}
