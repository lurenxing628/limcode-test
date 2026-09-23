import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { AutomaticRuntimeDeliveryRouter } from './automaticRuntimeDelivery';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { RuntimeDeliveryControlPlane } from './answerDelivery';
import { isCrossConversationFollowup } from './collaborationScope';
import { ConversationOwnershipGate } from './conversationOwnershipGate';
import {
  requireIsoTimestamp,
  requirePhaseFId,
  requirePhaseFText,
  sqliteUniqueFailureIncludes,
  stablePhaseFId
} from './phaseFIdentity';
import { ProcessControlPlane, type ProcessOutputReadResult } from './processEffects';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export const PROCESS_COMPLETION_CONTENT_TYPE = 'application/vnd.limcode.process-completion+json';
export const PROCESS_COMPLETION_MAX_PAYLOAD_BYTES = 12_000;
const PROCESS_COMPLETION_MAX_OUTPUT_BYTES = 8_000;
const DEFAULT_SCAN_INTERVAL_MS = 5_000;
const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_FAILURE_COUNT = 8;

export type ProcessCompletionWakeAction =
  | 'resume_current_turn'
  | 'start_continuation'
  | 'notify_only';

export interface ProcessCompletionWakeRequest {
  wakeId: string;
  deliveryId: string;
  inboxItemId: string;
  sourceKind: 'process_receipt' | 'answer_submission' | 'child_failure' | 'collaboration_message';
  sourceId: string;
  processId?: string;
  processReceiptId?: string;
  conversationId: string;
  /** Null only for a collaboration message to a Conversation that has no Turn yet. */
  sourceTurnId: string | null;
  targetTurnId: string | null;
  contentObjectId: string;
  action: ProcessCompletionWakeAction;
  childExecutionId?: string;
}

/**
 * Product scheduler contract:
 * - resume_current_turn: enqueue the target Turn, then advance/inject only at its model/tool boundary;
 * - start_continuation: durably create an internal sourceTurn-authority continuation whose admission
 *   includes RuntimeDeliveryControlPlane.prepareNextTurnDeliverySteps;
 * - notify_only: publish a durable/user-visible notification and acknowledge that delivery.
 * Returning acknowledged=true means one of those actions is durably recoverable after host restart.
 */
export type ProcessCompletionWakeHandler = (
  request: ProcessCompletionWakeRequest
) => Promise<{ acknowledged: boolean }>;

export interface ProcessCompletionDeliveryOptions {
  now?: () => string;
  scanIntervalMs?: number;
  claimTtlMs?: number;
  retryBaseMs?: number;
  maxFailureCount?: number;
  wakeHandler?: ProcessCompletionWakeHandler;
  onError?: (input: {
    scope: 'receipt' | 'wake' | 'scan';
    id: string;
    error: unknown;
  }) => void;
}

export interface ProcessCompletionDeliveryScanReport {
  receiptsScanned: number;
  completionsCreated: number;
  deliveriesCreated: number;
  wakesCreated: number;
  wakesAcknowledged: number;
  foregroundReceiptsSkipped: number;
  failures: number;
}

interface CompletionFacts {
  inboxItem: DomainRow;
  payloadLink: DomainRow;
  created: boolean;
}

interface DeliveryFacts {
  delivery: DomainRow;
  wake: DomainRow;
  deliveryCreated: boolean;
  wakeCreated: boolean;
}

/**
 * ProcessReceipt -> bounded CAS payload -> RuntimeInbox -> RuntimeDelivery -> durable wake outbox.
 *
 * The scanner is deliberately level-triggered. Process exit callbacks only request an early scan;
 * startup and the periodic pass derive all missing facts from SQLite, so a callback lost at any
 * crash boundary cannot strand a completed detached Process.
 */
export class ProcessCompletionDeliveryControlPlane {
  private readonly now: () => string;
  private readonly scanIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly retryBaseMs: number;
  private readonly maxFailureCount: number;
  private readonly onError: ProcessCompletionDeliveryOptions['onError'];
  private readonly automaticDeliveryRouter: AutomaticRuntimeDeliveryRouter;
  private wakeHandler: ProcessCompletionWakeHandler | undefined;
  private started = false;
  private closing = false;
  private scanRequested = false;
  private scanPromise: Promise<ProcessCompletionDeliveryScanReport> | undefined;
  private loopPromise: Promise<void> | undefined;
  private readonly loopWakeups = new Set<() => void>();
  private retryPollingNeeded = false;
  private externalDataVersion: string | undefined;
  private readonly unsubscribeCommit: () => void;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly processes: ProcessControlPlane,
    private readonly deliveries: RuntimeDeliveryControlPlane,
    options: ProcessCompletionDeliveryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.scanIntervalMs = requireScanInterval(options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
    this.claimTtlMs = requireBoundedMilliseconds(options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS, 'claimTtlMs', 100, 300_000);
    this.retryBaseMs = requireBoundedMilliseconds(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, 'retryBaseMs', 10, 60_000);
    this.maxFailureCount = requirePositiveInteger(options.maxFailureCount ?? DEFAULT_MAX_FAILURE_COUNT, 'maxFailureCount', 100);
    this.wakeHandler = options.wakeHandler;
    this.onError = options.onError;
    this.automaticDeliveryRouter = new AutomaticRuntimeDeliveryRouter(database);
    this.unsubscribeCommit = database.onCommit((commit) => {
      if (!commit.changes.some((change) => [
        'ProcessReceipt',
        'ProcessCompletionDispatch',
        'RuntimeDelivery',
        'RuntimeDeliveryInputLink',
        'Turn',
        'CollaborationMessage'
      ].includes(change.domain))) return;
      if (this.started) this.requestScan();
    });
  }

  public setWakeHandler(handler: ProcessCompletionWakeHandler | undefined): void {
    this.wakeHandler = handler;
    this.requestScan();
  }

  /** Fast edge hint only; the durable ProcessReceipt remains the level-trigger authority. */
  public notifyProcessReceipt(_processId: string): void {
    this.requestScan();
  }

  /** Edge hint for every RuntimeDelivery source; the periodic level scan closes lost callbacks. */
  public notifyRuntimeDelivery(_deliveryId: string): void {
    this.requestScan();
  }

  public async start(): Promise<ProcessCompletionDeliveryScanReport> {
    if (this.closing) throw new Error('Process completion delivery dispatcher is closing.');
    if (this.started) return this.scanNow();
    this.started = true;
    this.externalDataVersion = await this.database.externalDataVersion();
    const report = await this.scanNow();
    const afterScanVersion = await this.database.externalDataVersion();
    if (afterScanVersion !== this.externalDataVersion) this.requestScan();
    this.externalDataVersion = afterScanVersion;
    this.loopPromise = this.runLoop();
    return report;
  }

