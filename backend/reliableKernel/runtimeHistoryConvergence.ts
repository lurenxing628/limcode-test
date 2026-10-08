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
}
export async function readRuntimeHistorySettlementConsent(paths: Paths, input: RuntimeHistorySettlementConsent): Promise<boolean> {
  const record = await read<{ sources: RuntimeHistorySettlementConsent[] }>(paths, '', 'settlement-consent');
  return record?.sources.some(source => source.candidateId === input.candidateId && source.dataSetId === input.dataSetId
    && source.rootInstanceId === input.rootInstanceId && source.turns >= input.turns && source.intents >= input.intents) ?? false;
}
/** Durable publication precedes any source settlement; concurrent windows preserve all consent entries. */
export async function recordRuntimeHistorySettlementConsent(paths: Paths, input: RuntimeHistorySettlementConsent): Promise<void> {
  await withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
    const record = await read<{ sources: RuntimeHistorySettlementConsent[] }>(paths, '', 'settlement-consent');
    const sources = (record?.sources ?? []).filter(source => source.candidateId !== input.candidateId);
    await writeLedgerJson(paths, '', 'settlement-consent', { sources: [...sources, { ...input, agreedAt: new Date().toISOString() }] });
  });
}
