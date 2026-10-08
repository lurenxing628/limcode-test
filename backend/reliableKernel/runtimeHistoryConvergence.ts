import * as fs from 'node:fs/promises';
import { withRuntimeDataRootAdmission } from './runtimeHostControl';
import { discoverForeignRuntimeHistory, heldDatabaseFiles, readForeignRuntimePointerIdentity } from './runtimeForeignHistory';
import { inspectVscodeRuntimeDataSets } from './vscodeRootAuthority';
import { ledgerFile, writeLedgerJson } from './runtimeDataSetMergeLedger';
import { readRuntimeHistoryPending, readRuntimeHistoryResidual, writeRuntimeHistoryPending, writeRuntimeHistoryResidual, reconcileRuntimeResetBackups } from './runtimeHistoryRegistry';

type Paths = { globalStoragePath: string };
async function read<T>(paths: Paths, section: string, id: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(await ledgerFile(paths, section, id), 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Discovery reads metadata only. Existing residuals are requeued solely by the user's retry action. */
export async function registerRuntimeHistoryConvergence(paths: Paths, previousDataRootPaths?: readonly string[]): Promise<number> {
  await reconcileRuntimeResetBackups(paths);
  const local = await inspectVscodeRuntimeDataSets(paths);
  const foreign = await discoverForeignRuntimeHistory({ configurationRootPath: paths.globalStoragePath, previousDataRootPaths });
  const held = await heldDatabaseFiles(paths.globalStoragePath);
  const foreignIdentities = new Map(await Promise.all(foreign.map(async source => [source.id, await readForeignRuntimePointerIdentity(source.location, held)] as const)));
  return withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
    const prior = await read<{ sourceIds: string[] }>(paths, '', 'convergence');
    const known = new Set(prior?.sourceIds ?? []);
    const pending = await readRuntimeHistoryPending(paths);
    const residual = await readRuntimeHistoryResidual(paths);
    const registeredAt = new Date().toISOString();
    for (const candidate of local.candidates.filter(item => !item.selected)) {
      if (known.has(candidate.id) || pending.has(candidate.id) || residual.has(candidate.id)) continue;
      await writeRuntimeHistoryPending(paths, { id: candidate.id, sourceKind: 'local', location: { kind: 'local', candidateId: candidate.id },
        ...(candidate.dataSetId && candidate.rootInstanceId ? { identity: { dataSetId: candidate.dataSetId, rootInstanceId: candidate.rootInstanceId } } : {}),
        reason: '升级收敛', registeredAt });
      known.add(candidate.id);
    }
    for (const problem of local.problems ?? []) {
      if (pending.has(problem.id) || residual.has(problem.id)) continue;
      const location = { kind: 'local' as const, candidateId: problem.id };
      // OS access/space/liveness failures may clear without changing the source.
      const transient = /^(EACCES|EPERM|EIO|EBUSY|ENOSPC|EMFILE|ENFILE)$/.test(problem.code ?? '')
        || /busy|active|live|maintenance|locked/.test(problem.code ?? '');
      if (transient) await writeRuntimeHistoryPending(paths, { id: problem.id, sourceKind: 'local', location,
        reason: problem.message, registeredAt });
      else await writeRuntimeHistoryResidual(paths, { id: problem.id, sourceKind: 'local', location,
        code: problem.code ?? 'runtime-history-source-unreadable', message: problem.message, checkedAt: registeredAt });
    }
    for (const source of foreign) {
      if (known.has(source.id) || pending.has(source.id) || residual.has(source.id)) continue;
      const identity = foreignIdentities.get(source.id);
      if (!identity) {
        await writeRuntimeHistoryResidual(paths, { id: source.id, sourceKind: source.location.kind, location: source.location, code: 'runtime-history-source-identity-unreadable', message: '无法读取旧数据身份，原数据保留；可以重新核验。', checkedAt: registeredAt });
      } else {
        await writeRuntimeHistoryPending(paths, { id: source.id, sourceKind: source.location.kind, location: source.location, identity, reason: '升级收敛', registeredAt });
      }
      known.add(source.id);
    }
    await writeLedgerJson(paths, '', 'convergence', { sourceIds: [...known], registeredAt });
    const notices = await read<{ sourceIds: string[] }>(paths, 'notices', 'convergence');
    const announced = new Set(notices?.sourceIds ?? []);
    const current = await readRuntimeHistoryPending(paths);
    const fresh = [...current.keys()].filter(id => !announced.has(id));
    if (fresh.length) await writeLedgerJson(paths, 'notices', 'convergence', { sourceIds: [...announced, ...fresh], announcedAt: registeredAt });
    return fresh.length;
  });
}

export interface RuntimeHistorySettlementConsent {
  candidateId: string;
  dataSetId: string;
  rootInstanceId: string;
  turns: number;
  intents: number;
  deliveries?: number;
  children?: number;
  effects?: number;
}
export async function readRuntimeHistorySettlementConsent(paths: Paths, input: RuntimeHistorySettlementConsent): Promise<boolean> {
  const record = await read<{ sources: RuntimeHistorySettlementConsent[] }>(paths, '', 'settlement-consent');
  return record?.sources.some(source => source.candidateId === input.candidateId && source.dataSetId === input.dataSetId
    && source.rootInstanceId === input.rootInstanceId && source.turns >= input.turns && source.intents >= input.intents
    && (source.deliveries ?? 0) >= (input.deliveries ?? 0) && (source.children ?? 0) >= (input.children ?? 0)
    && (source.effects ?? 0) >= (input.effects ?? 0)) ?? false;
}
/** Durable publication precedes any source settlement; concurrent windows preserve all consent entries. */
export async function recordRuntimeHistorySettlementConsent(paths: Paths, input: RuntimeHistorySettlementConsent): Promise<void> {
  await recordRuntimeHistorySettlementConsents(paths, [input]);
}

/** Publish every displayed source together before the batch resumes any settlement. */
export async function recordRuntimeHistorySettlementConsents(paths: Paths, inputs: readonly RuntimeHistorySettlementConsent[]): Promise<void> {
  await withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
    const record = await read<{ sources: RuntimeHistorySettlementConsent[] }>(paths, '', 'settlement-consent');
    const ids = new Set(inputs.map(input => input.candidateId));
    const sources = (record?.sources ?? []).filter(source => !ids.has(source.candidateId));
    const agreedAt = new Date().toISOString();
    await writeLedgerJson(paths, '', 'settlement-consent', { sources: [...sources, ...inputs.map(input => ({ ...input, agreedAt }))] });
  });
}
