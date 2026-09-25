import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { requirePhaseFId } from './phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { TURN_EXECUTION_PRESET_CONTENT_TYPE } from './runtimeDeliveryContinuationIdentity';
import type { RuntimeDatabase } from './runtimeDatabase';

/**
 * Read-only lineage facts about the Turns of a child task, shared by answer delivery, child
 * admission and collaboration wakes. Nothing here writes; every answer is derived from immutable
 * Turn, TurnIntent, delivery and preset facts.
 */

async function get(database: RuntimeDatabase, domain: string, id: unknown): Promise<DomainRow | null> {
  if (typeof id !== 'string' || id.length === 0) return null;
  return (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0] as DomainRow | null;
}

async function list(database: RuntimeDatabase, domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
  return (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })])).snapshot[0] as DomainRow[];
}

/**
 * The source Turn a Process or child-answer result belongs to: the Turn that started the Process,
 * or the parent Turn that spawned the answering child. Collaboration messages have no source Turn
 * of their own, and incomplete source facts resolve to null so the caller keeps the Turn's own rules.
 */
export async function runtimeDeliverySourceTurn(database: RuntimeDatabase, inboxItemIdInput: string): Promise<string | null> {
  const first = async (domain: string, where: DomainRow): Promise<DomainRow | null> => {
    const rows = await list(database, domain, where, 2);
    return rows.length === 1 ? rows[0] : null;
  };
  const inbox = await get(database, 'RuntimeInboxItem', requirePhaseFId(inboxItemIdInput, 'inboxItemId'));
  if (inbox?.source_kind === 'process_receipt') {
    const receipt = await get(database, 'ProcessReceipt', inbox.source_id);
    const source = receipt ? await first('ProcessCompletionSourceLink', { process_id: receipt.process_id }) : null;
    return typeof source?.source_turn_id === 'string' ? source.source_turn_id : null;
  }
  if (inbox?.source_kind === 'answer_submission') {
    const submission = await get(database, 'AnswerSubmission', inbox.source_id);
    const bridge = submission ? await get(database, 'AnswerBridge', submission.answer_bridge_id) : null;
    const parent = bridge ? await first('ChildExecutionParentLink', { child_execution_id: bridge.child_execution_id }) : null;
    return typeof parent?.parent_turn_id === 'string' ? parent.parent_turn_id : null;
  }
  return null;
}

/**
 * True when a child Turn works on the task its parent dispatched: the spawn Turn, a Turn a
 * run_agent send queued, or a continuation of such a Turn (its own background Process results,
 * the answers of its own children). Only these Turns answer the parent on the AnswerBridge. A Turn
 * the user started in the child Conversation, a peer's followup task, a Turn a peer message woke,
 * and continuations of those belong to someone else: they never publish, replace or deliver the
 * task answer.
 */
export async function isChildTaskTurn(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnIdInput: string
): Promise<boolean> {
  const turnId = requirePhaseFId(turnIdInput, 'turnId');
  const memberships = await list(database, 'ChildExecutionTurnLink', { turn_id: turnId }, 2);
  if (memberships.length !== 1) return false;
  return isTaskTurnOf(
    database,
    contentStore,
    requirePhaseFId(memberships[0].child_execution_id, 'ChildExecutionTurnLink.child_execution_id'),
    turnId,
    new Set()
  );
}

/** Whether admitting this TurnIntent starts (or started) a Turn of the parent's task. */
export function isChildTaskIntent(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  childExecutionId: string,
  turnIntentId: string
): Promise<boolean> {
  return isTaskIntent(database, contentStore, childExecutionId, turnIntentId, new Set());
}

/**
 * The parent Conversation a child task Turn answers: the Conversation of the Turn that spawned its
 * child. Null for any Turn that is not a child task Turn, so its messages never wait for an answer.
 */
export async function childTaskTurnAnswersConversation(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnIdInput: string
): Promise<string | null> {
  const turnId = requirePhaseFId(turnIdInput, 'turnId');
  if (!await isChildTaskTurn(database, contentStore, turnId)) return null;
  const [membership] = await list(database, 'ChildExecutionTurnLink', { turn_id: turnId }, 1);
  const [parentLink] = await list(database, 'ChildExecutionParentLink', { child_execution_id: membership.child_execution_id }, 2);
  const parentTurn = parentLink ? await get(database, 'Turn', parentLink.parent_turn_id) : null;
  return typeof parentTurn?.conversation_id === 'string' ? parentTurn.conversation_id : null;
}

async function isTaskTurnOf(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  childExecutionId: string,
  turnId: string,
  visited: Set<string>
): Promise<boolean> {
  if (visited.has(turnId)) return false;
  visited.add(turnId);
  const memberships = await list(database, 'ChildExecutionTurnLink', { turn_id: turnId }, 2);
  if (memberships.length !== 1 || memberships[0].child_execution_id !== childExecutionId) return false;
  const intents = await list(database, 'TurnIntent', { turn_id: turnId }, 2);
  // The spawn Turn is created together with its ChildExecution and has no TurnIntent.
  if (intents.length === 0) return true;
  if (intents.length !== 1) throw new Error(`Turn ${turnId} was admitted from multiple TurnIntents.`);
  return isTaskIntent(database, contentStore, childExecutionId, requirePhaseFId(intents[0].id, 'TurnIntent.id'), visited);
}

async function isTaskIntent(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  childExecutionId: string,
  turnIntentId: string,
  visited: Set<string>
): Promise<boolean> {
  const deliveryLinks = await list(database, 'RuntimeDeliveryIntentLink', { turn_intent_id: turnIntentId }, 2);
  if (deliveryLinks.length > 0) {
    const delivery = await get(database, 'RuntimeDelivery', deliveryLinks[0].delivery_id);
    if (!delivery) return false;
    // A continuation belongs to the Turn whose result it handles; a peer's task or message has none.
    const sourceTurnId = await runtimeDeliverySourceTurn(
      database,
      requirePhaseFId(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id')
    );
    return sourceTurnId !== null && isTaskTurnOf(database, contentStore, childExecutionId, sourceTurnId, visited);
  }
  // Only run_agent send freezes the child-continuation preset for the Turn it queues.
  const presets = await list(database, 'TurnExecutionPresetRevision', { intent_id: turnIntentId, revision_seq: '1' }, 2);
  if (presets.length !== 1) return false;
  const preset = await get(database, 'ContentObject', presets[0].preset_object_id);
  if (!preset || preset.content_type !== TURN_EXECUTION_PRESET_CONTENT_TYPE) return false;
  const value = JSON.parse((await contentStore.read(preset as ContentObjectMetadata)).toString('utf8')) as { kind?: unknown };
  return value.kind === 'child-continuation';
}
