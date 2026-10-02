import type { ToolResultOut } from '../world/modules/tools/registry';
import {
  EffectControlPlane,
  type PhaseDCommandSource,
  type PreparedEffectIntent,
  type ToolTerminalResult
} from './effectControlPlane';
import { normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';
import { retryLocalExecution } from './localExecutionRecovery';
import { handoffReason } from './executionLeaseFence';

export const WORK_ENVIRONMENT_TRANSFER_EFFECT_KIND = 'file_transfer' as const;

export interface WorkEnvironmentTransferEffectRequest {
  authoritySnapshotId: string;
  arguments: PlainJsonValue;
}

export interface WorkEnvironmentTransferEffectExecutor {
  /** Invoked only after dispatch_state=dispatched is durably committed. */
  execute(request: WorkEnvironmentTransferEffectRequest): Promise<ToolResultOut>;
}

export type WorkEnvironmentTransferObservation =
  | { outcome: 'succeeded' | 'failed'; result: PlainJsonValue }
  | { outcome: 'cancelled'; error: string }
  | { outcome: 'outcome_unknown'; error: string };

/**
 * Durable boundary for transfer's external writes.
 *
 * A committed dispatched transfer without a Receipt is deliberately never retried: a local rename
 * or remote write may already have happened, and the rebuilt host cannot prove otherwise.
 */
export class WorkEnvironmentTransferEffectDispatcher {
  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly effects: EffectControlPlane
  ) {}

  public prepare(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    authoritySnapshotId: string;
    arguments: PlainJsonValue;
  }): Promise<PreparedEffectIntent> {
    const request: WorkEnvironmentTransferEffectRequest = {
      authoritySnapshotId: requireId(input.authoritySnapshotId, 'authoritySnapshotId'),
      arguments: normalizeTransferArguments(input.arguments)
    };
    return this.effects.prepareEffectIntent({
      source: input.source,
      toolCallId: requireId(input.toolCallId, 'toolCallId'),
      effectKind: WORK_ENVIRONMENT_TRANSFER_EFFECT_KIND,
      request
    });
  }

  public async dispatch(
    effectIntentIdInput: string,
    executor: WorkEnvironmentTransferEffectExecutor,
    signal?: AbortSignal
  ): Promise<{ observation: WorkEnvironmentTransferObservation | null; terminal: ToolTerminalResult | null }> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    if (signal?.aborted) {
      const handoff = handoffReason(signal);
      if (handoff) throw handoff;
      const cancelled = await this.effects.cancelPendingEffect({
        source: { kind: 'internal', key: `file-transfer:${effectIntentId}:cancel-before-dispatch` },
        effectIntentId,
        detail: { reason: 'File transfer cancelled before capability dispatch.' }
      });
      if (cancelled) {
        return { observation: null, terminal: cancelled.terminal ?? await this.terminalForIntent(effectIntentId) };
      }
    }
    if (!await retryLocalExecution(() => this.effects.claimEffectDispatch(effectIntentId))) {
      return { observation: null, terminal: await this.terminalForIntent(effectIntentId) };
    }
    const { intent, request } = await retryLocalExecution(async () => {
      const intent = await this.requireExisting('EffectIntent', effectIntentId);
      const request = normalizeRequest(
        await this.effects.readEffectRequest<WorkEnvironmentTransferEffectRequest>(effectIntentId)
      );
      return { intent, request };
    });
    let observation: WorkEnvironmentTransferObservation;
    if (signal?.aborted) {
      observation = {
        outcome: 'cancelled',
        error: 'File transfer was cancelled after the dispatch claim but before capability invocation.'
      };
    } else {
      const invocation = Promise.resolve().then(() => executor.execute(request)).then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error })
      );
      const abortWaiter = createAbortWaiter(signal);
      const settled = abortWaiter.promise
        ? await Promise.race([invocation, abortWaiter.promise])
        : await invocation;
      abortWaiter.dispose();
      if (settled.kind === 'aborted') {
        observation = {
          outcome: 'outcome_unknown',
          error: 'transfer 已进入 committed dispatch；取消发生后最终文件状态不可证明。'
        };
      } else if (settled.kind === 'result') {
        const result = settled.result;
        observation = {
          outcome: result.ok ? 'succeeded' : 'failed',
          result: normalizePlainJson({
            ok: result.ok,
            output: result.output ?? null,
            ...(result.parts ? { parts: result.parts } : {}),
            ...(result.status ? { status: result.status } : {})
          }, 'transfer result')
        };
      } else {
        observation = {
          outcome: 'outcome_unknown',
          error: `transfer 已进入 committed dispatch，但宿主未能证明最终结果：${errorMessage(settled.error)}`
        };
      }
    }
    // Observation persistence is independent of foreground cancellation. Never retry execute.
    const receipt = await retryLocalExecution(() => this.effects.recordEffectReceipt({
      source: { kind: 'callback', key: `file-transfer:${String(intent.attempt_id)}:receipt` },
      attemptId: requireId(intent.attempt_id, 'EffectIntent.attempt_id'),
      effectKind: WORK_ENVIRONMENT_TRANSFER_EFFECT_KIND,
      outcome: observation.outcome,
      detail: observation
    }));
    return {
      observation,
      terminal: await retryLocalExecution(() => this.reconcileEffectReceipt(receipt.effectReceiptId, 'internal'))
    };
  }

  public async recoverDispatched(input: {
    source: PhaseDCommandSource;
    effectIntentId: string;
  }): Promise<ToolTerminalResult | null> {
    if (input.source.kind !== 'recovery') throw new TypeError('transfer recovery requires recovery source kind.');
    const effectIntentId = requireId(input.effectIntentId, 'effectIntentId');
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    if (intent.effect_kind !== WORK_ENVIRONMENT_TRANSFER_EFFECT_KIND) {
      throw new Error('transfer recovery target must be a file_transfer EffectIntent.');
    }
    const existing = (await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2))[0];
    if (existing) return this.reconcileEffectReceipt(requireId(existing.id, 'EffectReceipt.id'), 'recovery');
    if (intent.dispatch_state !== 'dispatched') {
      throw new Error('transfer recovery without a Receipt requires dispatch_state=dispatched.');
    }
    const receipt = await this.effects.recordEffectReceipt({
      source: input.source,
      attemptId: requireId(intent.attempt_id, 'EffectIntent.attempt_id'),
      effectKind: WORK_ENVIRONMENT_TRANSFER_EFFECT_KIND,
      outcome: 'outcome_unknown',
      detail: {
        reason: '无法证明宿主重启前已派发 transfer 的最终文件状态。',
        automaticRetry: false
      }
    });
    return this.reconcileEffectReceipt(receipt.effectReceiptId, 'recovery');
  }

  public async reconcileEffectReceipt(
    effectReceiptIdInput: string,
    sourceKind: 'internal' | 'recovery'
  ): Promise<ToolTerminalResult | null> {
    const effectReceiptId = requireId(effectReceiptIdInput, 'effectReceiptId');
    const receipt = await this.requireExisting('EffectReceipt', effectReceiptId);
    return this.effects.completeOperation({
      source: { kind: sourceKind, key: `file-transfer-reconcile:${effectReceiptId}` },
      effectReceiptId,
      outcome: requireReceiptOutcome(receipt.outcome)
    });
  }

  private async terminalForIntent(effectIntentId: string): Promise<ToolTerminalResult | null> {
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    const attempts = await this.list('Attempt', { id: intent.attempt_id }, 1);
    if (attempts.length !== 1) throw new Error(`EffectIntent ${effectIntentId} has no Attempt.`);
    const operations = await this.list('Operation', { id: attempts[0].operation_id }, 1);
    if (operations.length !== 1) throw new Error(`Attempt ${String(attempts[0].id)} has no Operation.`);
    const toolCallId = requireId(operations[0].tool_call_id, 'Operation.tool_call_id');
    return this.effects.readTerminalResult(toolCallId, true);
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }
}

