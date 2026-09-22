import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  ROOT_BINDING_PENDING_FILE,
  ROOT_BINDING_POINTER_FILE,
  RUNTIME_KERNEL_EPOCH,
  createRuntimeRootPaths,
  freezeRootBinding,
  type RootBinding,
  type RuntimeEpochManifest,
  type RuntimeRootPaths
} from './contracts';
import { withRuntimeDataRootAdmission, withRuntimeMaintenance } from './runtimeHostControl';

export class RootAuthorityError extends Error {
  public constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'RootAuthorityError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class StaleRootBindingError extends RootAuthorityError {
  public constructor(message = 'RootBinding generation is stale; close the Runtime and reopen with the current binding.') {
    super('stale-root-binding', message);
    this.name = 'StaleRootBindingError';
  }
}

export type RuntimeRootInitializer = (binding: RootBinding) => Promise<void>;

export interface CandidateRootActivation {
  authority: RootAuthority;
  binding: RootBinding;
}

/**
 * Structurally valid pointer from an earlier Runtime epoch.  It is intentionally not a
 * {@link RootBinding}: ordinary Runtime code must never open it.  The offline cutover path may
 * inspect only its identity/counters before archiving the referenced root.
 */
export interface HistoricalRootBinding {
  paths: RuntimeRootPaths;
  dataSetId: string;
  rootInstanceId: string;
  rootGeneration: number;
  pointerRevision: number;
  runtimeKernelEpoch: number;
}

export type RootAuthorityValidationEvent =
  | { kind: 'validate-requested' }
  | { kind: 'validate-execution-started' }
  | { kind: 'validate-single-flight-joined' }
  | {
    kind: 'validate-execution-completed';
    outcome: 'success' | 'failure';
    durationMs: number;
    hostFileOperationCount: number;
    hostFileAccessCheckCount: number;
    hostFileReadCount: number;
    jsonParseCount: number;
  };

/** Optional development-only metrics sink. Events never contain binding paths or file contents. */
export interface RootAuthorityValidationObserver {
  observe(event: RootAuthorityValidationEvent): void;
}

interface RootAuthorityValidationMeasurement {
  startedAt: bigint;
  hostFileOperationCount: number;
  hostFileAccessCheckCount: number;
  hostFileReadCount: number;
  jsonParseCount: number;
}

interface RootAuthorityValidationFlight {
  binding: RootBinding;
  promise: Promise<RootBinding>;
}

const ROOT_BINDING_VALIDATION_CACHE_MS = 25;

interface RootAuthorityValidationCache {
  binding: RootBinding;
  expiresAtMs: number;
}

/**
 * RootAuthority is the only component allowed to resolve and activate Runtime roots. Long-lived
 * services cache one immutable complete RootBinding, never a naked path. Root changes are offline:
 * callers must close the old service before opening one with the returned binding.
 *
 * Every production authority carries its configuration-root getter so Host registration and root
 * maintenance always enter the shared admission boundary first (canonical order: configuration
 * admission, then scope maintenance — never the reverse). A standalone authority without the
 * getter falls back to its own control-root boundary, which is exactly the scope maintenance
 * claim and therefore joins nested maintenance calls reentrantly.
 */
export class RootAuthority {
  private readonly validationFlights = new Set<RootAuthorityValidationFlight>();
  private validationCache: RootAuthorityValidationCache | undefined;

  public constructor(
    private readonly getDataRootPath: () => string,
    private readonly validationObserver?: RootAuthorityValidationObserver,
    private readonly getConfigurationRootPath?: () => string
  ) {}

  public expectedPaths(): RuntimeRootPaths {
    return createRuntimeRootPaths(this.getDataRootPath());
  }

