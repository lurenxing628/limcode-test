import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import {
  CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
  LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND,
  childContinuationTurnId,
  resolveLegacyContinuationWaitOperations
} from './childSendLineage';
import { requirePhaseFId } from './phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { TURN_EXECUTION_PRESET_CONTENT_TYPE } from './runtimeDeliveryContinuationIdentity';
import type { RuntimeDatabase } from './runtimeDatabase';

/** Immutable dispatch lineage, shared by live delivery, recovery and task classification. */
async function get(database: RuntimeDatabase, domain: string, id: unknown): Promise<DomainRow | null> {
  if (typeof id !== 'string' || id.length === 0) return null;
  return (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0] as DomainRow | null;
}

async function list(database: RuntimeDatabase, domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
  return (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })])).snapshot[0] as DomainRow[];
}

/**
 * The Turn that requested this result, never the recipient's latest Turn. For an answer this is
 * the parent Turn that dispatched its exact child generation, not necessarily the spawn Turn.
 * Collaboration messages and incomplete/non-task source facts have no source Turn.
 */
export function runtimeDeliverySourceTurn(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  inboxItemIdInput: string
): Promise<string | null> {
  return deliverySourceTurn(database, contentStore, requirePhaseFId(inboxItemIdInput, 'inboxItemId'), new Set());
}

async function deliverySourceTurn(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  inboxItemId: string,
  visited: Set<string>
): Promise<string | null> {
  const inbox = await get(database, 'RuntimeInboxItem', inboxItemId);
  if (inbox?.source_kind === 'process_receipt') {
    const receipt = await get(database, 'ProcessReceipt', inbox.source_id);
    const sources = receipt ? await list(database, 'ProcessCompletionSourceLink', { process_id: receipt.process_id }, 2) : [];
    return sources.length === 1 && typeof sources[0].source_turn_id === 'string' ? sources[0].source_turn_id : null;
  }
  if (inbox?.source_kind === 'answer_submission') {
    const submission = await get(database, 'AnswerSubmission', inbox.source_id);
    const bridge = submission ? await get(database, 'AnswerBridge', submission.answer_bridge_id) : null;
    if (!submission || !bridge) return null;
    return requestingParentTurn(database, contentStore,
      requirePhaseFId(bridge.child_execution_id, 'AnswerBridge.child_execution_id'),
      requirePhaseFId(submission.turn_id, 'AnswerSubmission.turn_id'), visited);
  }
  return null;
}

/**
 * Resolves the immutable requester of one child task generation. Spawn uses its original parent
 * link, send uses its generation-owned Operation -> ToolCall, and runtime continuations inherit
 * the task whose result they handle. This does not relax the router's current-generation fences.
 */
export function childTaskRequestingParentTurn(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  childExecutionId: string,
  turnId: string
): Promise<string | null> {
  return requestingParentTurn(database, contentStore, requirePhaseFId(childExecutionId, 'childExecutionId'),
    requirePhaseFId(turnId, 'turnId'), new Set());
}

/** Only parent-dispatched task Turns, including their result continuations, publish task answers. */
export async function isChildTaskTurn(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnIdInput: string
): Promise<boolean> {
  const turnId = requirePhaseFId(turnIdInput, 'turnId');
  const memberships = await list(database, 'ChildExecutionTurnLink', { turn_id: turnId }, 2);
  if (memberships.length !== 1) return false;
  return await childTaskRequestingParentTurn(database, contentStore,
    requirePhaseFId(memberships[0].child_execution_id, 'ChildExecutionTurnLink.child_execution_id'), turnId) !== null;
}

/** Whether admitting this TurnIntent starts (or started) a Turn of the parent's task. */
export async function isChildTaskIntent(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  childExecutionId: string,
  turnIntentId: string
): Promise<boolean> {
  return await requestingParentForIntent(database, contentStore, childExecutionId, turnIntentId, new Set()) !== null;
}

/** The parent Conversation a task Turn answers; peer/user Turns never wait for a task answer. */
export async function childTaskTurnAnswersConversation(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnIdInput: string
): Promise<string | null> {
  const turnId = requirePhaseFId(turnIdInput, 'turnId');
  const memberships = await list(database, 'ChildExecutionTurnLink', { turn_id: turnId }, 2);
  if (memberships.length !== 1) return null;
  const parentTurnId = await childTaskRequestingParentTurn(database, contentStore,
    requirePhaseFId(memberships[0].child_execution_id, 'ChildExecutionTurnLink.child_execution_id'), turnId);
  const parentTurn = await get(database, 'Turn', parentTurnId);
  return typeof parentTurn?.conversation_id === 'string' ? parentTurn.conversation_id : null;
}