function createAbortWaiter(signal?: AbortSignal): {
  promise?: Promise<{ kind: 'aborted' }>;
  dispose(): void;
} {
  if (!signal) return { dispose() {} };
  if (signal.aborted) return { promise: Promise.resolve({ kind: 'aborted' }), dispose() {} };
  let listener: (() => void) | undefined;
  const promise = new Promise<{ kind: 'aborted' }>((resolve) => {
    listener = () => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', listener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) signal.removeEventListener('abort', listener);
    }
  };
}

function normalizeRequest(value: WorkEnvironmentTransferEffectRequest): WorkEnvironmentTransferEffectRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid file_transfer Effect request.');
  }
  return {
    authoritySnapshotId: requireId(value.authoritySnapshotId, 'authoritySnapshotId'),
    arguments: normalizeTransferArguments(value.arguments)
  };
}

function normalizeTransferArguments(value: PlainJsonValue): PlainJsonValue {
  const normalized = normalizePlainJson(value, 'transfer arguments');
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new TypeError('transfer arguments must be an object.');
  }
  const transfers = normalized.transfers;
  if (!Array.isArray(transfers) || transfers.length === 0) {
    throw new TypeError('transfer requires a non-empty transfers array.');
  }
  transfers.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`transfer.transfers[${index}] must be an object.`);
    }
    for (const field of ['fromEnvironment', 'fromPath', 'toEnvironment', 'toPath']) {
      requireText(entry[field], `transfer.transfers[${index}].${field}`);
    }
  });
  return normalized;
}

function requireReceiptOutcome(
  value: unknown
): 'succeeded' | 'failed' | 'cancelled' | 'conflict' | 'outcome_unknown' {
  if (!['succeeded', 'failed', 'cancelled', 'conflict', 'outcome_unknown'].includes(String(value))) {
    throw new TypeError(`Invalid file_transfer EffectReceipt outcome: ${String(value)}.`);
  }
  return value as 'succeeded' | 'failed' | 'cancelled' | 'conflict' | 'outcome_unknown';
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