  /**
   * The admission boundary shared by every Runtime Host rooted in the same configuration data
   * root. Host registration (RuntimeDatabase.open) and every root mutation must run inside this
   * claim so a configuration-root-wide operation (legacy physical cutover) is never raced by a
   * new scope registering mid-enumeration. Nested calls join the outer claim per async scope.
   */
  public withRuntimeHostAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const configurationRootPath = this.getConfigurationRootPath?.();
    if (configurationRootPath === undefined) {
      return withRuntimeMaintenance(this.expectedPaths(), operation);
    }
    return withRuntimeDataRootAdmission(configurationRootPath, operation);
  }

  /** Reads the active pointer without requiring the referenced root/epoch to remain online. */
  public async readPointer(): Promise<RootBinding | undefined> {
    return readBindingFile(this.expectedPaths().rootPointerPath);
  }

  /**
   * Offline-cutover-only reader. It accepts a structurally valid pointer from the current or an
   * earlier epoch, but never validates or opens the referenced Runtime root.
   */
  public async readHistoricalPointerForCutover(): Promise<HistoricalRootBinding | undefined> {
    return readHistoricalBindingFile(this.expectedPaths().rootPointerPath);
  }

  /**
   * Fences every previous-epoch writer before one exact offline schema upgrade. The historical
   * pointer remains authoritative until {@link commitInPlaceEpochMigration} atomically publishes
   * the staged current-epoch binding.
   */
  public async stageInPlaceEpochMigration(previous: HistoricalRootBinding): Promise<RootBinding> {
    const expectedPaths = this.expectedPaths();
    if (!samePaths(previous.paths, expectedPaths)) {
      throw new StaleRootBindingError('Historical RootBinding paths do not match the selected data root.');
    }
    if (previous.runtimeKernelEpoch >= RUNTIME_KERNEL_EPOCH) {
      throw new RootAuthorityError(
        'runtime-epoch-migration-invalid',
        'Only an earlier Runtime epoch may be staged for migration.'
      );
    }
    const next = migratedBinding(previous);
    const currentPointer = await readHistoricalBindingFile(expectedPaths.rootPointerPath);
    if (!currentPointer || !sameHistoricalBindingIdentity(currentPointer, previous)) {
      if (currentPointer?.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) {
        const current = await this.current();
        if (sameBindingIdentity(current, next)) return current;
      }
      throw new StaleRootBindingError('Historical RootBinding changed before epoch migration could be staged.');
    }
    const pending = await readBindingFile(expectedPaths.rootPendingPath);
    if (pending) {
      if (!sameBindingIdentity(pending, next)) {
        throw new RootAuthorityError(
          'root-binding-pending',
          'A different RootBinding migration is already pending.'
        );
      }
      return pending;
    }
    await writeDurableJson(expectedPaths.rootPendingPath, next);
    return next;
  }

  /** Publishes an already-validated upgraded database without changing its data-set identity. */
  public async commitInPlaceEpochMigration(
    previous: HistoricalRootBinding,
    next: RootBinding
  ): Promise<RootBinding> {
    const expectedNext = migratedBinding(previous);
    if (!sameBindingIdentity(next, expectedNext)) {
      throw new RootAuthorityError(
        'runtime-epoch-migration-invalid',
        'Staged epoch migration binding does not match the authority plan.'
      );
    }
    const currentPointer = await readHistoricalBindingFile(next.paths.rootPointerPath);
    if (currentPointer?.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) {
      const current = await this.current();
      if (sameBindingIdentity(current, next)) return current;
      throw new StaleRootBindingError('A different current-epoch RootBinding was published.');
    }
    if (!currentPointer || !sameHistoricalBindingIdentity(currentPointer, previous)) {
      throw new StaleRootBindingError('Historical RootBinding changed before epoch migration publication.');
    }
    const pending = await readBindingFile(next.paths.rootPendingPath);
    if (!pending || !sameBindingIdentity(pending, next)) {
      throw new RootAuthorityError(
        'root-binding-pending',
        'The staged epoch migration RootBinding is missing or does not match.'
      );
    }
    const epoch: RuntimeEpochManifest = {
      kind: 'limcode-runtime-kernel-epoch',
      runtimeKernelEpoch: RUNTIME_KERNEL_EPOCH,
      dataSetId: next.dataSetId,
      rootInstanceId: next.rootInstanceId,
      rootGeneration: next.rootGeneration,
      initializedAt: new Date().toISOString()
    };
    await writeDurableJson(next.paths.runtimeEpochPath, epoch);
    await syncIfFile(next.paths.databasePath);
    await syncDirectory(next.paths.casRootPath);
    await syncDirectory(next.paths.dataRootPath);
    await commitPendingBinding(next);
    return this.current();
  }

  public async current(): Promise<RootBinding> {
    return this.readCurrent(this.expectedPaths());
  }

  /** Revalidates the pointer and epoch, reusing a recent successful check across a hot request burst. */
  public validate(binding: RootBinding): Promise<RootBinding> {
    if (this.validationObserver) this.observeValidation({ kind: 'validate-requested' });
    try {
      const expectedPaths = this.expectedPaths();
      const shareable = samePaths(binding.paths, expectedPaths);
      if (shareable && !this.validationObserver) {
        const cached = this.validationCache;
        if (
          cached
          && cached.expiresAtMs >= performance.now()
          && sameBindingIdentity(binding, cached.binding)
        ) return Promise.resolve(cached.binding);
      }
      if (shareable) {
        for (const flight of this.validationFlights) {
          if (!sameBindingIdentity(binding, flight.binding)) continue;
          if (this.validationObserver) this.observeValidation({ kind: 'validate-single-flight-joined' });
          return flight.promise;
        }
      }
      return this.startValidationExecution(
        binding,
        shareable,
        (measurement) => this.validateAgainstExpectedPaths(binding, expectedPaths, measurement)
      );
    } catch (error) {
      return this.startValidationExecution(binding, false, async () => { throw error; });
    }
  }

  public async withValidatedBinding<T>(binding: RootBinding, operation: (current: RootBinding) => Promise<T>): Promise<T> {
    return operation(await this.validate(binding));
  }

  private async readCurrent(
    expected: RuntimeRootPaths,
    measurement?: RootAuthorityValidationMeasurement
  ): Promise<RootBinding> {
    if (await exists(expected.rootPendingPath, measurement)) {
      const recovered = await this.recoverCompletedPendingBinding(expected, measurement);
      if (recovered) return recovered;
      throw new RootAuthorityError(
        'root-binding-pending',
        `RootBinding pending marker exists but its completed Runtime root cannot be verified: ${expected.rootPendingPath}`
      );
    }
    const binding = await readBindingFile(expected.rootPointerPath, measurement);
    if (!binding) {
      throw new RootAuthorityError('root-binding-missing', `RootBinding pointer is missing: ${expected.rootPointerPath}`);
    }
    if (!samePaths(binding.paths, expected)) {
      throw new StaleRootBindingError('The active RootBinding does not match the data root selected by getPaths(); restart is required.');
    }
    await validateEpoch(binding, measurement);
    return binding;
  }

  /**
   * Recovers the narrow activation crash window after the database/CAS/epoch became durable but
   * before root-binding.pending.json was renamed to root-binding.json. A pending binding is never
   * guessed: the pointer must still be absent and the durable epoch identity must match exactly.
   */
  private async recoverCompletedPendingBinding(
    expected: RuntimeRootPaths,
    measurement?: RootAuthorityValidationMeasurement
  ): Promise<RootBinding | undefined> {
    if (await readBindingFile(expected.rootPointerPath, measurement)) return undefined;
    const pending = await readBindingFile(expected.rootPendingPath, measurement);
    if (!pending || !samePaths(pending.paths, expected)) return undefined;
    if (!await isRegularFile(expected.databasePath) || !await isDirectory(expected.casRootPath)) {
      return undefined;
    }
    try {
      await validateEpoch(pending, measurement);
    } catch {
      return undefined;
    }

    await syncIfFile(expected.databasePath);
    await syncDirectory(expected.casRootPath);
    await syncDirectory(expected.dataRootPath);
    return commitPendingBinding(pending, measurement);
  }

  private async validateAgainstExpectedPaths(
    binding: RootBinding,
    expectedPaths: RuntimeRootPaths,
    measurement?: RootAuthorityValidationMeasurement
  ): Promise<RootBinding> {
    const current = await this.readCurrent(expectedPaths, measurement);
    if (!sameBindingIdentity(binding, current)) throw new StaleRootBindingError();
    return current;
  }

  private startValidationExecution(
    binding: RootBinding,
    shareable: boolean,
    action: (measurement?: RootAuthorityValidationMeasurement) => Promise<RootBinding>
  ): Promise<RootBinding> {
    const measurement = this.validationObserver
      ? {
        startedAt: process.hrtime.bigint(),
        hostFileOperationCount: 0,
        hostFileAccessCheckCount: 0,
        hostFileReadCount: 0,
        jsonParseCount: 0
      }
      : undefined;
    if (this.validationObserver) this.observeValidation({ kind: 'validate-execution-started' });
    let execution: Promise<RootBinding>;
    try {
      execution = action(measurement);
    } catch (error) {
      execution = Promise.reject(error);
    }

    let flight: RootAuthorityValidationFlight | undefined;
    const promise = execution.then(
      (current) => {
        if (flight) this.validationFlights.delete(flight);
        if (shareable && !this.validationObserver) {
          this.validationCache = {
            binding: current,
            expiresAtMs: performance.now() + ROOT_BINDING_VALIDATION_CACHE_MS
          };
        }
        this.completeValidation(measurement, 'success');
        return current;
      },
      (error: unknown) => {
        if (flight) this.validationFlights.delete(flight);
        if (this.validationCache && sameBindingIdentity(binding, this.validationCache.binding)) {
          this.validationCache = undefined;
        }
        this.completeValidation(measurement, 'failure');
        throw error;
      }
    );
    if (shareable) {
      flight = { binding, promise };
      this.validationFlights.add(flight);
    }
    return promise;
  }

  private completeValidation(
    measurement: RootAuthorityValidationMeasurement | undefined,
    outcome: 'success' | 'failure'
  ): void {
    if (!measurement) return;
    this.observeValidation({
      kind: 'validate-execution-completed',
      outcome,
      durationMs: Number(process.hrtime.bigint() - measurement.startedAt) / 1_000_000,
      hostFileOperationCount: measurement.hostFileOperationCount,
      hostFileAccessCheckCount: measurement.hostFileAccessCheckCount,
      hostFileReadCount: measurement.hostFileReadCount,
      jsonParseCount: measurement.jsonParseCount
    });
  }

  private observeValidation(event: RootAuthorityValidationEvent): void {
    if (!this.validationObserver) return;
    try {
      this.validationObserver.observe(event);
    } catch {
      // Development metrics must never change RootAuthority fencing behavior.
    }
  }

  /**
   * Activates a fresh root during an explicit offline cutover. The old pointer remains authoritative
   * until the pending root, database, CAS and epoch are all durable and the final rename commits.
   */
  public async activateCutoverRoot(initializer: RuntimeRootInitializer): Promise<RootBinding> {
    const paths = this.expectedPaths();
    if (await exists(paths.rootPendingPath)) {
      throw new RootAuthorityError('root-binding-pending', `Cannot cut over while pending exists: ${paths.rootPendingPath}`);
    }
    const previous = await readHistoricalBindingFile(paths.rootPointerPath);
    return this.activateOffline(paths, previous, initializer);
  }

  /** Initializes the selected root when no active pointer exists. No legacy data is inspected. */
  public async initializeEmptyRoot(initializer: RuntimeRootInitializer): Promise<RootBinding> {
    const paths = this.expectedPaths();
    if (await exists(paths.rootPendingPath)) {
      throw new RootAuthorityError('root-binding-pending', `Cannot initialize while pending exists: ${paths.rootPendingPath}`);
    }
    if (await exists(paths.rootPointerPath)) {
      throw new RootAuthorityError('root-binding-exists', `RootBinding pointer already exists: ${paths.rootPointerPath}`);
    }
    return this.activateOffline(paths, undefined, initializer);
  }

  /**
   * Creates and atomically activates a fresh isolated candidate root. Existing candidate data is not
   * imported or copied. This is a development foundation operation, not the production cutover.
   */
  public static async resetCandidateRoot(
    candidateParentPath: string,
    initializer: RuntimeRootInitializer
  ): Promise<CandidateRootActivation> {
    const parent = path.resolve(candidateParentPath);
    await fs.mkdir(parent, { recursive: true });
    const pointerPath = path.join(parent, ROOT_BINDING_POINTER_FILE);
    const pendingPath = path.join(parent, ROOT_BINDING_PENDING_FILE);
    const previous = await readBindingFile(pointerPath);
    const interrupted = await readBindingFile(pendingPath);
    if (interrupted) {
      const interruptedRoot = interrupted.paths.dataRootPath;
      if (
        path.dirname(interruptedRoot) !== parent
        || !path.basename(interruptedRoot).startsWith('candidate-runtime-')
        || interruptedRoot === previous?.paths.dataRootPath
      ) {
        throw new RootAuthorityError('root-binding-pending', `Pending binding is not an isolated candidate root: ${pendingPath}`);
      }
      await fs.rm(interruptedRoot, { recursive: true, force: true });
      await fs.rm(pendingPath, { force: true });
      await syncDirectory(parent);
    }
    const rootName = `candidate-runtime-${randomUUID()}`;
    const dataRootPath = path.join(parent, rootName);
    const authority = new RootAuthority(() => dataRootPath);
    const paths = authority.expectedPaths();
    const binding = await authority.activateOffline(paths, previous, initializer);
    return { authority, binding };
  }

  private async activateOffline(
    paths: RuntimeRootPaths,
    previous: Pick<HistoricalRootBinding, 'rootGeneration' | 'pointerRevision'> | undefined,
    initializer: RuntimeRootInitializer
  ): Promise<RootBinding> {
    await assertFreshRuntimeRoot(paths);
    const binding = freezeRootBinding({
      paths,
      dataSetId: randomUUID(),
      rootInstanceId: randomUUID(),
      rootGeneration: (previous?.rootGeneration ?? 0) + 1,
      pointerRevision: (previous?.pointerRevision ?? 0) + 1,
      runtimeKernelEpoch: RUNTIME_KERNEL_EPOCH
    });

    await fs.mkdir(paths.dataRootPath, { recursive: true });
    await writeDurableJson(paths.rootPendingPath, binding);
    try {
      await initializer(binding);
      const epoch: RuntimeEpochManifest = {
        kind: 'limcode-runtime-kernel-epoch',
        runtimeKernelEpoch: RUNTIME_KERNEL_EPOCH,
        dataSetId: binding.dataSetId,
        rootInstanceId: binding.rootInstanceId,
        rootGeneration: binding.rootGeneration,
        initializedAt: new Date().toISOString()
      };
      await writeDurableJson(paths.runtimeEpochPath, epoch);
      await syncIfFile(paths.databasePath);
      await syncDirectory(paths.casRootPath);
      await syncDirectory(paths.dataRootPath);
      await commitPendingBinding(binding);
    } catch (error) {
      // Pending intentionally remains. Startup must fail closed until an explicit candidate reset.
      throw new RootAuthorityError(
        'root-activation-failed',
        `Runtime root activation failed: ${paths.dataRootPath}`,
        error
      );
    }
    return this.current();
  }
}

