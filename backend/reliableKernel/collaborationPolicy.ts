import type { ContentAddressedStore } from './contentAddressedStore';
import { readFrozenTurnAuthority } from './frozenAuthority';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import {
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_AUTOMATIC_FOLLOWUPS
} from '../world/modules/tools/definitions/runAgent';
import { crossConversationSwitchOn } from '../../shared/toolPolicyResolution';

/**
 * Fixed limits of cross-conversation collaboration. They are not settings: the automatic followup
 * budget (maxAutomaticFollowups) remains the only configurable bound, and cross-conversation
 * followups and create_conversation spend it like team followups.
 */
export const CROSS_CONVERSATION_LIMITS = Object.freeze({
  /**
   * Undelivered inbound collaboration messages (message and followup modes, from any sender) a
   * target Conversation may hold before cross-conversation sends to it are refused. Completion
   * replies to the target's own requests are exempt.
   */
  maxPendingInboundMessages: 16,
  /** create_conversation plus fork_conversation calls one sender Turn may make. */
  maxConversationSpawnsPerTurn: 8
});

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
 * some settings scope; the model can neither see nor change it. Only a literal `true` turns it on:
 * any other value (for example a hand-edited string "true") fails closed instead of breaking the
 * Turn's tool list.
 */
export function frozenCrossConversationEnabled(document: PlainJsonValue): boolean {
  return crossConversationSwitchOn(record(record(document)?.toolPolicy)?.toolConfigs);
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