  public scanNow(): Promise<ProcessCompletionDeliveryScanReport> {
    if (this.scanPromise) return this.scanPromise;
    this.scanRequested = false;
    const tracked = this.scanOnce()
      .catch((error) => {
        this.retryPollingNeeded = true;
        throw error;
      })
      .finally(() => {
        if (this.scanPromise === tracked) this.scanPromise = undefined;
      });
    this.scanPromise = tracked;
    return tracked;
  }

  public async dispose(): Promise<void> {
    if (this.closing) {
      await this.loopPromise;
      await this.scanPromise;
      return;
    }
    this.closing = true;
    this.started = false;
    this.unsubscribeCommit();
    for (const wake of [...this.loopWakeups]) wake();
    await this.loopPromise;
    await this.scanPromise;
  }

  private requestScan(): void {
    this.scanRequested = true;
    for (const wake of [...this.loopWakeups]) wake();
  }

  private async runLoop(): Promise<void> {
    while (!this.closing) {
      await this.waitForScan();
      if (this.closing) return;
      if (!this.scanRequested && !this.retryPollingNeeded) {
        const version = await this.database.externalDataVersion();
        if (this.closing) return;
        if (version === this.externalDataVersion) continue;
        this.externalDataVersion = version;
      }
      await this.scanNow().catch((error) => this.reportError('scan', 'level-trigger', error));
    }
  }

