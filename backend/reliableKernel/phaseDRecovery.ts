import {
  EffectControlPlane,
  ToolCallOrderBlockedError,
  type ToolTerminalResult
} from './effectControlPlane';
import { FileChangeControlPlane, type WorkEnvironmentBoundaryResolver } from './fileEffects';
import { McpEffectDispatcher } from './mcpEffects';
import { ProcessControlPlane } from './processEffects';
import { ConversationOwnershipGate, type ConversationOwnershipAcquisition } from './conversationOwnershipGate';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import { TurnControlPlane } from './turnControlPlane';
import { WorkEnvironmentTransferEffectDispatcher } from './workEnvironmentTransferEffects';

/** Recorded on every effect a user's stop closes after its executing window exited unexpectedly. */
export const DEAD_HOST_STOP_REASON = '执行窗口意外退出，执行结果未知；由用户停止收尾。';

export const PHASE_D_RECOVERY_EFFECT_INTENT_HANGING = 'recovery.effect-intent-hanging';
export const PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED = 'recovery.file-change-unresolved';
export type PhaseDRecoveryId =
  | typeof PHASE_D_RECOVERY_EFFECT_INTENT_HANGING
  | typeof PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED;

export interface PhaseDRecoveryResult {
  id: PhaseDRecoveryId;
  scanned: number;
  reconciled: number;
  unknown: number;
  terminalToolCallIds: string[];
}

interface PhaseDScanContext {
  conversationId?: string;
  gate: ConversationOwnershipGate;
}

/**
 * What keeps a Turn's executing tool calls open, and whether the Hosts running them are gone:
 * - `none`: nothing was dispatched without a Receipt; the ordinary stop path closes the calls
 *   (undispatched effects are cancelled). `receiptEffectIntentIds` are effects whose Receipt
 *   arrived but whose Operation is still open; reconciling them only replays a recorded fact;
 * - `live`: a Host that dispatched work still lacking a Receipt, or holds the Turn's lease, is
 *   alive or unverifiable;
 * - `unsupported`: a child spawn or cancel is in flight; the child scheduler owns it;
 * - `dead`: every such Host is proven dead (process gone or PID reused); `effectIntentIds` are the
 *   dispatched or receipted effects that still need a terminal Operation.
 */
export type DeadHostTurnEffects =
  | { state: 'none'; receiptEffectIntentIds: string[] }
  | { state: 'live'; hostBootIds: string[] }
  | { state: 'unsupported' }
  | { state: 'dead'; hostBootIds: string[]; effectIntentIds: string[] };

interface HangingEffectRecovery {
  reconciled: boolean;
  unknown: boolean;
  terminalToolCallId?: string;
}

interface UnresolvedFileChangeRecovery {
  reconciled: boolean;
  terminalToolCallId?: string;
}

function isTerminalOperationOutcome(value: unknown): boolean {
  return ['succeeded', 'failed', 'partial', 'rejected', 'cancelled', 'conflict', 'outcome_unknown'].includes(String(value));
}

function requirePositiveBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n) throw new TypeError(`${label} must be a positive SQLite INTEGER.`);
  return value;
}

function requireOperationOutcome(value: unknown): 'succeeded' | 'failed' | 'partial' | 'cancelled' | 'conflict' | 'outcome_unknown' {
  if (!['succeeded', 'failed', 'partial', 'cancelled', 'conflict', 'outcome_unknown'].includes(String(value))) {
    throw new TypeError(`Invalid persisted operation outcome: ${String(value)}.`);
  }
  return value as 'succeeded' | 'failed' | 'partial' | 'cancelled' | 'conflict' | 'outcome_unknown';
}

