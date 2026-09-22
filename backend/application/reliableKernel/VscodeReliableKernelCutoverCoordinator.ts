import { randomUUID } from 'node:crypto';
import { syncDirectoryDurably } from '../../capabilities/filesystem/durableDirectorySync';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  initializeCutoverRuntimeBinding,
  initializeEmptyRuntimeRoot
} from '../../reliableKernel/runtimeDatabase';
import {
  RootAuthority,
  RootAuthorityError,
  StaleRootBindingError,
  type HistoricalRootBinding
} from '../../reliableKernel/rootAuthority';
import {
  RUNTIME_KERNEL_EPOCH,
  type RootBinding,
  type RuntimeRootPaths
} from '../../reliableKernel/contracts';
import {
  legacyRuntimeRequiresCutover,
  performPhysicalCutover,
  physicalCutoverRecoveryRequired,
  readPhysicalCutoverRequest,
  recoverInterruptedPhysicalCutover
} from '../../reliableKernel/physicalCutover';
import {
  PREVIOUS_RUNTIME_KERNEL_EPOCH,
  migratePreviousRuntimeEpochIfRequired,
  previousRuntimeEpochMigrationRequired
} from '../../reliableKernel/runtimeEpochMigration';
import { assertRuntimeHostsOffline, withRuntimeMaintenance } from '../../reliableKernel/runtimeHostControl';
import {
  currentRuntimeManifestMigrationRequired,
  migrateCurrentRuntimeManifestIfRequired
} from '../../reliableKernel/runtimeManifestMigration';
import { assertConfigurationRootRuntimesOffline } from '../../reliableKernel/vscodeRootAuthority';

export const VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY = '.limcode-runtime-backups';

export interface VscodeReliableKernelCutoverResult {
  binding: RootBinding;
  initialized: boolean;
  cutoverPerformed: boolean;
  manifestMigrated?: boolean;
  archiveDirectoryName?: string;
  epochMigratedFrom?: number;
  epochMigrationBackupPath?: string;
  epochResetFrom?: number;
  epochResetBackupPath?: string;
}

/**
 * Final-VSIX startup gate. A legacy file Runtime is never opened or imported: an explicit drained
 * request archives it with a durable journal, filters independent configuration, and only then
 * atomically activates the current SQLite/CAS RootBinding. The exact epoch-3 predecessor is
 * upgraded offline before RuntimeDatabase opens; other incompatible epochs are archived/reset.
 *
 * The whole gate runs inside the configuration-root admission and the scope maintenance claim
 * (canonical order), so Host registration can never interleave with a root mutation. The offline
 * assertion is conditional: a current compatible root validates without it, which keeps ordinary
 * multi-host attach free of peer checks, while every create/upgrade/archive/reset/cutover
 * mutation first proves that no live or unverifiable Host remains.
 */
export class VscodeReliableKernelCutoverCoordinator {
  public constructor(
    private readonly authority: RootAuthority,
    private readonly runtimeScopeRootPath: string
  ) {}

  public async ensureCurrentRoot(): Promise<VscodeReliableKernelCutoverResult> {
    const paths = this.authority.expectedPaths();
    return this.authority.withRuntimeHostAdmission(() =>
      withRuntimeMaintenance(paths, async () => {
        const mutation = await this.requiredMutation();
        if (mutation === 'physical-cutover') {
          // Legacy placements filter/delete shared configuration outside the Runtime control
          // tree, so every Runtime root contained in this scope root must be offline — not only
          // this one. The held admission keeps the enumeration stable against new registrations.
          await assertConfigurationRootRuntimesOffline(this.runtimeScopeRootPath);
        } else if (mutation === 'runtime-root') {
          await assertRuntimeHostsOffline(paths);
        }
        return this.ensureCurrentRootInternal();
      })
    );
  }

  /**
   * Read-only classification run under both claims. The internal flow re-derives the same
   * decision before acting, so a stale answer here can only surface as the exact existing error.
   */
  private async requiredMutation(): Promise<'physical-cutover' | 'runtime-root' | undefined> {
    // A foreign or malformed pointer fences even physical-cutover preflight. Do not inspect
    // its journal/request or enumerate Hosts before the complete historical schema is checked.
    const historical = await this.authority.readHistoricalPointerForCutover();
    if (await physicalCutoverRecoveryRequired(this.runtimeScopeRootPath)) return 'physical-cutover';
    if (await readPhysicalCutoverRequest(this.runtimeScopeRootPath)) return 'physical-cutover';
    if (await previousRuntimeEpochMigrationRequired(this.authority)) return 'runtime-root';
    if (historical && historical.runtimeKernelEpoch < RUNTIME_KERNEL_EPOCH) return 'runtime-root';
    let binding: RootBinding;
    try {
      binding = await this.authority.current();
    } catch (error) {
      if (!(error instanceof RootAuthorityError) || error.code !== 'root-binding-missing') throw error;
      // A legacy root without a drained cutover request only rejects; initializing an empty root
      // is the one mutation in this branch.
      return (await legacyRuntimeRequiresCutover(this.runtimeScopeRootPath)) ? undefined : 'runtime-root';
    }
    return (await currentRuntimeManifestMigrationRequired(binding)) ? 'runtime-root' : undefined;
  }