  private waitForScan(): Promise<void> {
    if (this.closing || this.scanRequested) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.loopWakeups.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, this.scanIntervalMs);
      timer.unref?.();
      this.loopWakeups.add(finish);
    });
  }

  private async scanOnce(): Promise<ProcessCompletionDeliveryScanReport> {
    const report: ProcessCompletionDeliveryScanReport = {
      receiptsScanned: 0,
      completionsCreated: 0,
      deliveriesCreated: 0,
      wakesCreated: 0,
      wakesAcknowledged: 0,
      foregroundReceiptsSkipped: 0,
      failures: 0
    };
    if (this.closing) return report;
    // Sweep facts that pre-date this pass. Facts created later by a failing reconciliation remain a
    // real crash boundary and are picked up by the next level-triggered pass.
    report.wakesCreated += await this.ensureRecoverableDeliveryWakes();
    // Durable outbox rows stay host-agnostic, but only the target Conversation's owner may settle
    // or dispatch its mutable execution. Foreign rows are left pending untouched — never claimed,
    // never failed, never dead-lettered — so the owning Host's own level scan converges them.
    const gate = new ConversationOwnershipGate(this.database, 'claim');
    // Wakes left waiting behind their target's running Turn need no poll: that Turn's terminal
    // commit requests a scan here, and another Host's commit moves the external data version.
    const waitingWakeIds = new Set<string>();
    try {
    const dispatches = [
      ...await listAllDomainRows(this.database, 'ProcessCompletionDispatch', { state: 'pending' }),
      ...await listAllDomainRows(this.database, 'ProcessCompletionDispatch', { state: 'claimed' })
    ];
    report.receiptsScanned = dispatches.length;
    for (const dispatch of dispatches) {
      if (this.closing) break;
      const dispatchId = requirePhaseFId(dispatch.id, 'ProcessCompletionDispatch.id');
      let claim: DomainRow | null = null;
      try {
        const targetConversationId = await this.dispatchConversationId(dispatch);
        if (targetConversationId !== null && !await gate.check(targetConversationId)) continue;
        claim = await this.claimOutbox('ProcessCompletionDispatch', dispatch);
        if (!claim) continue;
        const claimedDispatch = claim;
        const reconciled = targetConversationId === null
          ? { ran: true as const, value: await this.reconcileDispatch(claimedDispatch) }
          : await gate.run(targetConversationId, () => this.reconcileDispatch(claimedDispatch));
        if (!reconciled.ran) {
          await this.releaseClaim('ProcessCompletionDispatch', claim, { immediate: true }).catch(() => undefined);
          continue;
        }
        const result = reconciled.value;
        if (result.completion.created) report.completionsCreated += 1;
        if (result.delivery.deliveryCreated) report.deliveriesCreated += 1;
        if (result.delivery.wakeCreated) report.wakesCreated += 1;
        await this.completeDispatchClaim(claim);
      } catch (error) {
        report.failures += 1;
        if (claim) await this.failClaim('ProcessCompletionDispatch', claim, error).catch(() => undefined);
        this.reportError('receipt', dispatchId, error);
      }
    }

    const wakes = await this.oldestDeliveryFirst([
      ...await listAllDomainRows(this.database, 'RuntimeDeliveryWake', { state: 'pending' }),
      ...await listAllDomainRows(this.database, 'RuntimeDeliveryWake', { state: 'claimed' })
    ]);
    for (const wake of wakes) {
      if (this.closing) break;
      const wakeId = requirePhaseFId(wake.id, 'RuntimeDeliveryWake.id');
      let claim: DomainRow | null = null;
      try {
        const targetConversationId = await this.wakeConversationId(wake);
        if (targetConversationId !== null && !await gate.check(targetConversationId)) continue;
        // Read-only and only on the owning Host: a send queued behind its target's running Turn
        // stays untouched (no claim, backoff or failure count) until that Turn's terminal commit
        // triggers the next scan.
        if (wake.state === 'pending' && await this.queuedBehindActiveTurn(wake)) {
          waitingWakeIds.add(wakeId);
          continue;
        }
        claim = await this.claimOutbox('RuntimeDeliveryWake', wake);
        if (!claim) continue;
        const claimedWake = claim;
        const dispatched = targetConversationId === null
          ? { ran: true as const, value: await this.dispatchWake(claimedWake) }
          : await gate.run(targetConversationId, () => this.dispatchWake(claimedWake));
        if (!dispatched.ran) {
          await this.releaseClaim('RuntimeDeliveryWake', claim, { immediate: true }).catch(() => undefined);
          continue;
        }
        if (dispatched.value === 'acknowledged') {
          report.wakesAcknowledged += 1;
        } else if (dispatched.value === 'retry') {
          await this.releaseClaim('RuntimeDeliveryWake', claim);
        } else if (dispatched.value === 'deferred') {
          await this.releaseClaim('RuntimeDeliveryWake', claim, { immediate: true });
        }
      } catch (error) {
        report.failures += 1;
        if (claim) await this.failClaim('RuntimeDeliveryWake', claim, error).catch(() => undefined);
        this.reportError('wake', wakeId, error);
      }
    }
    } finally {
      await gate.releaseClaimed();
    }
    this.retryPollingNeeded = !this.closing && await this.hasOutstandingOutboxWork(waitingWakeIds);
    return report;
  }

  /**
   * Wakes ordered by their delivery's creation, oldest first. Followups queued behind one target
   * Turn each start a Turn of their own once it ends; this order starts them in the order they were
   * sent instead of by hash id, so a busy target never lets newer tasks overtake an older one.
   */
  private async oldestDeliveryFirst(wakes: DomainRow[]): Promise<DomainRow[]> {
    const keyed: Array<{ wake: DomainRow; createdAt: string; deliveryId: string }> = [];
    for (const wake of wakes) {
      let delivery: DomainRow | null = null;
      try {
        delivery = await this.maybeGet('RuntimeDelivery', requirePhaseFId(wake.delivery_id, 'RuntimeDeliveryWake.delivery_id'));
      } catch {
        // Malformed facts surface through the normal claimed dispatch failure path.
      }
      keyed.push({ wake, createdAt: String(delivery?.created_at ?? ''), deliveryId: String(delivery?.id ?? '') });
    }
    return keyed.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.deliveryId.localeCompare(right.deliveryId)
      || String(left.wake.id).localeCompare(String(right.wake.id))).map((entry) => entry.wake);
  }

  /** Conversation that owns this dispatch's completion chain; null defers to reconcile validation. */
  private async dispatchConversationId(dispatch: DomainRow): Promise<string | null> {
    try {
      const receipt = await this.maybeGet(
        'ProcessReceipt',
        requirePhaseFId(dispatch.process_receipt_id, 'ProcessCompletionDispatch.process_receipt_id')
      );
      if (!receipt) return null;
      const sources = await this.listRows('ProcessCompletionSourceLink', { process_id: receipt.process_id }, 1);
      return sources[0]
        ? requirePhaseFId(sources[0].conversation_id, 'ProcessCompletionSourceLink.conversation_id')
        : null;
    } catch {
      // Resolution races surface through the normal reconcile failure path instead.
      return null;
    }
  }

  /**
   * True only while a collaboration delivery waits for its target's running Turn: the Turn it was
   * anchored to, or, for a cross-conversation followup, any Turn running in the target.
   */
  private async queuedBehindActiveTurn(wake: DomainRow): Promise<boolean> {
    try {
      const delivery = await this.maybeGet(
        'RuntimeDelivery',
        requirePhaseFId(wake.delivery_id, 'RuntimeDeliveryWake.delivery_id')
      );
      if (!delivery || delivery.state !== 'pending' || delivery.phase !== 'next_turn' || delivery.target_turn_id !== null) return false;
      const inbox = await this.maybeGet('RuntimeInboxItem', requirePhaseFId(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id'));
      if (!inbox || inbox.source_kind !== 'collaboration_message') return false;
      const messageId = requirePhaseFId(inbox.source_id, 'RuntimeInboxItem.source_id');
      const [targets, sources] = await Promise.all([
        this.listRows('CollaborationMessageTargetLink', { message_id: messageId }, 2),
        this.listRows('CollaborationMessageSourceLink', { message_id: messageId }, 2)
      ]);
      if (targets.length !== 1 || sources.length !== 1 || sources[0].source_kind === 'board') return false;
      if (targets[0].anchor_turn_id !== null) {
        const anchor = await this.maybeGet('Turn', requirePhaseFId(targets[0].anchor_turn_id, 'CollaborationMessageTargetLink.anchor_turn_id'));
        if (anchor?.status === 'active' && anchor.conversation_id === delivery.target_conversation_id) return true;
      }
      if (!await isCrossConversationFollowup(this.database, messageId)) return false;
      return (await this.listRows('Turn', { conversation_id: delivery.target_conversation_id, status: 'active' }, 1)).length > 0;
    } catch {
      // Malformed facts surface through the normal claimed dispatch failure path.
      return false;
    }
  }

  /** Conversation a wake dispatches into; null defers to the dispatch-time source validation. */
  private async wakeConversationId(wake: DomainRow): Promise<string | null> {
    try {
      const delivery = await this.maybeGet(
        'RuntimeDelivery',
        requirePhaseFId(wake.delivery_id, 'RuntimeDeliveryWake.delivery_id')
      );
      return delivery
        ? requirePhaseFId(delivery.target_conversation_id, 'RuntimeDelivery.target_conversation_id')
        : null;
    } catch {
      return null;
    }
  }

  /** Outbox work a periodic poll must retry; wakes known to wait behind a running Turn do not count. */
  private async hasOutstandingOutboxWork(waitingWakeIds: ReadonlySet<string>): Promise<boolean> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').list({
        where: { state: 'pending' },
        limit: 1
      }),
      DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').list({
        where: { state: 'claimed' },
        limit: 1
      }),
      DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').list({
        where: { state: 'claimed' },
        limit: 1
      }),
      // One more row than the waiting set: any pending wake outside it is returned.
      DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').list({
        where: { state: 'pending' },
        limit: waitingWakeIds.size + 1
      })
    ]);
    const [pendingDispatches, claimedDispatches, claimedWakes, pendingWakes] = snapshot.snapshot as DomainRow[][];
    return pendingDispatches.length > 0 || claimedDispatches.length > 0 || claimedWakes.length > 0
      || pendingWakes.some((wake) => !waitingWakeIds.has(String(wake.id)));
  }

  private async reconcileDispatch(dispatch: DomainRow): Promise<{
    completion: CompletionFacts;
    delivery: DeliveryFacts;
  }> {
    const receipt = await this.requireExisting(
      'ProcessReceipt',
      requirePhaseFId(dispatch.process_receipt_id, 'ProcessCompletionDispatch.process_receipt_id')
    );
    const processId = requirePhaseFId(receipt.process_id, 'ProcessReceipt.process_id');
    const processOperations = await listAllDomainRows(this.database, 'Operation', {
      owner_kind: 'process',
      owner_id: processId
    });
    const exitOperations: DomainRow[] = [];
    for (const operation of processOperations) {
      // stop_process owns an attached Process Operation. It is deliberately not part of completion
      // delivery and must never poison the detached process_exit selector.
      if (operation.tool_call_id !== null) continue;
      const attempts = await this.listRows('Attempt', { operation_id: operation.id }, 2);
      for (const attempt of attempts) {
        const intents = await this.listRows('EffectIntent', { attempt_id: attempt.id }, 2);
        if (intents.some((intent) => intent.effect_kind === 'process_exit')) {
          exitOperations.push(operation);
          break;
        }
      }
    }
    if (exitOperations.length !== 1) {
      throw new Error(`Background Process ${processId} must have exactly one detached process_exit Operation.`);
    }

    const sourceRows = await this.listRows('ProcessCompletionSourceLink', { process_id: processId }, 2);
    if (sourceRows.length !== 1) throw new Error(`Process ${processId} must have exactly one frozen completion source link.`);
    const source = sourceRows[0];
    const toolCallId = requirePhaseFId(source.source_tool_call_id, 'ProcessCompletionSourceLink.source_tool_call_id');
    const sourceTurnId = requirePhaseFId(source.source_turn_id, 'ProcessCompletionSourceLink.source_turn_id');
    const conversationId = requirePhaseFId(source.conversation_id, 'ProcessCompletionSourceLink.conversation_id');
    const completion = await this.ensureCompletionFacts({
      receipt,
      processId,
      toolCallId,
      sourceTurnId,
      conversationId,
      sourceLink: source
    });
    await this.processes.cleanupArchivedSpool(processId).catch((error) => {
      console.warn(
        `[reliable-kernel] failed to clean delivered process spool ${processId}:`,
        error instanceof Error ? error.message : String(error)
      );
    });
    const delivery = await this.ensureDeliveryFacts(completion.inboxItem, {
      conversationId,
      sourceTurnId
    });
    return { completion, delivery };
  }

  private async ensureCompletionFacts(input: {
    receipt: DomainRow;
    processId: string;
    toolCallId: string;
    sourceTurnId: string;
    conversationId: string;
    sourceLink: DomainRow;
  }): Promise<CompletionFacts> {
    const receiptId = requirePhaseFId(input.receipt.id, 'ProcessReceipt.id');
    const ids = completionIds(receiptId);
    const existing = await this.listRows('RuntimeInboxItem', { dedupe_key: processCompletionDedupeKey(receiptId) }, 2);
    if (existing.length > 0) return this.validateCompletionReplay(existing, ids, receiptId);

    let output: ProcessOutputReadResult | undefined;
    let outputError: string | undefined;
    try {
      await this.processes.reconcileOutput(input.processId);
      output = await this.processes.readOutputTail(input.processId, PROCESS_COMPLETION_MAX_OUTPUT_BYTES);
    } catch (error) {
      outputError = boundedError(error);
    }
    const bytes = encodeProcessCompletionPayload({
      receipt: input.receipt,
      processId: input.processId,
      toolCallId: input.toolCallId,
      sourceTurnId: input.sourceTurnId,
      conversationId: input.conversationId,
      output,
      outputError
    });
    const content = await this.contentStore.prepare(this.database, bytes, PROCESS_COMPLETION_CONTENT_TYPE);
    const now = this.timestamp();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('ProcessReceipt').assert(receiptId, {
          process_id: input.processId,
          outcome: input.receipt.outcome
        }),
        DOMAIN_REPOSITORIES.domain('ProcessCompletionSourceLink').assert(
          requirePhaseFId(input.sourceLink.id, 'ProcessCompletionSourceLink.id'),
          {
            process_id: input.processId,
            conversation_id: input.conversationId,
            source_turn_id: input.sourceTurnId,
            source_tool_call_id: input.toolCallId
          }
        ),
        ...preparedContentObjectSteps([content], 'process_completion_payload'),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').insert({
          id: ids.inboxItemId,
          dedupe_key: processCompletionDedupeKey(receiptId),
          source_kind: 'process_receipt',
          source_id: receiptId,
          state: 'available',
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxPayloadLink').insert({
          id: ids.payloadLinkId,
          inbox_item_id: ids.inboxItemId,
          content_object_id: content.metadata.id,
          created_at: now
        })
      ]);
      return {
        inboxItem: await this.requireExisting('RuntimeInboxItem', ids.inboxItemId),
        payloadLink: await this.requireExisting('RuntimeInboxPayloadLink', ids.payloadLinkId),
        created: true
      };
    } catch (error) {
      if (!sqliteUniqueFailureIncludes(error, [
        'runtime_inbox_item.id',
        'runtime_inbox_item.dedupe_key',
        'runtime_inbox_payload_link.id',
        'runtime_inbox_payload_link.inbox_item_id'
      ])) throw error;
      const raced = await this.listRows('RuntimeInboxItem', {
        dedupe_key: processCompletionDedupeKey(receiptId)
      }, 2);
      return this.validateCompletionReplay(raced, ids, receiptId);
    }
  }

  private async validateCompletionReplay(
    inboxRows: DomainRow[],
    ids: ReturnType<typeof completionIds>,
    receiptId: string
  ): Promise<CompletionFacts> {
    if (inboxRows.length !== 1) throw new Error('Process completion RuntimeInboxItem dedupe identity is not unique.');
    const inbox = inboxRows[0];
    if (
      inbox.id !== ids.inboxItemId
      || inbox.source_kind !== 'process_receipt'
      || inbox.source_id !== receiptId
    ) throw new Error('Process completion RuntimeInboxItem replay has conflicting source facts.');
    const links = await this.listRows('RuntimeInboxPayloadLink', { inbox_item_id: ids.inboxItemId }, 2);
    if (links.length !== 1 || links[0].id !== ids.payloadLinkId) {
      throw new Error('Process completion RuntimeInboxItem is missing its one-to-one payload link.');
    }
    return { inboxItem: inbox, payloadLink: links[0], created: false };
  }

  private async ensureDeliveryFacts(
    inboxItem: DomainRow,
    source: { conversationId: string; sourceTurnId: string }
  ): Promise<DeliveryFacts> {
    const inboxItemId = requirePhaseFId(inboxItem.id, 'RuntimeInboxItem.id');
    // A failed delivery may have later manual retry attempts. Receipt replay owns attempt 1 only;
    // retries are independent durable rows and receive their wakes from the level-trigger sweep.
    const existing = await this.listRows('RuntimeDelivery', {
      inbox_item_id: inboxItemId,
      target_conversation_id: source.conversationId,
      attempt_seq: 1n
    }, 2);
    let delivery: DomainRow;
    let deliveryCreated = false;
    if (existing.length === 1) {
      delivery = existing[0];
      if (delivery.target_conversation_id !== source.conversationId) {
        throw new Error('Process completion delivery replay targets a different Conversation.');
      }
    } else {
      if (existing.length > 1) throw new Error('Process completion RuntimeInboxItem has multiple first-attempt deliveries.');
      const created = await this.deliveries.createAutomatic({
        inboxItemId,
        targetConversationId: source.conversationId,
        sourceTurnId: source.sourceTurnId
      });
      delivery = created.delivery;
      deliveryCreated = !created.deduplicated;
    }

    const ensuredWake = await this.ensureWakeForDelivery(delivery);
    const wake = ensuredWake.wake;
    const wakeCreated = ensuredWake.created;
    return { delivery, wake, deliveryCreated, wakeCreated };
  }

  private async ensureRecoverableDeliveryWakes(): Promise<number> {
    const pending = await listAllDomainRows(this.database, 'RuntimeDelivery', { state: 'pending' });
    const unhandledLinks = await listAllDomainRows(this.database, 'RuntimeDeliveryInputLink', {
      handled_at: null
    });
    const byId = new Map<string, DomainRow>();
    for (const delivery of pending) byId.set(requirePhaseFId(delivery.id, 'RuntimeDelivery.id'), delivery);
    for (const link of unhandledLinks) {
      const deliveryId = requirePhaseFId(link.delivery_id, 'RuntimeDeliveryInputLink.delivery_id');
      if (byId.has(deliveryId)) continue;
      const delivery = await this.maybeGet('RuntimeDelivery', deliveryId);
      if (delivery?.state === 'consumed') byId.set(deliveryId, delivery);
    }
    let created = 0;
    for (const delivery of byId.values()) {
      const inbox = await this.requireExisting(
        'RuntimeInboxItem',
        requirePhaseFId(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id')
      );
      if (!['process_receipt', 'answer_submission', 'collaboration_message'].includes(String(inbox.source_kind))) continue;
      if (inbox.source_kind === 'collaboration_message' && delivery.state === 'pending') {
        const message = await this.requireExisting('CollaborationMessage', String(inbox.source_id));
        if (message.mode === 'message' && delivery.target_turn_id === null) continue;
      }
      if ((await this.ensureWakeForDelivery(delivery)).created) created += 1;
    }
    return created;
  }

  private async ensureWakeForDelivery(delivery: DomainRow): Promise<{ wake: DomainRow; created: boolean }> {
    const deliveryId = requirePhaseFId(delivery.id, 'RuntimeDelivery.id');
    const inboxItemId = requirePhaseFId(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id');
    const wakeId = stablePhaseFId('runtime_delivery_wake', deliveryId);
    const existingWakes = await this.listRows('RuntimeDeliveryWake', { delivery_id: deliveryId }, 2);
    if (existingWakes.length === 1) {
      if (existingWakes[0].id !== wakeId) {
        throw new Error('RuntimeDeliveryWake replay has a conflicting stable identity.');
      }
      return { wake: existingWakes[0], created: false };
    }
    if (existingWakes.length > 1) throw new Error('RuntimeDelivery has multiple wake outbox rows.');
    const now = this.timestamp();
    const targetGone = delivery.state === 'failed';
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(deliveryId, {
          inbox_item_id: inboxItemId,
          state: delivery.state
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').insert({
          id: wakeId,
          delivery_id: deliveryId,
          state: targetGone ? 'dead_letter' : 'pending',
          claim_owner_host_boot_id: null,
          claim_generation: 0n,
          claim_expires_at: null,
          attempt_count: 0n,
          failure_count: targetGone ? 1n : 0n,
          next_attempt_at: null,
          last_error: targetGone ? boundedError(delivery.failure_reason ?? 'delivery-target-gone') : null,
          acknowledged_at: null,
          created_at: now,
          updated_at: now
        })
      ]);
      return { wake: await this.requireExisting('RuntimeDeliveryWake', wakeId), created: true };
    } catch (error) {
      if (!sqliteUniqueFailureIncludes(error, [
        'runtime_delivery_wake.id',
        'runtime_delivery_wake.delivery_id'
      ])) throw error;
      const raced = await this.listRows('RuntimeDeliveryWake', { delivery_id: deliveryId }, 2);
      if (raced.length !== 1 || raced[0].id !== wakeId) throw error;
      return { wake: raced[0], created: false };
    }
  }

  private async dispatchWake(wakeInput: DomainRow): Promise<'acknowledged' | 'retry' | 'dead_letter' | 'deferred'> {
    if (!this.wakeHandler || wakeInput.state !== 'claimed') return 'retry';
    const wakeId = requirePhaseFId(wakeInput.id, 'RuntimeDeliveryWake.id');
    let delivery = await this.requireExisting(
      'RuntimeDelivery',
      requirePhaseFId(wakeInput.delivery_id, 'RuntimeDeliveryWake.delivery_id')
    );

    if (delivery.state === 'failed') {
      await this.deadLetterClaim('RuntimeDeliveryWake', wakeInput, boundedError(
        delivery.failure_reason ?? 'RuntimeDelivery failed before its wake could be dispatched.'
      ));
      return 'dead_letter';
    }

    const inboxItemId = requirePhaseFId(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id');
    const inbox = await this.requireExisting('RuntimeInboxItem', inboxItemId);
    const payloadLinks = await this.listRows('RuntimeInboxPayloadLink', { inbox_item_id: inboxItemId }, 2);
    if (payloadLinks.length !== 1) throw new Error('Runtime delivery wake has no unique payload link.');
    const contentObjectId = requirePhaseFId(
      payloadLinks[0].content_object_id,
      'RuntimeInboxPayloadLink.content_object_id'
    );
    const source = await this.resolveWakeSource(inbox, delivery, contentObjectId);
    const reconciled = await this.automaticDeliveryRouter.reconcilePendingDelivery({
      deliveryId: requirePhaseFId(delivery.id, 'RuntimeDelivery.id'),
      targetConversationId: source.conversationId,
      sourceTurnId: source.sourceTurnId
    });
    delivery = reconciled.delivery;
    if (delivery.state === 'failed') {
      await this.deadLetterClaim('RuntimeDeliveryWake', wakeInput, boundedError(
        delivery.failure_reason ?? 'RuntimeDelivery failed during authority revalidation.'
      ));
      return 'dead_letter';
    }
    // The anchor Turn is still running: neither start a continuation nor inject into that Turn.
    if (delivery.state === 'pending' && reconciled.decision.reason === 'collaboration_queued_behind_active_turn') return 'deferred';

    if (inbox.source_kind === 'collaboration_message' && delivery.state === 'pending' && delivery.phase === 'next_turn' && delivery.target_turn_id === null) {
      const message = await this.requireExisting('CollaborationMessage', String(inbox.source_id));
      // A send-only message never creates a Turn: after the final-output fence race, or once the
      // user stopped the Turn it was injected into, only the target's next Turn takes it in. That
      // admission needs no wake, so this one settles instead of polling until then.
      if (message.mode === 'message') return this.acknowledgeWake(wakeInput);
    }
    const targetTurnId = delivery.target_turn_id === null
      ? null
      : requirePhaseFId(delivery.target_turn_id, 'RuntimeDelivery.target_turn_id');
    const action: ProcessCompletionWakeAction = delivery.phase === 'notify_only'
      ? 'notify_only'
      : delivery.phase === 'next_turn' && targetTurnId === null
        ? 'start_continuation'
        : 'resume_current_turn';
    const result = await this.invokeWakeHandler({
      wakeId,
      deliveryId: requirePhaseFId(delivery.id, 'RuntimeDelivery.id'),
      inboxItemId,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      ...(source.processId ? { processId: source.processId } : {}),
      ...(source.processReceiptId ? { processReceiptId: source.processReceiptId } : {}),
      conversationId: source.conversationId,
      sourceTurnId: reconciled.decision.sourceTurnId,
      targetTurnId,
      contentObjectId,
      action,
      ...(reconciled.decision.childExecutionId
        ? { childExecutionId: reconciled.decision.childExecutionId }
        : {})
    });
    if (!result.acknowledged) return 'retry';
    return this.acknowledgeWake(wakeInput);
  }

  private async acknowledgeWake(claim: DomainRow): Promise<'acknowledged'> {
    const wakeId = requirePhaseFId(claim.id, 'RuntimeDeliveryWake.id');
    const now = this.timestamp();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').assert(wakeId, {
          delivery_id: claim.delivery_id,
          state: 'claimed',
          claim_owner_host_boot_id: this.database.hostBootId,
          claim_generation: claim.claim_generation,
          acknowledged_at: null
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').update(wakeId, {
          state: 'acknowledged',
          claim_owner_host_boot_id: null,
          claim_expires_at: null,
          next_attempt_at: null,
          last_error: null,
          acknowledged_at: now,
          updated_at: now
        })
      ]);
      return 'acknowledged';
    } catch (error) {
      const latest = await this.requireExisting('RuntimeDeliveryWake', wakeId);
      if (latest.state === 'acknowledged') return 'acknowledged';
      throw error;
    }
  }

  private async invokeWakeHandler(
    request: ProcessCompletionWakeRequest
  ): Promise<{ acknowledged: boolean }> {
    if (!this.wakeHandler) return { acknowledged: false };
    const invocation = Promise.resolve().then(() => this.wakeHandler!(request)).then(
      (result) => ({ kind: 'result' as const, result }),
      (error: unknown) => ({ kind: 'error' as const, error })
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), this.claimTtlMs);
      timer.unref?.();
    });
    const settled = await Promise.race([invocation, timeout]);
    if (timer) clearTimeout(timer);
    if (settled.kind === 'timeout') {
      throw new Error(`RuntimeDelivery wake handler exceeded claim TTL ${this.claimTtlMs}ms.`);
    }
    if (settled.kind === 'error') throw settled.error;
    return settled.result;
  }

  private async resolveWakeSource(
    inbox: DomainRow,
    delivery: DomainRow,
    contentObjectId: string
  ): Promise<{
    sourceKind: 'process_receipt' | 'answer_submission' | 'child_failure' | 'collaboration_message';
    sourceId: string;
    conversationId: string;
    sourceTurnId: string | null;
    processId?: string;
    processReceiptId?: string;
  }> {
    const sourceId = requirePhaseFId(inbox.source_id, 'RuntimeInboxItem.source_id');
    const targetConversationId = requirePhaseFId(
      delivery.target_conversation_id,
      'RuntimeDelivery.target_conversation_id'
    );
    if (inbox.source_kind === 'collaboration_message') {
      const targets = await this.listRows('CollaborationMessageTargetLink', { message_id: sourceId }, 2);
      const payloads = await this.listRows('CollaborationMessagePayloadLink', { message_id: sourceId }, 2);
      if (targets.length !== 1 || targets[0].conversation_id !== targetConversationId || targets[0].inbox_item_id !== inbox.id || payloads.length !== 1 || payloads[0].content_object_id !== contentObjectId) throw new Error('Collaboration wake has conflicting destination or payload facts.');
      const turns = await listAllDomainRows(this.database, 'Turn', { conversation_id: targetConversationId });
      turns.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id)));
      // A followup may start a Conversation's very first Turn; it then has no anchor Turn at all.
      const anchor = turns.find((turn) => turn.status === 'active') ?? turns[0];
      return { sourceKind: 'collaboration_message', sourceId, conversationId: targetConversationId, sourceTurnId: anchor ? String(anchor.id) : null };
    }
    if (inbox.source_kind === 'process_receipt') {
      const frozen = await this.readFrozenCompletionPayload(contentObjectId, sourceId);
      if (frozen.conversationId !== targetConversationId) {
        throw new Error('Process completion wake targets a different frozen Conversation.');
      }
      return {
        sourceKind: 'process_receipt',
        sourceId,
        processId: frozen.processId,
        processReceiptId: sourceId,
        conversationId: frozen.conversationId,
        sourceTurnId: frozen.sourceTurnId
      };
    }
    if (inbox.source_kind !== 'answer_submission') {
      throw new Error(`Unsupported RuntimeDelivery wake source ${String(inbox.source_kind)}.`);
    }
    const submission = await this.requireExisting('AnswerSubmission', sourceId);
    const bridge = await this.requireExisting(
      'AnswerBridge',
      requirePhaseFId(submission.answer_bridge_id, 'AnswerSubmission.answer_bridge_id')
    );
    const childExecutionId = requirePhaseFId(
      bridge.child_execution_id,
      'AnswerBridge.child_execution_id'
    );
    const parentLinks = await this.listRows('ChildExecutionParentLink', {
      child_execution_id: childExecutionId
    }, 2);
    if (parentLinks.length !== 1) throw new Error('Answer wake requires one stable ChildExecutionParentLink.');
    const sourceTurnId = requirePhaseFId(parentLinks[0].parent_turn_id, 'ChildExecutionParentLink.parent_turn_id');
    const parentTurn = await this.requireExisting('Turn', sourceTurnId);
    const conversationId = requirePhaseFId(parentTurn.conversation_id, 'Parent Turn.conversation_id');
    if (conversationId !== targetConversationId) {
      throw new Error('Answer wake targets a different parent Conversation.');
    }
    const interrupted = submission.interrupted;
    if (interrupted !== 0n && interrupted !== 1n) {
      throw new Error(`AnswerSubmission has unsupported interrupted flag ${String(interrupted)}.`);
    }
    const failedSubmissionId = stablePhaseFId(
      'answer_submission',
      'child-drive-failed',
      childExecutionId,
      requirePhaseFId(submission.turn_id, 'AnswerSubmission.turn_id')
    );
    return {
      sourceKind: interrupted === 0n && sourceId === failedSubmissionId
        ? 'child_failure'
        : 'answer_submission',
      sourceId,
      conversationId,
      sourceTurnId
    };
  }

  private async claimOutbox(
    domain: 'ProcessCompletionDispatch' | 'RuntimeDeliveryWake',
    candidate: DomainRow
  ): Promise<DomainRow | null> {
    const id = requirePhaseFId(candidate.id, `${domain}.id`);
    let current = await this.requireExisting(domain, id);
    const now = this.timestamp();
    if (current.state === 'claimed') {
      const expiresAt = requireIsoTimestamp(current.claim_expires_at, `${domain}.claim_expires_at`);
      if (Date.parse(expiresAt) > Date.parse(now)) return null;
      try {
        await this.database.transaction([
          DOMAIN_REPOSITORIES.domain(domain).assert(id, this.claimIdentity(
            current,
            requirePhaseFText(current.claim_owner_host_boot_id, `${domain}.claim_owner_host_boot_id`)
          )),
          DOMAIN_REPOSITORIES.domain(domain).update(id, {
            state: 'pending',
            claim_owner_host_boot_id: null,
            claim_expires_at: null,
            next_attempt_at: now,
            last_error: boundedError(`Expired ${domain} claim ${String(current.claim_generation)} was fenced.`),
            updated_at: now
          })
        ]);
      } catch (error) {
        if (isTransactionAssertionFailure(error)) return null;
        throw error;
      }
      current = await this.requireExisting(domain, id);
    }
    if (current.state !== 'pending') return null;
    if (current.next_attempt_at !== null) {
      const due = requireIsoTimestamp(current.next_attempt_at, `${domain}.next_attempt_at`);
      if (Date.parse(due) > Date.parse(now)) return null;
    }
    const claimGeneration = requireCounter(current.claim_generation, `${domain}.claim_generation`) + 1n;
    const attemptCount = requireCounter(current.attempt_count, `${domain}.attempt_count`) + 1n;
    const expiresAt = addMilliseconds(now, this.claimTtlMs);
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain(domain).assert(id, {
          state: 'pending',
          claim_owner_host_boot_id: null,
          claim_generation: current.claim_generation,
          claim_expires_at: null,
          attempt_count: current.attempt_count,
          next_attempt_at: current.next_attempt_at
        }),
        DOMAIN_REPOSITORIES.domain(domain).update(id, {
          state: 'claimed',
          claim_owner_host_boot_id: this.database.hostBootId,
          claim_generation: claimGeneration,
          claim_expires_at: expiresAt,
          attempt_count: attemptCount,
          next_attempt_at: null,
          updated_at: now
        })
      ]);
    } catch (error) {
      if (isTransactionAssertionFailure(error)) return null;
      throw error;
    }
    const claimed = await this.requireExisting(domain, id);
    if (
      claimed.state !== 'claimed'
      || claimed.claim_owner_host_boot_id !== this.database.hostBootId
      || claimed.claim_generation !== claimGeneration
    ) throw new Error(`${domain} claim lost its immutable owner generation.`);
    return claimed;
  }

  private async completeDispatchClaim(claim: DomainRow): Promise<void> {
    const id = requirePhaseFId(claim.id, 'ProcessCompletionDispatch.id');
    const now = this.timestamp();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').assert(id, this.claimIdentity(claim)),
        DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').update(id, {
          state: 'completed',
          claim_owner_host_boot_id: null,
          claim_expires_at: null,
          next_attempt_at: null,
          last_error: null,
          completed_at: now,
          updated_at: now
        })
      ]);
    } catch (error) {
      const latest = await this.requireExisting('ProcessCompletionDispatch', id);
      if (latest.state === 'completed') return;
      throw error;
    }
  }

  private async releaseClaim(
    domain: 'ProcessCompletionDispatch' | 'RuntimeDeliveryWake',
    claim: DomainRow,
    options: { immediate?: boolean } = {}
  ): Promise<void> {
    const id = requirePhaseFId(claim.id, `${domain}.id`);
    const now = this.timestamp();
    // Foreign-owner requeues stay immediately claimable: the owning Host's next level scan must
    // not wait out a backoff meant for genuine handler failures.
    const nextAttemptAt = options.immediate === true
      ? null
      : addMilliseconds(now, retryDelay(
          requireCounter(claim.attempt_count, `${domain}.attempt_count`),
          this.retryBaseMs
        ));
    await this.database.transaction([
      DOMAIN_REPOSITORIES.domain(domain).assert(id, this.claimIdentity(claim)),
      DOMAIN_REPOSITORIES.domain(domain).update(id, {
        state: 'pending',
        claim_owner_host_boot_id: null,
        claim_expires_at: null,
        next_attempt_at: nextAttemptAt,
        last_error: null,
        updated_at: now
      })
    ]);
  }

  private async failClaim(
    domain: 'ProcessCompletionDispatch' | 'RuntimeDeliveryWake',
    claim: DomainRow,
    error: unknown
  ): Promise<void> {
    const failureCount = requireCounter(claim.failure_count, `${domain}.failure_count`) + 1n;
    if (failureCount >= BigInt(this.maxFailureCount)) {
      await this.deadLetterClaim(domain, claim, boundedError(error), failureCount);
      return;
    }
    const id = requirePhaseFId(claim.id, `${domain}.id`);
    const now = this.timestamp();
    await this.database.transaction([
      DOMAIN_REPOSITORIES.domain(domain).assert(id, this.claimIdentity(claim)),
      DOMAIN_REPOSITORIES.domain(domain).update(id, {
        state: 'pending',
        claim_owner_host_boot_id: null,
        claim_expires_at: null,
        failure_count: failureCount,
        next_attempt_at: addMilliseconds(now, retryDelay(failureCount, this.retryBaseMs)),
        last_error: boundedError(error),
        updated_at: now
      })
    ]);
  }

  private async deadLetterClaim(
    domain: 'ProcessCompletionDispatch' | 'RuntimeDeliveryWake',
    claim: DomainRow,
    reason: string,
    failureCount = requireCounter(claim.failure_count, `${domain}.failure_count`) + 1n
  ): Promise<void> {
    const id = requirePhaseFId(claim.id, `${domain}.id`);
    const now = this.timestamp();
    const delivery = domain === 'RuntimeDeliveryWake'
      ? await this.requireExisting(
          'RuntimeDelivery',
          requirePhaseFId(claim.delivery_id, 'RuntimeDeliveryWake.delivery_id')
        )
      : null;
    await this.database.transaction([
      DOMAIN_REPOSITORIES.domain(domain).assert(id, this.claimIdentity(claim)),
      DOMAIN_REPOSITORIES.domain(domain).update(id, {
        state: 'dead_letter',
        claim_owner_host_boot_id: null,
        claim_expires_at: null,
        failure_count: failureCount,
        next_attempt_at: null,
        last_error: boundedError(reason),
        updated_at: now
      }),
      ...(delivery?.state === 'pending' ? [
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(
          requirePhaseFId(delivery.id, 'RuntimeDelivery.id'),
          { state: 'pending', inbox_item_id: delivery.inbox_item_id }
        ),
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(
          requirePhaseFId(delivery.id, 'RuntimeDelivery.id'),
          {
            state: 'failed',
            failure_reason: boundedError(`wake-dead-letter:${boundedError(reason)}`),
            updated_at: now
          }
        )
      ] : [])
    ]);
  }

  private claimIdentity(claim: DomainRow, ownerHostBootId = this.database.hostBootId): DomainRow {
    return {
      state: 'claimed',
      claim_owner_host_boot_id: ownerHostBootId,
      claim_generation: claim.claim_generation,
      claim_expires_at: claim.claim_expires_at,
      attempt_count: claim.attempt_count
    };
  }

  private async readFrozenCompletionPayload(
    contentObjectId: string,
    expectedReceiptId: string
  ): Promise<{ processId: string; sourceTurnId: string; conversationId: string }> {
    const metadata = await this.requireExisting('ContentObject', contentObjectId) as ContentObjectMetadata;
    if (metadata.content_type !== PROCESS_COMPLETION_CONTENT_TYPE) {
      throw new Error('Process completion wake payload has an unexpected content type.');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse((await this.contentStore.read(metadata)).toString('utf8'));
    } catch (error) {
      throw new Error(`Process completion wake payload is unreadable: ${boundedError(error)}`);
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new TypeError('Process completion wake payload must be an object.');
    }
    const payload = decoded as Record<string, unknown>;
    if (payload.kind !== 'process_completion') throw new TypeError('Process completion wake payload has an unknown kind.');
    const receiptId = requirePhaseFId(payload.processReceiptId, 'process completion payload.processReceiptId');
    if (receiptId !== expectedReceiptId) throw new Error('Process completion wake payload receipt identity conflicts with its Inbox source.');
    return {
      processId: requirePhaseFId(payload.processId, 'process completion payload.processId'),
      sourceTurnId: requirePhaseFId(payload.sourceTurnId, 'process completion payload.sourceTurnId'),
      conversationId: requirePhaseFId(payload.conversationId, 'process completion payload.conversationId')
    };
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const value = snapshot.snapshot[0];
    if (Array.isArray(value)) throw new TypeError(`${domain} get returned rows.`);
    return value;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async listRows(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }

  private timestamp(): string {
    return requireIsoTimestamp(this.now(), 'Process completion delivery clock');
  }

  private reportError(scope: 'receipt' | 'wake' | 'scan', id: string, error: unknown): void {
    try {
      this.onError?.({ scope, id, error });
    } catch {
      // Diagnostics never become a second delivery control path.
    }
  }
}