export function parseRootBinding(value: unknown): RootBinding {
  const binding = parseHistoricalRootBinding(value);
  return freezeRootBinding({
    ...binding,
    runtimeKernelEpoch: requireCurrentEpoch(binding.runtimeKernelEpoch)
  });
}

export function parseHistoricalRootBinding(value: unknown): HistoricalRootBinding {
  const binding = parseHistoricalRootBindingStructure(value);
  requireHistoricalEpoch(binding.runtimeKernelEpoch);
  return binding;
}

/** Validates every field before the caller applies its epoch compatibility policy. */
function parseHistoricalRootBindingStructure(value: unknown): HistoricalRootBinding {
  const record = requireRecord(value, 'RootBinding');
  requireExactKeys(record, [
    'paths',
    'dataSetId',
    'rootInstanceId',
    'rootGeneration',
    'pointerRevision',
    'runtimeKernelEpoch'
  ], 'RootBinding');
  const paths = parseRootPaths(record.paths);
  const binding: HistoricalRootBinding = {
    paths,
    dataSetId: requireNonEmptyString(record.dataSetId, 'RootBinding.dataSetId'),
    rootInstanceId: requireNonEmptyString(record.rootInstanceId, 'RootBinding.rootInstanceId'),
    rootGeneration: requirePositiveInteger(record.rootGeneration, 'RootBinding.rootGeneration'),
    pointerRevision: requirePositiveInteger(record.pointerRevision, 'RootBinding.pointerRevision'),
    runtimeKernelEpoch: requirePositiveInteger(record.runtimeKernelEpoch, 'RootBinding.runtimeKernelEpoch')
  };
  return Object.freeze({ ...binding, paths: Object.freeze({ ...binding.paths }) });
}