  private async ensureCurrentRootInternal(): Promise<VscodeReliableKernelCutoverResult> {
    await this.authority.readHistoricalPointerForCutover();
    await recoverInterruptedPhysicalCutover(this.runtimeScopeRootPath, this.authority);
    const request = await readPhysicalCutoverRequest(this.runtimeScopeRootPath);
    if (request) {
      const result = await performPhysicalCutover(
        this.runtimeScopeRootPath,
        this.authority,
        initializeCutoverRuntimeBinding
      );
      return {
        binding: result.binding,
        initialized: true,
        cutoverPerformed: true,
        ...(result.archiveDirectoryName ? { archiveDirectoryName: result.archiveDirectoryName } : {})
      };
    }

    const epochMigration = await migratePreviousRuntimeEpochIfRequired(this.authority);
    if (epochMigration) {
      return {
        binding: epochMigration.binding,
        initialized: epochMigration.migrated,
        cutoverPerformed: false,
        epochMigratedFrom: PREVIOUS_RUNTIME_KERNEL_EPOCH,
        ...(epochMigration.backupPath
          ? { epochMigrationBackupPath: epochMigration.backupPath }
          : {})
      };
    }

    const historical = await this.authority.readHistoricalPointerForCutover();
    if (historical && historical.runtimeKernelEpoch < RUNTIME_KERNEL_EPOCH) {
      const reset = await archiveAndResetIncompatibleRuntime(
        this.authority,
        this.runtimeScopeRootPath,
        historical
      );
      return {
        binding: reset.binding,
        initialized: true,
        cutoverPerformed: false,
        archiveDirectoryName: reset.archiveDirectoryName,
        epochResetFrom: historical.runtimeKernelEpoch,
        epochResetBackupPath: reset.backupPath
      };
    }

    try {
      const binding = await this.authority.current();
      const manifestMigration = await migrateCurrentRuntimeManifestIfRequired(binding);
      return {
        binding,
        initialized: false,
        cutoverPerformed: false,
        ...(manifestMigration.upgraded ? { manifestMigrated: true } : {})
      };
    } catch (error) {
      if (!(error instanceof RootAuthorityError) || error.code !== 'root-binding-missing') throw error;
    }

    if (await legacyRuntimeRequiresCutover(this.runtimeScopeRootPath)) {
      throw new RootAuthorityError(
        'cutover-request-required',
        '检测到旧运行数据，但没有已完成drain的cutover request；为避免误动用户数据，拒绝启动。'
      );
    }

    try {
      return {
        binding: await initializeEmptyRuntimeRoot(this.authority),
        initialized: true,
        cutoverPerformed: false
      };
    } catch (error) {
      // Another activation can win the pointer race; only an already-complete current root is safe.
      if (error instanceof RootAuthorityError && error.code === 'root-binding-exists') {
        return {
          binding: await this.authority.current(),
          initialized: false,
          cutoverPerformed: false
        };
      }
      throw error;
    }
  }
}

interface IncompatibleRuntimeResetResult {
  binding: RootBinding;
  archiveDirectoryName: string;
  backupPath: string;
}

/**
 * Gated development-reset archive: renames the active Runtime control root into the incompatible
 * backups directory, preserving every byte for later inspection. The rename holds the
 * configuration-root admission and the scope maintenance claim and re-proves that no live or
 * unverifiable Host remains, so a reset can never archive a root out from under a running peer.
 * Callers orchestrating a reset preflight with `assertRuntimeHostsOffline(paths, ownHostBootId)`
 * before shutting their own product down; this recheck without an exception is the post-shutdown
 * fence. Returns `archived: false` when the control root is already absent.
 */