function completionIds(processReceiptId: string) {
  const inboxItemId = stablePhaseFId('runtime_inbox_item', 'process-receipt', processReceiptId);
  return {
    inboxItemId,
    payloadLinkId: stablePhaseFId('runtime_inbox_payload_link', inboxItemId)
  };
}

function processCompletionDedupeKey(processReceiptId: string): string {
  return `process-receipt:${processReceiptId}`;
}

function processCompletionPayload(input: {
  receipt: DomainRow;
  processId: string;
  toolCallId: string;
  sourceTurnId: string;
  conversationId: string;
  output?: ProcessOutputReadResult;
  outputError?: string;
}, maxOutputBytes: number): Record<string, unknown> {
  const outputBudget = splitOutputBudget(input.output, maxOutputBytes);
  return {
    kind: 'process_completion',
    processReceiptId: requirePhaseFId(input.receipt.id, 'ProcessReceipt.id'),
    processId: input.processId,
    originToolCallId: input.toolCallId,
    sourceTurnId: input.sourceTurnId,
    conversationId: input.conversationId,
    outcome: requirePhaseFText(input.receipt.outcome, 'ProcessReceipt.outcome'),
    terminationReason: processCompletionTerminationReason(input.receipt.outcome),
    exitCode: input.receipt.exit_code === null ? null : String(input.receipt.exit_code),
    signal: input.receipt.exit_signal === null ? null : requirePhaseFText(
      input.receipt.exit_signal,
      'ProcessReceipt.exit_signal'
    ),
    completedAt: requireIsoTimestamp(input.receipt.received_at, 'ProcessReceipt.received_at'),
    output: input.output ? {
      stdoutTail: utf8Tail(input.output.stdout, outputBudget.stdout),
      stderrTail: utf8Tail(input.output.stderr, outputBudget.stderr),
      retainedBytes: input.output.retainedBytes,
      retainedChunks: input.output.retainedChunks,
      droppedBytes: input.output.droppedBytes,
      truncated: input.output.truncated
    } : {
      unavailable: input.outputError ?? 'Process output was unavailable during completion reconciliation.'
    },
    outputHandle: {
      tool: 'Bash',
      arguments: { mode: 'output', processId: input.processId }
    }
  };
}