export function sameBindingIdentity(left: RootBinding, right: RootBinding): boolean {
  return left.dataSetId === right.dataSetId
    && left.rootInstanceId === right.rootInstanceId
    && left.rootGeneration === right.rootGeneration
    && left.pointerRevision === right.pointerRevision
    && left.runtimeKernelEpoch === right.runtimeKernelEpoch
    && samePaths(left.paths, right.paths);
}

async function validateEpoch(
  binding: RootBinding,
  measurement?: RootAuthorityValidationMeasurement
): Promise<void> {
  let value: unknown;
  try {
    recordHostFileRead(measurement);
    const text = await fs.readFile(binding.paths.runtimeEpochPath, 'utf8');
    value = parseJson(text, measurement);
  } catch (error) {
    throw new RootAuthorityError(
      'runtime-epoch-missing-or-invalid',
      `Runtime epoch cannot be read: ${binding.paths.runtimeEpochPath}`,
      error
    );
  }
  const manifest = requireRecord(value, 'RuntimeEpochManifest');
  requireExactKeys(manifest, [
    'kind',
    'runtimeKernelEpoch',
    'dataSetId',
    'rootInstanceId',
    'rootGeneration',
    'initializedAt'
  ], 'RuntimeEpochManifest');
  if (
    manifest.kind !== 'limcode-runtime-kernel-epoch'
    || manifest.runtimeKernelEpoch !== binding.runtimeKernelEpoch
    || manifest.dataSetId !== binding.dataSetId
    || manifest.rootInstanceId !== binding.rootInstanceId
    || manifest.rootGeneration !== binding.rootGeneration
    || typeof manifest.initializedAt !== 'string'
    || !manifest.initializedAt
  ) {
    throw new RootAuthorityError('runtime-epoch-mismatch', 'Runtime epoch does not match the active RootBinding.');
  }
}

