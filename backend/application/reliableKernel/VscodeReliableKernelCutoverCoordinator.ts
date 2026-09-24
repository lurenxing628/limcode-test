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
  RootAuthorityError
} from '../../reliableKernel/rootAuthority';
import {
  RUNTIME_KERNEL_EPOCH,
  type RootBinding
} from '../../reliableKernel/contracts';
import {
  legacyRuntimeRequiresCutover,
  performPhysicalCutover,
  physicalCutoverRecoveryRequired,
  readPhysicalCutoverRequest,
  recoverInterruptedPhysicalCutover
} from '../../reliableKernel/physicalCutover';
import { assertRuntimeHostsOffline, withRuntimeMaintenance } from '../../reliableKernel/runtimeHostControl';
import { validateCurrentRuntimeSchema } from '../../reliableKernel/currentRuntimeSchemaValidation';
import {
  migratePreviousRuntimeEpochIfRequired,
  previousRuntimeEpochMigrationRequired
} from '../../reliableKernel/runtimeEpochMigration';
import { assertConfigurationRootRuntimesOffline } from '../../reliableKernel/vscodeRootAuthority';

export const VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY = '.limcode-runtime-backups';

export interface VscodeReliableKernelCutoverResult {
  binding: RootBinding;
  initialized: boolean;
  cutoverPerformed: boolean;
  archiveDirectoryName?: string;
  epochMigratedFrom?: number;
  epochMigrationBackupPath?: string;
}

/**
 * Final-VSIX startup gate. A legacy file Runtime is never opened or imported: an explicit drained
 * request archives it with a durable journal, filters independent configuration, and only then
 * atomically activates the current SQLite/CAS RootBinding. Exact published epoch-3/4 roots are
 * backed up and upgraded in place before RuntimeDatabase opens. Unsupported epochs remain intact
 * and require an explicit recovery decision; startup never silently replaces them with an empty root.
 * current-epoch schema drift is rejected without rewriting data.
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
    await validateCurrentRuntimeSchema(binding);
    return undefined;
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

    const migration = await migratePreviousRuntimeEpochIfRequired(this.authority);
    if (migration) {
      return {
        binding: migration.binding,
        initialized: false,
        cutoverPerformed: false,
        ...(migration.migrated ? {
          epochMigratedFrom: migration.previousEpoch,
          epochMigrationBackupPath: migration.backupPath
        } : {})
      };
    }

    const historical = await this.authority.readHistoricalPointerForCutover();
    if (historical && historical.runtimeKernelEpoch < RUNTIME_KERNEL_EPOCH) {
      throw new RootAuthorityError(
        'runtime-epoch-upgrade-unsupported',
        `第 ${historical.runtimeKernelEpoch} 代运行数据没有已验证的无损升级路径；原数据保持不变，拒绝自动重置。`
      );
    }

    try {
      const binding = await this.authority.current();
      await validateCurrentRuntimeSchema(binding);
      return {
        binding,
        initialized: false,
        cutoverPerformed: false
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

function normalizedAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new TypeError(`${label} must be a normalized absolute path.`);
  }
  return value;
}

function timestampSlug(): string {
  const date = new Date();
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    + `-${pad(date.getUTCMilliseconds(), 3)}`;
}
