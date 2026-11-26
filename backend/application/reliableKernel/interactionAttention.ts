import type { ContentAddressedStore } from '../../reliableKernel/contentAddressedStore';
import {
  CHILD_INTENT_ANSWER_WAIT_OWNER_KIND,
  CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
  LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND,
  childContinuationTurnId
} from '../../reliableKernel/childSendLineage';
import { isChildTaskTurn } from '../../reliableKernel/childTaskTurn';
import type { RuntimeCommitResult } from '../../reliableKernel/contracts';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import type { RuntimeDatabase } from '../../reliableKernel/runtimeDatabase';
import { TURN_EXECUTION_PRESET_CONTENT_TYPE } from '../../reliableKernel/runtimeDeliveryContinuationIdentity';
import { displayConversationTitle } from '../../../shared/conversationTitle';
import { EXTENSION_BRAND } from '../../../shared/extensionIdentity';

export const INTERACTION_ATTENTION_ACTION = '打开标签页';

export type InteractionAttentionKind = 'ask_user' | 'plan_review';

export interface PendingInteractionAttention {
  requestId: string;
  kind: InteractionAttentionKind;
  conversationId: string;
  conversationTitle?: string;
  createdAt: number;
}

export interface InteractionAttentionHost {
  showInformationMessage(message: string, action: string): PromiseLike<string | undefined>;
  openConversation(request: { conversationId: string; conversationTitle?: string }): PromiseLike<unknown>;
  onError?(error: unknown): void;
}

interface InteractionAttentionGroup {
  key: string;
  kind: InteractionAttentionKind;
  conversationId: string;
  conversationTitle?: string;
  count: number;
  createdAt: number;
}

const INTERACTION_ATTENTION_DOMAINS = new Set([
  'InteractionRequest',
  'InteractionOwnerLink',
  'InteractionToolCallLink'
]);

/** Returns true when a committed batch may have changed a pending user decision. */
export function runtimeCommitNeedsInteractionAttention(
  commit: Pick<RuntimeCommitResult, 'changes'>
): boolean {
  return commit.changes.some((change) => INTERACTION_ATTENTION_DOMAINS.has(change.domain));
}

/**
 * Local-commit edge for attention: an ExecutionLease this Host newly holds (a new Turn or a recovery
 * claim) can turn an already pending interaction into this Host's to announce. Renewals keep the
 * generation and do not trigger a refresh.
 */
export class InteractionLeaseEdgeTracker {
  private readonly generations = new Map<string, string>();

  public constructor(private readonly hostBootId: string) {}

  public observe(commit: Pick<RuntimeCommitResult, 'changes'>): boolean {
    let acquired = false;
    for (const change of commit.changes) {
      if (change.domain !== 'ExecutionLease') continue;
      const record = change.kind === 'upsert' ? change.record : undefined;
      if (!record || record.host_boot_id !== this.hostBootId) {
        this.generations.delete(change.id);
        continue;
      }
      const generation = String(record.generation);
      if (this.generations.get(change.id) === generation) continue;
      this.generations.set(change.id, generation);
      acquired = true;
    }
    return acquired;
  }
}

/**
 * Pending ASK/Plan interactions this Host should announce: only those whose owner Turn's
 * ExecutionLease this Host holds. Exactly one Host holds a lease, so windows of other projects (and
 * peer windows of the same project) stay quiet; an unclaimed Turn is announced once its project's
 * Host recovers it.
 */
export async function readPendingInteractionAttention(
  database: RuntimeDatabase,
  hostBootId: string,
  contentStore?: ContentAddressedStore
): Promise<PendingInteractionAttention[]> {
  const requests = await listRows(database, 'InteractionRequest', { status: 'pending' }, 1000);
  const resolved = await Promise.all(requests.map((request) => resolvePendingInteractionAttention(
    database,
    hostBootId,
    request,
    contentStore
  )));
  return resolved.filter((request): request is PendingInteractionAttention => request !== undefined);
}