async function assertFreshRuntimeRoot(paths: RuntimeRootPaths): Promise<void> {
  const existing = await Promise.all([
    paths.databasePath,
    `${paths.databasePath}-wal`,
    `${paths.databasePath}-shm`,
    paths.casRootPath,
    paths.runtimeEpochPath
  ].map(async (entry) => await exists(entry) ? entry : undefined));
  const collisions = existing.filter((entry): entry is string => entry !== undefined);
  if (collisions.length > 0) {
    throw new RootAuthorityError('runtime-root-not-empty', `Fresh Runtime root required; found: ${collisions.join(', ')}`);
  }
}

async function readBindingFile(
  filePath: string,
  measurement?: RootAuthorityValidationMeasurement
): Promise<RootBinding | undefined> {
  let text: string;
  try {
    recordHostFileRead(measurement);
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return parseRootBinding(parseJson(text, measurement));
  } catch (error) {
    throw new RootAuthorityError('root-binding-invalid', `Invalid RootBinding pointer: ${filePath}`, error);
  }
}

async function readHistoricalBindingFile(filePath: string): Promise<HistoricalRootBinding | undefined> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    const binding = parseHistoricalRootBindingStructure(JSON.parse(text));
    assertHistoricalEpochSupported(binding, filePath);
    return binding;
  } catch (error) {
    if (error instanceof RootAuthorityError && error.code === 'runtime-epoch-newer-than-extension') {
      throw error;
    }
    throw new RootAuthorityError('root-binding-invalid', `Invalid historical RootBinding pointer: ${filePath}`, error);
  }
}