async function requestingParentTurn(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  childExecutionId: string,
  turnId: string,
  visited: Set<string>
): Promise<string | null> {
  if (visited.has(turnId)) return null;
  visited.add(turnId);
  try {
    const memberships = await list(database, 'ChildExecutionTurnLink', { turn_id: turnId }, 2);
    if (memberships.length !== 1 || memberships[0].child_execution_id !== childExecutionId) return null;
    const intents = await list(database, 'TurnIntent', { turn_id: turnId }, 2);
    if (intents.length === 0) {
      // Only the spawn generation is created without a TurnIntent.
      if (String(memberships[0].turn_seq) !== '1') return null;
      const parents = await list(database, 'ChildExecutionParentLink', { child_execution_id: childExecutionId }, 2);
      return parents.length === 1 && typeof parents[0].parent_turn_id === 'string' ? parents[0].parent_turn_id : null;
    }
    if (intents.length !== 1) throw new Error(`Turn ${turnId} was admitted from multiple TurnIntents.`);
    return await requestingParentForIntent(database, contentStore, childExecutionId,
      requirePhaseFId(intents[0].id, 'TurnIntent.id'), visited);
  } finally {
    visited.delete(turnId);
  }
}

async function requestingParentForIntent(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  childExecutionId: string,
  turnIntentId: string,
  visited: Set<string>
): Promise<string | null> {
  const deliveryLinks = await list(database, 'RuntimeDeliveryIntentLink', { turn_intent_id: turnIntentId }, 2);
  if (deliveryLinks.length > 0) {
    if (deliveryLinks.length !== 1) return null;
    const delivery = await get(database, 'RuntimeDelivery', deliveryLinks[0].delivery_id);
    if (!delivery) return null;
    const sourceTurnId = await deliverySourceTurn(database, contentStore,
      requirePhaseFId(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id'), visited);
    return sourceTurnId === null ? null : requestingParentTurn(database, contentStore, childExecutionId, sourceTurnId, visited);
  }
  // Only run_agent send freezes this preset; ordinary user/peer/retry input is not a parent task.
  const presets = await list(database, 'TurnExecutionPresetRevision', { intent_id: turnIntentId, revision_seq: '1' }, 2);
  if (presets.length !== 1) return null;
  const preset = await get(database, 'ContentObject', presets[0].preset_object_id);
  if (!preset || preset.content_type !== TURN_EXECUTION_PRESET_CONTENT_TYPE) return null;
  const value = JSON.parse((await contentStore.read(preset as ContentObjectMetadata)).toString('utf8')) as { kind?: unknown };
  if (value.kind !== 'child-continuation') return null;
  const intentLinks = await list(database, 'ChildExecutionIntentLink', {
    child_execution_id: childExecutionId, turn_intent_id: turnIntentId
  }, 2);
  if (intentLinks.length !== 1) return null;
  const turnId = childContinuationTurnId(childExecutionId, turnIntentId);
  let operations = await list(database, 'Operation', { owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND, owner_id: turnId }, 2);
  if (operations.length === 0) {
    // Preserve the existing exact shipped legacy identity check, shared with foreground recovery.
    const bridges = await list(database, 'AnswerBridge', { child_execution_id: childExecutionId }, 2);
    if (bridges.length !== 1) return null;
    const legacy = await listAllDomainRows(database, 'Operation', {
      owner_kind: LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND, owner_id: bridges[0].id
    });
    const allIntentLinks = await listAllDomainRows(database, 'ChildExecutionIntentLink', { child_execution_id: childExecutionId });
    // The legacy resolver also supports a queued Intent, before it has acquired a Turn.
    operations = await resolveLegacyContinuationWaitOperations(database, contentStore, {
      childExecutionId, operations: legacy, intentLinks: allIntentLinks, turnIntentId
    });
  }
  if (operations.length !== 1) return null;
  const toolCall = await get(database, 'ToolCall', operations[0].tool_call_id);
  const requester = toolCall ? await get(database, 'Turn', toolCall.turn_id) : null;
  const parents = await list(database, 'ChildExecutionParentLink', { child_execution_id: childExecutionId }, 2);
  const originalParent = parents.length === 1 ? await get(database, 'Turn', parents[0].parent_turn_id) : null;
  if (!requester || !originalParent || requester.conversation_id !== originalParent.conversation_id) return null;
  return requirePhaseFId(requester.id, 'requesting parent Turn.id');
}