function processCompletionTerminationReason(value: unknown): string {
  const outcome = requirePhaseFText(value, 'ProcessReceipt.outcome');
  if (outcome === 'cancelled') return 'manual';
  if (outcome === 'timed_out') return 'timed_out';
  if (outcome === 'output_limit_exceeded') return 'output_limit_exceeded';
  if (outcome === 'outcome_unknown') return 'outcome_unknown';
  return 'natural';
}

function encodeProcessCompletionPayload(input: Parameters<typeof processCompletionPayload>[0]): Buffer {
  let maxOutputBytes = PROCESS_COMPLETION_MAX_OUTPUT_BYTES;
  for (;;) {
    const bytes = Buffer.from(JSON.stringify(processCompletionPayload(input, maxOutputBytes)), 'utf8');
    if (bytes.byteLength <= PROCESS_COMPLETION_MAX_PAYLOAD_BYTES) return bytes;
    if (maxOutputBytes === 0) {
      throw new Error(`Process completion metadata exceeded ${PROCESS_COMPLETION_MAX_PAYLOAD_BYTES} bytes.`);
    }
    // JSON escaping can expand control-heavy terminal output several-fold. Shrink the raw tail
    // until the complete immutable payload, not merely its unescaped strings, satisfies the bound.
    maxOutputBytes = Math.floor(maxOutputBytes / 2);
  }
}

