import type { RootAuthority } from '../../reliableKernel/rootAuthority';
import { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';
import type { RelocatedWorkSettlementResult } from '../../reliableKernel/historicalWorkSettlement';
import { SETTLING_ONLY } from './relocatedWorkOpening';
import { settleHistoricalMergeWork } from './relocatedWorkSettlement';

/** Caller holds the local source maintenance claim, backup and durable settlement consent. */
export async function settleHistoricalMergeSourceOffline(
  authority: RootAuthority,
  excludedConversationIds?: ReadonlySet<string>
): Promise<RelocatedWorkSettlementResult> {
  const application = await ReliableKernelApplication.open(authority, SETTLING_ONLY);
  try {
    const inventory = await application.database.relocatedWorkInventory();
    const result = await settleHistoricalMergeWork({ application, inventory, excludedConversationIds });
    await application.database.durabilityCheckpoint();
    return result;
  } finally {
    await application.close();
  }
}
