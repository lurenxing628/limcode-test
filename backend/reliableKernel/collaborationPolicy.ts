import type { ContentAddressedStore } from './contentAddressedStore';
import { readFrozenTurnAuthority } from './frozenAuthority';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import { DEFAULT_MAX_CONCURRENT_AGENTS, DEFAULT_MAX_AUTOMATIC_FOLLOWUPS } from '../world/modules/tools/definitions/runAgent';

export interface CollaborationLimits {
  maxConcurrentAgents: number;
  maxAutomaticFollowups: number;
}

/** User ToolPolicy is the only budget authority; model arguments never select these limits. */
export function frozenCollaborationLimits(document: PlainJsonValue): CollaborationLimits {
  const root = record(document);
  const policies = record(record(root?.toolPolicy)?.toolConfigs);
  const config = record(record(policies?.run_agent)?.config);
  return {
    maxConcurrentAgents: limit(config?.maxConcurrentAgents, DEFAULT_MAX_CONCURRENT_AGENTS, 1, 'maxConcurrentAgents'),
    maxAutomaticFollowups: limit(config?.maxAutomaticFollowups, DEFAULT_MAX_AUTOMATIC_FOLLOWUPS, 0, 'maxAutomaticFollowups')
  };
}

export async function readTurnCollaborationLimits(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnId: string
): Promise<CollaborationLimits> {
  const result = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').list({ where: { turn_id: turnId }, limit: 2 })
  ]);
  const snapshots = result.snapshot[0];
  if (!Array.isArray(snapshots) || snapshots.length !== 1) {
    throw new Error('Collaboration limits require the exact frozen Turn authority.');
  }
  const authority = await readFrozenTurnAuthority(database, contentStore, String(snapshots[0].id), turnId);
  return frozenCollaborationLimits(authority.document);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function limit(value: unknown, defaultValue: number, minimum: number, label: string): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`Invalid frozen collaboration ${label}.`);
  }
  return value;
}