function splitOutputBudget(
  output: ProcessOutputReadResult | undefined,
  maxOutputBytes: number
): { stdout: number; stderr: number } {
  if (!output) return { stdout: 0, stderr: 0 };
  const stdoutLength = Math.min(output.stdout.byteLength, maxOutputBytes);
  const stderrLength = Math.min(output.stderr.byteLength, maxOutputBytes);
  const total = stdoutLength + stderrLength;
  if (total <= maxOutputBytes) return { stdout: stdoutLength, stderr: stderrLength };
  const stdout = Math.floor(maxOutputBytes * (stdoutLength / total));
  return { stdout, stderr: maxOutputBytes - stdout };
}

function utf8Tail(bytes: Buffer, maxBytes: number): string {
  if (maxBytes <= 0 || bytes.byteLength === 0) return '';
  let start = Math.max(0, bytes.byteLength - maxBytes);
  // A byte budget may land in the middle of a multi-byte code point. Move to the next leading
  // byte so a valid process stream never acquires a synthetic U+FFFD at the notification boundary.
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

function requireScanInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 60_000) {
    throw new TypeError('process completion scanIntervalMs must be an integer between 10 and 60000.');
  }
  return value;
}

function requireBoundedMilliseconds(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`process completion ${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`process completion ${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function requireCounter(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must be a non-negative integer.`);
  return value;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const parsed = Date.parse(requireIsoTimestamp(timestamp, 'outbox clock'));
  if (!Number.isFinite(parsed)) throw new TypeError('outbox clock must be an ISO timestamp.');
  return new Date(parsed + milliseconds).toISOString();
}

function retryDelay(attempt: bigint, baseMilliseconds: number): number {
  const exponent = Number(attempt > 6n ? 6n : attempt > 0n ? attempt - 1n : 0n);
  return Math.min(MAX_RETRY_DELAY_MS, baseMilliseconds * (2 ** exponent));
}

function isTransactionAssertionFailure(error: unknown): boolean {
  return (error as Error & { code?: string }).code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}