/** Minimal registry: exactly the two Phase D-owned scans, not a general recovery rule engine. */
export class PhaseDRecoveryScanner {
  private readonly handlers: ReadonlyMap<PhaseDRecoveryId, (signal: AbortSignal | undefined, context: PhaseDScanContext) => Promise<PhaseDRecoveryResult>>;
  private readonly workEnvironmentTransfers: WorkEnvironmentTransferEffectDispatcher;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly effects: EffectControlPlane,
    private readonly files: FileChangeControlPlane,
    private readonly processes: ProcessControlPlane,
    private readonly mcp: McpEffectDispatcher,
    private readonly resolveWorkEnvironment: WorkEnvironmentBoundaryResolver,
    private readonly turns: TurnControlPlane
  ) {
    this.workEnvironmentTransfers = new WorkEnvironmentTransferEffectDispatcher(database, effects);
    this.handlers = new Map<PhaseDRecoveryId, (signal: AbortSignal | undefined, context: PhaseDScanContext) => Promise<PhaseDRecoveryResult>>([
      [PHASE_D_RECOVERY_EFFECT_INTENT_HANGING, (signal, context) => this.scanHangingEffects(signal, context)],
      [PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED, (signal, context) => this.scanUnresolvedFileChanges(signal, context)]
    ]);
  }

  public ids(): PhaseDRecoveryId[] {
    return [...this.handlers.keys()];
  }

  public async run(id: PhaseDRecoveryId, signal?: AbortSignal, conversationId?: string): Promise<PhaseDRecoveryResult> {
    signal?.throwIfAborted();
    const gate = new ConversationOwnershipGate(this.database, 'claim');
    try {
      return await this.runWithGate(id, signal, conversationId, gate);
    } finally {
      await gate.releaseClaimed();
    }
  }

  /**
   * Runs every Phase D scan. With `conversationId` the scans only touch that Conversation's
   * durable work; unscoped passes claim eligible unowned work and skip conversations another
   * live or unknown owner holds, leaving their rows durable and retryable for the owning Host.
   */
  public async runAll(signal?: AbortSignal, conversationId?: string): Promise<PhaseDRecoveryResult[]> {
    signal?.throwIfAborted();
    const gate = new ConversationOwnershipGate(this.database, 'claim');
    try {
      // Close receipts already durable at the scan boundary before dispatched-effect recovery can
      // classify them as missing. A second candidate read below closes receipts racing this pass.
      await this.reconcileReceiptCandidates(signal, conversationId, gate);
      const results = [
        await this.runWithGate(PHASE_D_RECOVERY_EFFECT_INTENT_HANGING, signal, conversationId, gate),
        await this.runWithGate(PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED, signal, conversationId, gate)
      ];
      await this.reconcileCommittedFactsWithGate(signal, conversationId, gate);
      return results;
    } finally {
      await gate.releaseClaimed();
    }
  }

  /**
   * Deterministic DB-only continuation; it is not a registered recovery stable ID. The default
   * acquisition is `owned` so recurring convergence never claims unrelated Conversations merely
   * because an external commit arrived; explicit recovery passes `claim` through runAll.
   */
  public async reconcileCommittedFacts(
    signal?: AbortSignal,
    options: { conversationId?: string; acquisition?: ConversationOwnershipAcquisition } = {}
  ): Promise<{
    receipts: number;
    toolResults: number;
    failed: number;
  }> {
    const gate = new ConversationOwnershipGate(this.database, options.acquisition ?? 'owned');
    try {
      return await this.reconcileCommittedFactsWithGate(signal, options.conversationId, gate);
    } finally {
      await gate.releaseClaimed();
    }
  }

  private async runWithGate(
    id: PhaseDRecoveryId,
    signal: AbortSignal | undefined,
    conversationId: string | undefined,
    gate: ConversationOwnershipGate
  ): Promise<PhaseDRecoveryResult> {
    signal?.throwIfAborted();
    const handler = this.handlers.get(id);
    if (!handler) throw new Error(`Phase D does not own recovery scan ${String(id)}.`);
    return handler(signal, { ...(conversationId === undefined ? {} : { conversationId }), gate });
  }

  private async reconcileCommittedFactsWithGate(
    signal: AbortSignal | undefined,
    conversationId: string | undefined,
    gate: ConversationOwnershipGate
  ): Promise<{
    receipts: number;
    toolResults: number;
    failed: number;
  }> {
    signal?.throwIfAborted();
    const receiptResult = await this.reconcileReceiptCandidates(signal, conversationId, gate);
    let toolResults = 0;
    let failed = receiptResult.failed;

    const activeTurns = await listAllDomainRows(this.database, 'Turn', {
      status: 'active',
      ...(conversationId === undefined ? {} : { conversation_id: conversationId })
    });
    for (const turn of activeTurns) {
      signal?.throwIfAborted();
      const ran = await gate.run(String(turn.conversation_id), async () => {
        try {
          toolResults += (await this.effects.finalizeReadyInOrder(String(turn.id))).length;
        } catch (error) {
          // One malformed/incomplete Turn must not prevent unrelated committed effects from
          // converging. The next local commit or startup pass retries this exact durable frontier.
          console.warn('[reliable-kernel] Turn finalization convergence failed.', String(turn.id), error);
          failed += 1;
        }
      });
      // Another live owner finalizes its own Turn; nothing is dispatched without the source owner.
      if (!ran.ran) continue;
    }
    return { receipts: receiptResult.receipts, toolResults, failed };
  }

  private async reconcileReceiptCandidates(
    signal: AbortSignal | undefined,
    conversationId: string | undefined,
    gate: ConversationOwnershipGate
  ): Promise<{ receipts: number; failed: number }> {
    let receipts = 0;
    let failed = 0;
    const candidates = await this.database.effectReceiptReconciliationCandidates();
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      try {
        const snapshot = await this.database.snapshot([
          DOMAIN_REPOSITORIES.domain('EffectIntent').get(candidate.effectIntentId),
          DOMAIN_REPOSITORIES.domain('EffectReceipt').get(candidate.effectReceiptId)
        ]);
        const intent = snapshot.snapshot[0];
        const receipt = snapshot.snapshot[1];
        if (Array.isArray(intent) || !intent || Array.isArray(receipt) || !receipt) {
          throw new Error(`Effect receipt recovery candidate ${candidate.effectIntentId} lost its immutable facts.`);
        }
        const candidateConversationId = await this.effects.conversationIdForEffect(String(intent.id));
        if (conversationId !== undefined && candidateConversationId !== conversationId) continue;
        if (candidateConversationId === null) {
          // Genuinely detached receipts (for example process_exit) converge from any Host.
          const result = await this.resumePersistedReceipt(intent, receipt);
          if (result !== undefined) receipts += 1;
          continue;
        }
        const ran = await gate.run(candidateConversationId, () => this.resumePersistedReceipt(intent, receipt));
        if (!ran.ran) continue;
        if (ran.value !== undefined) receipts += 1;
      } catch (error) {
        // Recovery is a set of independent durable candidates. Continue so one bad process/tool
        // cannot hold every Conversation behind it hostage.
        console.warn(
          '[reliable-kernel] Effect receipt convergence failed.',
          candidate.effectIntentId,
          error
        );
        failed += 1;
      }
    }
    return { receipts, failed };
  }

  private async scanHangingEffects(signal: AbortSignal | undefined, context: PhaseDScanContext): Promise<PhaseDRecoveryResult> {
    const terminal = new Set<string>();
    let scanned = 0;
    let reconciled = 0;
    let unknown = 0;

    const intents = await listAllDomainRows(this.database, 'EffectIntent', { dispatch_state: 'dispatched' });
    const eligible: Array<{ intent: DomainRow; conversationId: string | null }> = [];
    for (const intent of intents) {
      signal?.throwIfAborted();
      try {
        const intentConversationId = await this.effects.conversationIdForEffect(String(intent.id));
        if (context.conversationId !== undefined && intentConversationId !== context.conversationId) continue;
        eligible.push({ intent, conversationId: intentConversationId });
      } catch (error) {
        signal?.throwIfAborted();
        console.warn('[reliable-kernel] Hanging effect ownership resolution failed.', String(intent.id), error);
      }
    }
    scanned = eligible.length;
    for (const { intent, conversationId: intentConversationId } of eligible) {
      signal?.throwIfAborted();
      try {
      // subagent effects belong to Phase F and the child scheduler; gating them here would claim
      // their Conversation for a scan that never reconciles them.
      if (intent.effect_kind === 'subagent_spawn') continue;
      if (intentConversationId !== null && !await context.gate.check(intentConversationId)) continue;
      const recovery = intentConversationId === null
        ? { ran: true as const, value: await this.recoverHangingEffectIntent(intent) }
        : await context.gate.run(intentConversationId, () => this.recoverHangingEffectIntent(intent));
      if (!recovery.ran) continue;
      if (recovery.value.reconciled) reconciled += 1;
      if (recovery.value.unknown) unknown += 1;
      if (recovery.value.terminalToolCallId) terminal.add(recovery.value.terminalToolCallId);
      } catch (error) {
        signal?.throwIfAborted();
        console.warn('[reliable-kernel] Hanging effect recovery failed.', String(intent.id), error);
      }
    }

    return {
      id: PHASE_D_RECOVERY_EFFECT_INTENT_HANGING,
      scanned,
      reconciled,
      unknown,
      terminalToolCallIds: [...terminal]
    };
  }

  private async recoverHangingEffectIntent(intent: DomainRow): Promise<HangingEffectRecovery> {
    const receipts = await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2);
    if (receipts.length > 0) {
      if (receipts.length !== 1) throw new Error(`EffectIntent ${String(intent.id)} has multiple EffectReceipts.`);
      const arrived = await this.resumePersistedReceipt(intent, receipts[0]);
      if (arrived === undefined) return { reconciled: false, unknown: false };
      if (arrived === null) {
        return { reconciled: true, unknown: receipts[0].outcome === 'outcome_unknown' };
      }
      return {
        reconciled: true,
        unknown: arrived.status === 'outcome_unknown',
        terminalToolCallId: arrived.toolCallId
      };
    }
    // Several code-server browser clients may have independent Extension Hosts over the same
    // Runtime root. A newly opened Host must not mistake another live Host's in-flight external
    // effect for crash residue merely because the receipt has not arrived yet. Only the Turn's
    // durable lease plus the lease Host's process identity is accepted as liveness proof; dead or
    // missing owners still fall through to the conservative effect-specific recovery below.
    if (await this.isOwnedByLiveTurnHost(intent)) return { reconciled: false, unknown: false };
    const source = {
      kind: 'recovery' as const,
      key: `recovery:effect-intent-hanging:${intent.id as string}`
    };
    let result: ToolTerminalResult | null;
    switch (intent.effect_kind) {
      case 'file_mutation':
        result = await this.files.recoverDispatchedEffect({
          source,
          effectIntentId: intent.id as string,
          resolver: this.resolveWorkEnvironment
        });
        break;
      case 'process_start':
        result = await this.processes.recoverDispatchedStart({
          source,
          effectIntentId: intent.id as string
        });
        break;
      case 'mcp_tool_call':
        result = await this.mcp.recoverDispatched({
          source,
          effectIntentId: intent.id as string
        });
        break;
      case 'file_transfer':
        result = await this.workEnvironmentTransfers.recoverDispatched({
          source,
          effectIntentId: intent.id as string
        });
        break;
      case 'process_exit': {
        const observed = await this.processes.recoverDispatchedExit({ source, effectIntentId: intent.id as string });
        if (observed.state === 'running') return { reconciled: false, unknown: false };
        return { reconciled: true, unknown: observed.state === 'outcome_unknown' };
      }
      case 'process_stop_request':
        result = await this.processes.recoverDispatchedStop({
          source,
          effectIntentId: intent.id as string
        });
        break;
      default:
        // subagent effects belong to Phase F and are deliberately not registered here.
        return { reconciled: false, unknown: false };
    }
    return {
      reconciled: true,
      unknown: result?.status === 'outcome_unknown',
      ...(result ? { terminalToolCallId: result.toolCallId } : {})
    };
  }

  private async isOwnedByLiveTurnHost(intent: DomainRow): Promise<boolean> {
    const dispatchFence = await this.effects.readEffectDispatchFence(String(intent.id));
    if (!dispatchFence) return false;
    const attempts = await this.list('Attempt', { id: intent.attempt_id }, 2);
    if (attempts.length !== 1) return false;
    const operations = await this.list('Operation', { id: attempts[0].operation_id }, 2);
    if (operations.length !== 1 || operations[0].tool_call_id === null) return false;
    if (isTerminalOperationOutcome(operations[0].status)) return false;
    const calls = await this.list('ToolCall', { id: operations[0].tool_call_id }, 2);
    if (calls.length !== 1) return false;
    const turns = await this.list('Turn', { id: calls[0].turn_id, status: 'active' }, 2);
    if (turns.length !== 1) return false;
    const leases = await this.list('ExecutionLease', { turn_id: turns[0].id }, 2);
    if (leases.length !== 1) return false;
    const lease = leases[0];
    if (
      lease.id !== dispatchFence.executionLeaseId
      || lease.conversation_id !== dispatchFence.conversationId
      || lease.turn_id !== dispatchFence.turnId
      || lease.owner_id !== dispatchFence.ownerId
      || lease.host_boot_id !== dispatchFence.hostBootId
      || requirePositiveBigInt(lease.generation, 'ExecutionLease.generation').toString() !== dispatchFence.generation
      || typeof lease.expires_at !== 'string'
      || Date.parse(lease.expires_at) <= Date.now()
    ) return false;
    return this.database.isHostAlive(dispatchFence.hostBootId);
  }

  private async resumePersistedReceipt(
    intent: DomainRow,
    receipt: DomainRow
  ): Promise<ToolTerminalResult | null | undefined> {
    const attempt = (await this.list('Attempt', { id: intent.attempt_id }, 1))[0];
    if (!attempt) throw new Error(`EffectIntent ${String(intent.id)} has no Attempt.`);
    const operation = (await this.list('Operation', { id: attempt.operation_id }, 1))[0];
    if (!operation) throw new Error(`Attempt ${String(attempt.id)} has no Operation.`);
    if (isTerminalOperationOutcome(operation.status)) {
      if (operation.tool_call_id !== null) {
        const outcome = (await this.list('ToolOutcome', { tool_call_id: operation.tool_call_id }, 1))[0];
        if (outcome) return undefined;
      } else if (intent.effect_kind === 'process_exit') {
        const processReceipt = (await this.list('ProcessReceipt', { process_id: operation.owner_id }, 1))[0];
        if (processReceipt) return undefined;
      }
    }
    const effectReceiptId = receipt.id as string;
    switch (intent.effect_kind) {
      case 'file_mutation':
        return this.files.reconcileEffectReceipt(effectReceiptId);
      case 'process_start':
        return this.processes.reconcileStartReceipt(effectReceiptId);
      case 'mcp_tool_call':
        return this.mcp.reconcileEffectReceipt(effectReceiptId, 'recovery');
      case 'file_transfer':
        return this.workEnvironmentTransfers.reconcileEffectReceipt(effectReceiptId, 'recovery');
      case 'process_stop_request':
        return this.effects.completeOperation({
          source: { kind: 'recovery', key: `recovery:process-stop-reconcile:${effectReceiptId}` },
          effectReceiptId,
          outcome: requireOperationOutcome(receipt.outcome)
        });
      case 'process_exit':
        await this.processes.reconcileExitEffectReceipt(effectReceiptId, 'recovery');
        return null;
      default:
        return undefined;
    }
  }

  private async scanUnresolvedFileChanges(signal: AbortSignal | undefined, context: PhaseDScanContext): Promise<PhaseDRecoveryResult> {
    const pending = await listAllDomainRows(this.database, 'FileChangeSet', { status: 'pending' });
    const ordered: Array<{ changeSet: DomainRow; turnId: string; conversationId: string; callSeq: bigint }> = [];
    for (const changeSet of pending) {
      signal?.throwIfAborted();
      try {
        const calls = await this.list('ToolCall', { id: changeSet.tool_call_id }, 1);
        if (calls.length !== 1) throw new Error(`Pending FileChangeSet ${String(changeSet.id)} has no ToolCall.`);
        const turnId = String(calls[0].turn_id);
        const turns = await this.list('Turn', { id: turnId }, 1);
        if (turns.length !== 1) throw new Error(`Pending FileChangeSet ${String(changeSet.id)} has no Turn.`);
        const changeConversationId = String(turns[0].conversation_id);
        if (context.conversationId !== undefined && changeConversationId !== context.conversationId) continue;
        ordered.push({
          changeSet,
          turnId,
          conversationId: changeConversationId,
          callSeq: requirePositiveBigInt(calls[0].call_seq, 'ToolCall.call_seq')
        });
      } catch (error) {
        signal?.throwIfAborted();
        console.warn('[reliable-kernel] Unresolved file change ordering failed.', String(changeSet.id), error);
      }
    }
    ordered.sort((left, right) => left.turnId.localeCompare(right.turnId)
      || (left.callSeq < right.callSeq ? -1 : left.callSeq > right.callSeq ? 1 : 0));
    const terminal = new Set<string>();
    const finalizedRecoveryTurns = new Set<string>();
    let reconciled = 0;
    for (const { changeSet, turnId, conversationId: changeConversationId } of ordered) {
      signal?.throwIfAborted();
      try {
      const recovery = await context.gate.run(changeConversationId, async (): Promise<UnresolvedFileChangeRecovery> => {
        const decisions = await this.list('FileChangeDecision', { change_set_id: changeSet.id }, 1);
        if (decisions.length > 0) return { reconciled: false };
        const recoveryFacts = await this.turns.recoveryFacts(turnId);
        if (recoveryFacts.judgment === 'needs_human') return { reconciled: false };
        if (recoveryFacts.judgment === 'finalize' && !recoveryFacts.executionLeaseExists) {
          if (!finalizedRecoveryTurns.has(turnId)) {
            await this.turns.finalizeRecovery({
              source: { kind: 'recovery', key: `recovery:turn-finalize:${turnId}` },
              turnId,
              terminalStatus: 'cancelled',
              reason: 'Phase D finalized an unresolved file Turn with no execution lease.'
            });
            finalizedRecoveryTurns.add(turnId);
          }
          const closed = await this.list('FileChangeDecision', { change_set_id: changeSet.id }, 1);
          if (closed.length === 1) {
            const toolCallId = String(changeSet.tool_call_id);
            const result = await this.effects.readTerminalResult(toolCallId, true);
            return { reconciled: true, ...(result ? { terminalToolCallId: toolCallId } : {}) };
          }
          return { reconciled: false };
        }
        try {
          const result = await this.files.decide({
            source: {
              kind: 'recovery',
              key: `recovery:file-change-unresolved:${changeSet.id as string}`
            },
            changeSetId: changeSet.id as string,
            decision: 'expired',
            response: { reason: 'Unresolved FileChangeSet expired during Phase D restart scan.' }
          });
          return {
            reconciled: true,
            ...(result.terminal ? { terminalToolCallId: result.terminal.toolCallId } : {})
          };
        } catch (error) {
          if (!(error instanceof ToolCallOrderBlockedError)) throw error;
          return { reconciled: false };
        }
      });
      if (!recovery.ran) continue;
      if (recovery.value.reconciled) reconciled += 1;
      if (recovery.value.terminalToolCallId) terminal.add(recovery.value.terminalToolCallId);
      } catch (error) {
        signal?.throwIfAborted();
        console.warn('[reliable-kernel] Unresolved file change recovery failed.', String(changeSet.id), error);
      }
    }
    return {
      id: PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED,
      scanned: context.conversationId === undefined ? pending.length : ordered.length,
      reconciled,
      unknown: 0,
      terminalToolCallIds: [...terminal]
    };
  }

  /**
   * Read-only inspection before a stop settles a Turn control-only. Liveness uses the same
   * process-identity proof as lease takeover: only a Host proven dead counts, and `selfHostBootId`
   * is never treated as dead (work dispatched by this process is still running here).
   */
  public async deadHostEffectsForTurn(turnIdInput: string, selfHostBootId: string): Promise<DeadHostTurnEffects> {
    const turnId = requireText(turnIdInput, 'turnId');
    const executing = await listAllDomainRows(this.database, 'ToolCall', { turn_id: turnId, status: 'executing' });
    const hosts = new Set<string>();
    const dispatched: string[] = [];
    const receipted: string[] = [];
    for (const call of executing) {
      const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: String(call.id) });
      for (const operation of operations) {
        if (isTerminalOperationOutcome(operation.status)) continue;
        const attempts = await listAllDomainRows(this.database, 'Attempt', { operation_id: String(operation.id) });
        for (const attempt of attempts) {
          const intents = await this.list('EffectIntent', { attempt_id: attempt.id }, 2);
          for (const intent of intents) {
            const child = intent.effect_kind === 'subagent_spawn' || intent.effect_kind === 'subagent_cancel';
            if (intent.dispatch_state === 'receipt_written') {
              // A child wait is closed by the ordinary stop path; its spawn already happened.
              if (!child) receipted.push(String(intent.id));
              continue;
            }
            if (intent.dispatch_state !== 'dispatched') continue;
            if (child) return { state: 'unsupported' };
            const fence = await this.effects.readEffectDispatchFence(String(intent.id));
            // Without a recorded dispatch Host nothing can prove that the work stopped.
            if (!fence) return { state: 'live', hostBootIds: [] };
            if (fence.hostBootId === selfHostBootId) return { state: 'live', hostBootIds: [fence.hostBootId] };
            hosts.add(fence.hostBootId);
            dispatched.push(String(intent.id));
          }
        }
      }
    }
    if (dispatched.length === 0) return { state: 'none', receiptEffectIntentIds: receipted };
    const leases = await this.list('ExecutionLease', { turn_id: turnId }, 2);
    if (leases.length > 1) throw new Error(`Turn ${turnId} has multiple ExecutionLeases.`);
    const leaseHost = leases[0] ? requireText(leases[0].host_boot_id, 'ExecutionLease.host_boot_id') : undefined;
    if (leaseHost !== undefined && leaseHost !== selfHostBootId) hosts.add(leaseHost);
    const live: string[] = [];
    for (const hostBootId of hosts) {
      if (await this.database.isHostAlive(hostBootId)) live.push(hostBootId);
    }
    if (live.length > 0) return { state: 'live', hostBootIds: live.sort() };
    return { state: 'dead', hostBootIds: [...hosts].sort(), effectIntentIds: [...dispatched, ...receipted] };
  }

  /**
   * Closes effects left in flight by a Host proven dead, for a user's explicit stop. Nothing is
   * dispatched, retried or inspected again: an effect without a Receipt is recorded as
   * outcome_unknown with `reason`, and a Receipt that already arrived is reconciled as written.
   * The caller holds the Turn's execution lease fence.
   */
  public async abandonDeadHostEffects(input: {
    sourceKey: string;
    effectIntentIds: readonly string[];
    reason: string;
  }): Promise<number> {
    const reason = requireText(input.reason, 'reason');
    let closed = 0;
    for (const effectIntentId of input.effectIntentIds) {
      const arrived = await this.reconcileArrivedReceipt(effectIntentId);
      if (arrived.receipt) {
        if (arrived.closed) closed += 1;
        continue;
      }
      if (arrived.intent.dispatch_state !== 'dispatched') continue;
      await this.recordUnknownReceipt(arrived.intent, `${requireText(input.sourceKey, 'sourceKey')}:${effectIntentId}`, reason);
      closed += 1;
    }
    return closed;
  }

  /**
   * Reconciles effects whose Receipt already arrived but whose Operation is still open, before a
   * stop closes their tool calls. This only applies recorded facts; nothing is dispatched. The
   * caller holds the Turn's execution lease fence.
   */
  public async reconcileArrivedReceipts(effectIntentIds: readonly string[]): Promise<void> {
    for (const effectIntentId of effectIntentIds) await this.reconcileArrivedReceipt(effectIntentId);
  }

  private async reconcileArrivedReceipt(
    effectIntentId: string
  ): Promise<{ intent: DomainRow; receipt: boolean; closed: boolean }> {
    const intent = (await this.list('EffectIntent', { id: effectIntentId }, 1))[0];
    if (!intent) throw new Error(`EffectIntent ${effectIntentId} does not exist.`);
    const receipts = await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2);
    if (receipts.length > 1) throw new Error(`EffectIntent ${effectIntentId} has multiple EffectReceipts.`);
    if (receipts.length === 0) return { intent, receipt: false, closed: false };
    return { intent, receipt: true, closed: await this.resumePersistedReceipt(intent, receipts[0]) !== undefined };
  }

  private async recordUnknownReceipt(intent: DomainRow, sourceKey: string, reason: string): Promise<void> {
    const source = { kind: 'recovery' as const, key: sourceKey };
    const effectIntentId = String(intent.id);
    const attemptId = requireText(intent.attempt_id, 'EffectIntent.attempt_id');
    const detail = { reason, automaticRetry: false };
    switch (intent.effect_kind) {
      case 'file_mutation':
        await this.files.recordUnknownDispatchedEffect({ source, effectIntentId, reason });
        return;
      case 'process_start': {
        const request = await this.effects.readEffectRequest<{ processId?: unknown }>(effectIntentId);
        const recorded = await this.effects.recordEffectReceipt({
          source,
          attemptId,
          effectKind: 'process_start',
          outcome: 'outcome_unknown',
          detail: {
            outcome: 'outcome_unknown',
            state: 'outcome_unknown',
            processId: requireText(request.processId, 'process_start.processId'),
            launch: { outcome: 'outcome_unknown', error: reason },
            foreground: null
          }
        });
        await this.processes.reconcileStartReceipt(recorded.effectReceiptId);
        return;
      }
      case 'mcp_tool_call': {
        const recorded = await this.effects.recordEffectReceipt({
          source, attemptId, effectKind: 'mcp_tool_call', outcome: 'outcome_unknown', detail
        });
        await this.mcp.reconcileEffectReceipt(recorded.effectReceiptId, 'recovery');
        return;
      }
      case 'file_transfer': {
        const recorded = await this.effects.recordEffectReceipt({
          source, attemptId, effectKind: 'file_transfer', outcome: 'outcome_unknown', detail
        });
        await this.workEnvironmentTransfers.reconcileEffectReceipt(recorded.effectReceiptId, 'recovery');
        return;
      }
      case 'process_stop_request': {
        const recorded = await this.effects.recordEffectReceipt({
          source,
          attemptId,
          effectKind: 'process_stop_request',
          outcome: 'outcome_unknown',
          detail: { outcome: 'outcome_unknown', status: 'outcome_unknown', ...detail }
        });
        await this.effects.completeOperation({
          source: { kind: 'recovery', key: `${sourceKey}:complete` },
          effectReceiptId: recorded.effectReceiptId,
          outcome: 'outcome_unknown'
        });
        return;
      }
      default:
        throw new Error(`Effect kind ${String(intent.effect_kind)} cannot be closed for a stopped Turn.`);
    }
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}
