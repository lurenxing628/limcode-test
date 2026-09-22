import type { ContentAddressedStore } from './contentAddressedStore';
import { readFrozenTurnAuthority } from './frozenAuthority';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import {
  CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_AUTOMATIC_FOLLOWUPS
} from '../world/modules/tools/definitions/runAgent';

export interface CollaborationLimits {
  maxConcurrentAgents: number;
  maxAutomaticFollowups: number;
}

/** User ToolPolicy is the only budget authority; model arguments never select these limits. */
export function frozenCollaborationLimits(document: PlainJsonValue): CollaborationLimits {
  const config = frozenRunAgentConfig(document);
  return {
    maxConcurrentAgents: limit(config?.maxConcurrentAgents, DEFAULT_MAX_CONCURRENT_AGENTS, 1, 'maxConcurrentAgents'),
    maxAutomaticFollowups: limit(config?.maxAutomaticFollowups, DEFAULT_MAX_AUTOMATIC_FOLLOWUPS, 0, 'maxAutomaticFollowups')
  };
}

/**
 * The user's cross-conversation switch as frozen into one Turn. Off unless explicitly enabled at
 * some settings scope; the model can neither see nor change it.
 */
export function frozenCrossConversationEnabled(document: PlainJsonValue): boolean {
  const value = frozenRunAgentConfig(document)?.[CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError(`Invalid frozen collaboration ${CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY}.`);
  return value;
}

export async function readTurnCollaborationLimits(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnId: string
): Promise<CollaborationLimits> {
  return frozenCollaborationLimits(await readFrozenTurnDocument(database, contentStore, turnId));
}

export async function readTurnCrossConversationEnabled(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnId: string
): Promise<boolean> {
  return frozenCrossConversationEnabled(await readFrozenTurnDocument(database, contentStore, turnId));
}

async function readFrozenTurnDocument(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnId: string
): Promise<PlainJsonValue> {
  const result = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').list({ where: { turn_id: turnId }, limit: 2 })
  ]);
  const snapshots = result.snapshot[0];
  if (!Array.isArray(snapshots) || snapshots.length !== 1) {
    throw new Error('Collaboration policy requires the exact frozen Turn authority.');
  }
  return (await readFrozenTurnAuthority(database, contentStore, String(snapshots[0].id), turnId)).document;
}

function frozenRunAgentConfig(document: PlainJsonValue): Record<string, unknown> | undefined {
  const policies = record(record(record(document)?.toolPolicy)?.toolConfigs);
  return record(record(policies?.run_agent)?.config);
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
