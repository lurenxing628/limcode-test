import type { ContentAddressedStore } from './contentAddressedStore';
import { canonicalPlainJson } from './plainJson';
import { requirePhaseFId, requirePhaseFText, stablePhaseFId } from './phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';
import { TURN_EXECUTION_PRESET_CONTENT_TYPE } from './runtimeDeliveryContinuationIdentity';

export const CHILD_TURN_ANSWER_WAIT_OWNER_KIND = 'child_turn_answer_wait';
export const LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND = 'answer_bridge_wait';

export function sendIdentityIds(
  childExecutionId: string,
  sourceKey: string,
  sourceToolCallId: string,
  mode: 'queue_next_turn' | 'interrupt_current_turn'
) {
  const scope = [childExecutionId, sourceKey, sourceToolCallId, mode];
  return {
    commandReceiptId: stablePhaseFId('command_receipt', 'child-send', ...scope),
    turnIntentId: stablePhaseFId('turn_intent', 'child-send', ...scope),
    turnIntentRevisionId: stablePhaseFId('turn_intent_revision', 'child-send', ...scope),
    presetRevisionId: stablePhaseFId('turn_execution_preset_revision', 'child-send', ...scope),
    intentLinkId: stablePhaseFId('child_execution_intent_link', 'child-send', ...scope),
    pendingTurnInputId: stablePhaseFId('pending_turn_input', 'child-send-intent', childExecutionId, stablePhaseFId('turn_intent', 'child-send', ...scope)),
    operationId: stablePhaseFId('operation', 'child-send', ...scope),
    pauseId: stablePhaseFId('outcome_pause', 'child-send', ...scope)
  };
}

export function childContinuationTurnId(childExecutionId: string, turnIntentId: string): string {
  return stablePhaseFId('turn', 'child-continuation', childExecutionId, turnIntentId);
}

/**
 * Resolves only the one legacy owner shape shipped before Turn-generation ownership. The legacy
 * operation is accepted solely when its stable ids, parent ToolCall/CommandReceipt, TurnIntent,
 * immutable mode preset and ChildExecutionIntentLink reconstruct one child-send command.
 * Timestamps and sequence proximity never participate in the mapping.
 */