async function resolvePendingInteractionAttention(
  database: RuntimeDatabase,
  hostBootId: string,
  request: DomainRow,
  contentStore?: ContentAddressedStore
): Promise<PendingInteractionAttention | undefined> {
  const kind = interactionAttentionKind(request.request_kind);
  if (!kind) return undefined;
  const requestId = requireText(request.id, 'InteractionRequest.id');
  const owners = await listRows(database, 'InteractionOwnerLink', { request_id: requestId }, 2);
  if (owners.length !== 1) return undefined;
  const turnId = requireText(owners[0].turn_id, 'InteractionOwnerLink.turn_id');
  if (kind === 'plan_review') {
    const childMemberships = await listRows(database, 'ChildExecutionTurnLink', { turn_id: turnId }, 1);
    if (childMemberships.length > 0) return undefined;
  } else if (kind === 'ask_user') {
    // Only suppress VS Code attention toasts for parent-dispatched child-task Turns (which route
    // ask_user to the direct parent Agent). A user-authored Turn started directly inside a child
    // conversation tab still belongs to the human user and must keep its toast.
    const isTaskTurn = contentStore
      ? await isChildTaskTurn(database, contentStore, turnId)
      : await isChildTaskTurnWithoutContentStore(database, turnId);
    if (isTaskTurn) return undefined;
  }
  const leases = await listRows(database, 'ExecutionLease', { turn_id: turnId }, 2);
  if (leases.length !== 1 || leases[0].host_boot_id !== hostBootId) return undefined;
  const turn = await maybeRow(database, 'Turn', turnId);
  if (!turn) return undefined;
  const conversationId = requireText(turn.conversation_id, 'Turn.conversation_id');
  const conversation = await maybeRow(database, 'Conversation', conversationId);
  if (!conversation) return undefined;
  const conversationTitle = displayConversationTitle({
    id: conversationId,
    title: typeof conversation.title === 'string' ? conversation.title : ''
  });
  return {
    requestId,
    kind,
    conversationId,
    conversationTitle,
    createdAt: timestampMs(request.created_at)
  };
}

/** Extension Host-local notification dedupe; reliable Interaction rows remain the decision authority. */
export class InteractionAttentionNotifier {
  private readonly activeRequestIds = new Set<string>();

  public constructor(private readonly host: InteractionAttentionHost) {}

  public synchronize(requests: readonly PendingInteractionAttention[]): void {
    const ordered = [...requests].sort((left, right) =>
      left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId)
    );
    const pendingRequestIds = new Set(ordered.map((request) => request.requestId));
    for (const requestId of this.activeRequestIds) {
      if (!pendingRequestIds.has(requestId)) this.activeRequestIds.delete(requestId);
    }

    const newGroupKeys = new Set<string>();
    for (const request of ordered) {
      if (!this.activeRequestIds.has(request.requestId)) {
        newGroupKeys.add(groupKey(request));
      }
      this.activeRequestIds.add(request.requestId);
    }

    for (const group of groupPendingAttention(ordered)) {
      if (!newGroupKeys.has(group.key)) continue;
      void Promise.resolve(this.host.showInformationMessage(
        interactionAttentionMessage(group),
        INTERACTION_ATTENTION_ACTION
      )).then((selection) => {
        if (selection !== INTERACTION_ATTENTION_ACTION) return undefined;
        return this.host.openConversation({
          conversationId: group.conversationId,
          ...(group.conversationTitle ? { conversationTitle: group.conversationTitle } : {})
        });
      }).catch((error) => this.host.onError?.(error));
    }
  }

  public clear(): void {
    this.activeRequestIds.clear();
  }
}

export function interactionAttentionMessage(
  request: Pick<InteractionAttentionGroup, 'kind' | 'conversationTitle' | 'count'>
): string {
  const title = compactText(request.conversationTitle?.trim() || '当前对话', 36);
  if (request.kind === 'ask_user') {
    return request.count > 1
      ? `${EXTENSION_BRAND}：标签页“${title}”有 ${request.count} 个问题等待回答。`
      : `${EXTENSION_BRAND}：标签页“${title}”有问题等待回答。`;
  }
  return request.count > 1
    ? `${EXTENSION_BRAND}：标签页“${title}”有 ${request.count} 个 Plan 等待审批。`
    : `${EXTENSION_BRAND}：标签页“${title}”有 Plan 等待审批。`;
}