export async function archiveCurrentRuntimeRootForReset(
  authority: RootAuthority,
  runtimeScopeRootPathInput: string
): Promise<{ archived: boolean; backupPath?: string }> {
  const runtimeScopeRootPath = normalizedAbsolutePath(runtimeScopeRootPathInput, 'Workspace Runtime scope root');
  const paths = authority.expectedPaths();
  return authority.withRuntimeHostAdmission(() =>
    withRuntimeMaintenance(paths, async () => {
      await assertRuntimeHostsOffline(paths);
      const controlRootPath = path.dirname(paths.rootPointerPath);
      if (
        path.dirname(controlRootPath) !== runtimeScopeRootPath
        || path.dirname(paths.dataRootPath) !== controlRootPath
      ) {
        throw new RootAuthorityError(
          'runtime-epoch-reset-path-invalid',
          `Runtime epoch reset path is outside the selected Workspace scope: ${controlRootPath}`
        );
      }
      const backupRootPath = path.join(runtimeScopeRootPath, VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY);
      const backupPath = path.join(backupRootPath, `${timestampSlug()}-${randomUUID().slice(0, 8)}`);
      try {
        await fs.mkdir(backupRootPath, { recursive: true, mode: 0o700 });
        await fs.rename(controlRootPath, backupPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { archived: false };
        throw error;
      }
      await syncDirectoryDurably(backupRootPath);
      await syncDirectoryDurably(runtimeScopeRootPath);
      return { archived: true, backupPath };
    })
  );
}

async function archiveAndResetIncompatibleRuntime(
  authority: RootAuthority,
  runtimeScopeRootPathInput: string,
  historical: HistoricalRootBinding
): Promise<IncompatibleRuntimeResetResult> {
  const runtimeScopeRootPath = normalizedAbsolutePath(runtimeScopeRootPathInput, 'Workspace Runtime scope root');
  const expected = authority.expectedPaths();
  assertHistoricalBindingMatchesExpected(historical, expected);

  const controlRootPath = path.dirname(expected.rootPointerPath);
  if (
    path.dirname(controlRootPath) !== runtimeScopeRootPath
    || path.dirname(expected.dataRootPath) !== controlRootPath
  ) {
    throw new RootAuthorityError(
      'runtime-epoch-reset-path-invalid',
      `Runtime epoch reset path is outside the selected Workspace scope: ${controlRootPath}`
    );
  }

  const backupRootPath = path.join(
    runtimeScopeRootPath,
    VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY
  );
  const archiveDirectoryName = [
    timestampSlug(),
    `epoch-${historical.runtimeKernelEpoch}-to-${RUNTIME_KERNEL_EPOCH}`,
    randomUUID().slice(0, 8)
  ].join('-');
  const backupPath = path.join(backupRootPath, archiveDirectoryName);
  await fs.mkdir(backupRootPath, { recursive: true, mode: 0o700 });
  await fs.rename(controlRootPath, backupPath);
  await syncDirectoryDurably(backupRootPath);
  await syncDirectoryDurably(runtimeScopeRootPath);

  try {
    const binding = await initializeEmptyRuntimeRoot(authority);
    await syncDirectoryDurably(runtimeScopeRootPath);
    return { binding, archiveDirectoryName, backupPath };
  } catch (error) {
    const restored = await restoreArchivedRuntimeAfterFailedActivation({
      authority,
      runtimeScopeRootPath,
      controlRootPath,
      backupRootPath,
      backupPath,
      archiveDirectoryName
    }).catch((rollbackError: unknown) => {
      throw new RootAuthorityError(
        'runtime-epoch-reset-rollback-failed',
        `Runtime epoch reset failed and the archived root could not be restored: ${backupPath}`,
        combinedFailure(error, rollbackError)
      );
    });
    throw new RootAuthorityError(
      'runtime-epoch-reset-failed',
      restored
        ? `Runtime epoch reset failed; the previous Runtime root was restored: ${controlRootPath}`
        : `Runtime epoch reset did not finish cleanly; the previous Runtime root remains archived at: ${backupPath}`,
      error
    );
  }
}

async function restoreArchivedRuntimeAfterFailedActivation(input: {
  authority: RootAuthority;
  runtimeScopeRootPath: string;
  controlRootPath: string;
  backupRootPath: string;
  backupPath: string;
  archiveDirectoryName: string;
}): Promise<boolean> {
  const published = await input.authority.readHistoricalPointerForCutover();
  if (published?.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) return false;

  if (await exists(input.controlRootPath)) {
    const failedPath = path.join(
      input.backupRootPath,
      `${input.archiveDirectoryName}-failed-current-${randomUUID().slice(0, 8)}`
    );
    await fs.rename(input.controlRootPath, failedPath);
    await syncDirectoryDurably(input.backupRootPath);
  }
  await fs.rename(input.backupPath, input.controlRootPath);
  await syncDirectoryDurably(input.backupRootPath);
  await syncDirectoryDurably(input.runtimeScopeRootPath);
  return true;
}

function assertHistoricalBindingMatchesExpected(
  historical: HistoricalRootBinding,
  expected: RuntimeRootPaths
): void {
  if (!samePaths(historical.paths, expected)) {
    throw new StaleRootBindingError(
      'Historical RootBinding paths do not match the selected Workspace Runtime root.'
    );
  }
}

function samePaths(left: RuntimeRootPaths, right: RuntimeRootPaths): boolean {
  return left.dataRootPath === right.dataRootPath
    && left.databasePath === right.databasePath
    && left.casRootPath === right.casRootPath
    && left.rootPointerPath === right.rootPointerPath
    && left.rootPendingPath === right.rootPendingPath
    && left.runtimeEpochPath === right.runtimeEpochPath;
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new TypeError(`${label} must be a normalized absolute path.`);
  }
  return value;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

function combinedFailure(activationError: unknown, rollbackError: unknown): Error {
  const error = new Error('Runtime epoch activation and rollback both failed.');
  (error as Error & { causes?: readonly unknown[] }).causes = [activationError, rollbackError];
  return error;
}

function timestampSlug(): string {
  const date = new Date();
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    + `-${pad(date.getUTCMilliseconds(), 3)}`;
}