export async function resolveLegacyContinuationWaitOperations(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  input: {
    childExecutionId: string;
    operations: DomainRow[];
    intentLinks: DomainRow[];
    sourceTurnId?: string;
    turnIntentId?: string;
  }
): Promise<DomainRow[]> {
  if (input.operations.length === 0) return [];
  const child = await requireExisting(database, 'ChildExecution', input.childExecutionId);
  const intentLinksById = new Map(input.intentLinks.map((link) => [String(link.id), link]));
  const toolCallIds = [...new Set(input.operations.map((operation) =>
    requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id')
  ))];
  const toolCallSnapshot = await database.snapshot(toolCallIds.map((toolCallId) =>
    DOMAIN_REPOSITORIES.domain('ToolCall').get(toolCallId)
  ));
  const toolCallsById = new Map(toolCallIds.map((toolCallId, index) => [
    toolCallId,
    requireRow(toolCallSnapshot.snapshot[index], `ToolCall ${toolCallId}`)
  ]));
  const parentTurnIds = [...new Set([...toolCallsById.values()].map((toolCall) =>
    requirePhaseFId(toolCall.turn_id, 'ToolCall.turn_id')
  ))];
  const receiptGroups = await Promise.all(parentTurnIds.map((parentTurnId) =>
    listAllDomainRows(database, 'CommandReceipt', {
      source_kind: 'command',
      turn_id: parentTurnId
    })
  ));
  const receiptsByTurn = new Map(parentTurnIds.map((parentTurnId, index) => [
    parentTurnId,
    receiptGroups[index]
  ]));
  const matches: Array<{
    operation: DomainRow;
    ids: ReturnType<typeof sendIdentityIds>;
    mode: 'queue_next_turn' | 'interrupt_current_turn';
    targetTurnId: string;
    intentLink: DomainRow;
  }> = [];
  for (const operation of input.operations) {
    const operationId = requirePhaseFId(operation.id, 'Operation.id');
    const toolCallId = requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id');
    const toolCall = toolCallsById.get(toolCallId)!;
    const parentTurnId = requirePhaseFId(toolCall.turn_id, 'ToolCall.turn_id');
    const operationMatches: typeof matches = [];
    for (const receipt of receiptsByTurn.get(parentTurnId) ?? []) {
      const sourceKey = requirePhaseFText(receipt.source_key, 'CommandReceipt.source_key');
      for (const mode of ['queue_next_turn', 'interrupt_current_turn'] as const) {
        const ids = sendIdentityIds(input.childExecutionId, sourceKey, toolCallId, mode);
        if (ids.operationId !== operationId || ids.commandReceiptId !== receipt.id) continue;
        const intentLink = intentLinksById.get(ids.intentLinkId);
        if (
          !intentLink
          || intentLink.child_execution_id !== input.childExecutionId
          || intentLink.turn_intent_id !== ids.turnIntentId
        ) continue;
        operationMatches.push({
          operation,
          ids,
          mode,
          targetTurnId: childContinuationTurnId(input.childExecutionId, ids.turnIntentId),
          intentLink
        });
      }
    }
    if (operationMatches.length !== 1) {
      throw new Error(`Legacy continuation wait ${operationId} has no unique durable child-send identity.`);
    }
    if (
      (!input.sourceTurnId || operationMatches[0].targetTurnId === input.sourceTurnId)
      && (!input.turnIntentId || operationMatches[0].ids.turnIntentId === input.turnIntentId)
    ) {
      matches.push(operationMatches[0]);
    }
  }
  if (matches.length === 0) return [];
  const factSnapshot = await database.snapshot(matches.flatMap((match) => [
    DOMAIN_REPOSITORIES.domain('TurnIntent').get(match.ids.turnIntentId),
    DOMAIN_REPOSITORIES.domain('TurnIntentRevision').get(match.ids.turnIntentRevisionId),
    DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').get(match.ids.presetRevisionId)
  ]));
  const resolved: DomainRow[] = [];
  for (const [index, match] of matches.entries()) {
    const intent = requireRow(
      factSnapshot.snapshot[index * 3],
      `TurnIntent ${match.ids.turnIntentId}`
    );
    const revision = requireRow(
      factSnapshot.snapshot[index * 3 + 1],
      `TurnIntentRevision ${match.ids.turnIntentRevisionId}`
    );
    const preset = requireRow(
      factSnapshot.snapshot[index * 3 + 2],
      `TurnExecutionPresetRevision ${match.ids.presetRevisionId}`
    );
    const expectedPresetObjectId = contentStore.identity(
      canonicalPlainJson({ kind: 'child-continuation', mode: match.mode }),
      TURN_EXECUTION_PRESET_CONTENT_TYPE
    ).id;
    const expectedLinkState = intent.state === 'queued' ? 'pending' : intent.state;
    if (
      intent.conversation_id !== child.child_conversation_id
      || (intent.turn_id !== null && intent.turn_id !== match.targetTurnId)
      || revision.intent_id !== match.ids.turnIntentId
      || revision.revision_seq !== 1n
      || preset.intent_id !== match.ids.turnIntentId
      || preset.revision_seq !== 1n
      || preset.preset_object_id !== expectedPresetObjectId
      || match.intentLink.state !== expectedLinkState
    ) {
      throw new Error(
        `Legacy continuation wait ${String(match.operation.id)} has conflicting durable child-send facts.`
      );
    }
    if (input.sourceTurnId) {
      if (intent.state !== 'admitted' || intent.turn_id !== input.sourceTurnId) {
        throw new Error(
          `Legacy continuation wait ${String(match.operation.id)} is not admitted by its source Turn.`
        );
      }
    }
    resolved.push(match.operation);
  }
  return resolved;
}


async function requireExisting(database: RuntimeDatabase, domain: string, id: string): Promise<DomainRow> {
  return requireRow((await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0], `${domain} ${id}`);
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}