function groupPendingAttention(requests: readonly PendingInteractionAttention[]): InteractionAttentionGroup[] {
  const groups = new Map<string, InteractionAttentionGroup>();
  for (const request of requests) {
    const key = groupKey(request);
    const current = groups.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    groups.set(key, {
      key,
      kind: request.kind,
      conversationId: request.conversationId,
      ...(request.conversationTitle ? { conversationTitle: request.conversationTitle } : {}),
      count: 1,
      createdAt: request.createdAt
    });
  }
  return [...groups.values()].sort((left, right) =>
    left.createdAt - right.createdAt || left.key.localeCompare(right.key)
  );
}

function groupKey(request: Pick<PendingInteractionAttention, 'kind' | 'conversationId'>): string {
  return `${request.kind}:${request.conversationId}`;
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text;
}

function interactionAttentionKind(value: unknown): InteractionAttentionKind | undefined {
  return value === 'ask_user' || value === 'plan_review' ? value : undefined;
}

async function listRows(database: RuntimeDatabase, domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
  const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
  const rows = snapshot.snapshot[0];
  if (!Array.isArray(rows)) throw new TypeError(`${domain} list 未返回数组。`);
  return rows;
}

async function maybeRow(database: RuntimeDatabase, domain: string, id: string): Promise<DomainRow | null> {
  const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
  const row = snapshot.snapshot[0];
  return row && !Array.isArray(row) ? row : null;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串。`);
  return value.trim();
}

function timestampMs(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Mirrors childTaskTurn.isChildTaskTurn using durable relation rows when a caller omits contentStore. */
async function isChildTaskTurnWithoutContentStore(
  database: RuntimeDatabase,
  turnId: string
): Promise<boolean> {
  const memberships = await listRows(database, 'ChildExecutionTurnLink', { turn_id: turnId }, 2);
  if (memberships.length !== 1) return false;
  const childExecutionId = requireText(memberships[0].child_execution_id, 'ChildExecutionTurnLink.child_execution_id');
  return await requestingParentTurnWithoutContentStore(database, childExecutionId, turnId, new Set()) !== null;
}

async function requestingParentTurnWithoutContentStore(
  database: RuntimeDatabase,
  childExecutionId: string,
  turnId: string,
  visited: Set<string>
): Promise<string | null> {
  if (visited.has(turnId)) return null;
  visited.add(turnId);
  try {
    const memberships = await listRows(database, 'ChildExecutionTurnLink', { turn_id: turnId }, 2);
    if (memberships.length !== 1 || memberships[0].child_execution_id !== childExecutionId) return null;
    const intents = await listRows(database, 'TurnIntent', { turn_id: turnId }, 2);
    if (intents.length === 0) {
      if (String(memberships[0].turn_seq) !== '1') return null;
      const parents = await listRows(database, 'ChildExecutionParentLink', { child_execution_id: childExecutionId }, 2);
      return parents.length === 1 && typeof parents[0].parent_turn_id === 'string' ? parents[0].parent_turn_id : null;
    }
    if (intents.length !== 1) return null;
    const turnIntentId = requireText(intents[0].id, 'TurnIntent.id');
    const deliveryLinks = await listRows(database, 'RuntimeDeliveryIntentLink', { turn_intent_id: turnIntentId }, 2);
    if (deliveryLinks.length > 0) {
      if (deliveryLinks.length !== 1) return null;
      const delivery = await maybeRow(database, 'RuntimeDelivery', requireText(deliveryLinks[0].delivery_id, 'RuntimeDeliveryIntentLink.delivery_id'));
      if (!delivery) return null;
      const inbox = await maybeRow(database, 'RuntimeInboxItem', requireText(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id'));
      let sourceTurnId: string | null = null;
      if (inbox?.source_kind === 'process_receipt') {
        const receipt = await maybeRow(database, 'ProcessReceipt', requireText(inbox.source_id, 'RuntimeInboxItem.source_id'));
        const sources = receipt
          ? await listRows(database, 'ProcessCompletionSourceLink', { process_id: receipt.process_id }, 2)
          : [];
        sourceTurnId = sources.length === 1 && typeof sources[0].source_turn_id === 'string'
          ? sources[0].source_turn_id
          : null;
      } else if (inbox?.source_kind === 'answer_submission') {
        const submission = await maybeRow(database, 'AnswerSubmission', requireText(inbox.source_id, 'RuntimeInboxItem.source_id'));
        const bridge = submission
          ? await maybeRow(database, 'AnswerBridge', requireText(submission.answer_bridge_id, 'AnswerSubmission.answer_bridge_id'))
          : null;
        if (submission && bridge) {
          sourceTurnId = await requestingParentTurnWithoutContentStore(
            database,
            requireText(bridge.child_execution_id, 'AnswerBridge.child_execution_id'),
            requireText(submission.turn_id, 'AnswerSubmission.turn_id'),
            visited
          );
        }
      }
      return sourceTurnId === null
        ? null
        : await requestingParentTurnWithoutContentStore(database, childExecutionId, sourceTurnId, visited);
    }
    const [presets, intentLinks] = await Promise.all([
      listRows(database, 'TurnExecutionPresetRevision', { intent_id: turnIntentId, revision_seq: '1' }, 2),
      listRows(database, 'ChildExecutionIntentLink', { child_execution_id: childExecutionId, turn_intent_id: turnIntentId }, 2)
    ]);
    if (presets.length !== 1 || intentLinks.length !== 1) return null;
    const presetObj = await maybeRow(database, 'ContentObject', requireText(presets[0].preset_object_id, 'TurnExecutionPresetRevision.preset_object_id'));
    if (!presetObj || presetObj.content_type !== TURN_EXECUTION_PRESET_CONTENT_TYPE) return null;
    let operations = await listRows(database, 'Operation', {
      owner_kind: CHILD_INTENT_ANSWER_WAIT_OWNER_KIND,
      owner_id: turnIntentId
    }, 2);
    if (operations.length === 0) {
      operations = await listRows(database, 'Operation', {
        owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
        owner_id: childContinuationTurnId(childExecutionId, turnIntentId)
      }, 2);
    }
    if (operations.length === 0) {
      const bridges = await listRows(database, 'AnswerBridge', { child_execution_id: childExecutionId }, 2);
      if (bridges.length !== 1) return null;
      const legacy = await listRows(database, 'Operation', {
        owner_kind: LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND,
        owner_id: bridges[0].id
      }, 2);
      if (legacy.length === 0) return null;
      const parents = await listRows(database, 'ChildExecutionParentLink', { child_execution_id: childExecutionId }, 2);
      return parents.length === 1 && typeof parents[0].parent_turn_id === 'string' ? parents[0].parent_turn_id : null;
    }
    if (operations.length !== 1 || typeof operations[0].tool_call_id !== 'string') return null;
    const toolCall = await maybeRow(database, 'ToolCall', operations[0].tool_call_id);
    const requester = toolCall && typeof toolCall.turn_id === 'string'
      ? await maybeRow(database, 'Turn', toolCall.turn_id)
      : null;
    const parents = await listRows(database, 'ChildExecutionParentLink', { child_execution_id: childExecutionId }, 2);
    const originalParent = parents.length === 1 && typeof parents[0].parent_turn_id === 'string'
      ? await maybeRow(database, 'Turn', parents[0].parent_turn_id)
      : null;
    if (!requester || !originalParent || requester.conversation_id !== originalParent.conversation_id) return null;
    return requireText(requester.id, 'Turn.id');
  } finally {
    visited.delete(turnId);
  }
}