function assertHistoricalEpochSupported(binding: HistoricalRootBinding, filePath: string): void {
  const epoch = binding.runtimeKernelEpoch;
  if (epoch > RUNTIME_KERNEL_EPOCH) {
    throw new RootAuthorityError(
      'runtime-epoch-newer-than-extension',
      `RootBinding pointer requires Runtime epoch ${epoch}, but this extension supports through ${RUNTIME_KERNEL_EPOCH}: ${filePath}`
    );
  }
}

async function commitPendingBinding(
  expected: RootBinding,
  measurement?: RootAuthorityValidationMeasurement
): Promise<RootBinding> {
  try {
    await fs.rename(expected.paths.rootPendingPath, expected.paths.rootPointerPath);
    await syncDirectory(path.dirname(expected.paths.rootPointerPath));
  } catch (error) {
    // A verified recovery in another Host may publish this exact generation first.
    if (!isNotFound(error)) throw error;
  }
  const committed = await readBindingFile(expected.paths.rootPointerPath, measurement);
  if (!committed || !sameBindingIdentity(committed, expected)) {
    throw new StaleRootBindingError('A different RootBinding won pending activation publication.');
  }
  return committed;
}

async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, filePath);
  await syncDirectory(path.dirname(filePath));
}

async function syncIfFile(filePath: string): Promise<void> {
  // Windows requires a writable file handle for FlushFileBuffers; opening the ordinary database
  // read-only makes FileHandle.sync() report EPERM even though directory sync compatibility is fine.
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  await syncDirectoryDurably(directoryPath);
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function isDirectory(directoryPath: string): Promise<boolean> {
  try {
    return (await fs.stat(directoryPath)).isDirectory();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function exists(
  filePath: string,
  measurement?: RootAuthorityValidationMeasurement
): Promise<boolean> {
  try {
    recordHostFileAccessCheck(measurement);
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function recordHostFileAccessCheck(measurement: RootAuthorityValidationMeasurement | undefined): void {
  if (!measurement) return;
  measurement.hostFileOperationCount += 1;
  measurement.hostFileAccessCheckCount += 1;
}

function recordHostFileRead(measurement: RootAuthorityValidationMeasurement | undefined): void {
  if (!measurement) return;
  measurement.hostFileOperationCount += 1;
  measurement.hostFileReadCount += 1;
}

function parseJson(text: string, measurement: RootAuthorityValidationMeasurement | undefined): unknown {
  if (measurement) measurement.jsonParseCount += 1;
  return JSON.parse(text);
}

function parseRootPaths(value: unknown): RuntimeRootPaths {
  const record = requireRecord(value, 'RootBinding.paths');
  requireExactKeys(record, [
    'dataRootPath',
    'databasePath',
    'casRootPath',
    'rootPointerPath',
    'rootPendingPath',
    'runtimeEpochPath'
  ], 'RootBinding.paths');
  return {
    dataRootPath: requireAbsolutePath(record.dataRootPath, 'RootBinding.paths.dataRootPath'),
    databasePath: requireAbsolutePath(record.databasePath, 'RootBinding.paths.databasePath'),
    casRootPath: requireAbsolutePath(record.casRootPath, 'RootBinding.paths.casRootPath'),
    rootPointerPath: requireAbsolutePath(record.rootPointerPath, 'RootBinding.paths.rootPointerPath'),
    rootPendingPath: requireAbsolutePath(record.rootPendingPath, 'RootBinding.paths.rootPendingPath'),
    runtimeEpochPath: requireAbsolutePath(record.runtimeEpochPath, 'RootBinding.paths.runtimeEpochPath')
  };
}

function samePaths(left: RuntimeRootPaths, right: RuntimeRootPaths): boolean {
  return left.dataRootPath === right.dataRootPath
    && left.databasePath === right.databasePath
    && left.casRootPath === right.casRootPath
    && left.rootPointerPath === right.rootPointerPath
    && left.rootPendingPath === right.rootPendingPath
    && left.runtimeEpochPath === right.runtimeEpochPath;
}

function migratedBinding(previous: HistoricalRootBinding): RootBinding {
  return freezeRootBinding({
    paths: previous.paths,
    dataSetId: previous.dataSetId,
    rootInstanceId: previous.rootInstanceId,
    rootGeneration: previous.rootGeneration + 1,
    pointerRevision: previous.pointerRevision + 1,
    runtimeKernelEpoch: RUNTIME_KERNEL_EPOCH
  });
}

function sameHistoricalBindingIdentity(
  left: HistoricalRootBinding,
  right: HistoricalRootBinding
): boolean {
  return left.dataSetId === right.dataSetId
    && left.rootInstanceId === right.rootInstanceId
    && left.rootGeneration === right.rootGeneration
    && left.pointerRevision === right.pointerRevision
    && left.runtimeKernelEpoch === right.runtimeKernelEpoch
    && samePaths(left.paths, right.paths);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields do not match the current schema.`);
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value as number;
}

function requireCurrentEpoch(value: unknown): typeof RUNTIME_KERNEL_EPOCH {
  if (value !== RUNTIME_KERNEL_EPOCH) throw new TypeError('RootBinding.runtimeKernelEpoch is not current.');
  return RUNTIME_KERNEL_EPOCH;
}

function requireHistoricalEpoch(value: unknown): number {
  const epoch = requirePositiveInteger(value, 'RootBinding.runtimeKernelEpoch');
  if (epoch > RUNTIME_KERNEL_EPOCH) {
    throw new TypeError('RootBinding.runtimeKernelEpoch is newer than this extension.');
  }
  return epoch;
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new TypeError(`${label} must be a normalized absolute path.`);
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
