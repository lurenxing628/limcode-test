import { AttachmentAdmissionError } from './attachmentIngest';
import type { InlineDataPart } from '../../shared/protocol';
import {
  EffectControlPlane,
  type PhaseDCommandSource,
  type PreparedEffectIntent,
  type RecordedEffectReceipt,
  type ToolSettlementResult,
  type ToolTerminalResult
} from './effectControlPlane';
import { normalizePlainJson } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';
import { retryLocalExecution } from './localExecutionRecovery';
import { handoffReason } from './executionLeaseFence';

export type McpRiskLevel = 'read' | 'write' | 'command';

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface McpToolCallRequest {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: McpRiskLevel;
}

export interface McpAuthorizationRequest extends McpToolCallRequest {
  toolCallId: string;
}

export type McpPreparationResult =
  | ({ disposition: 'prepared' } & PreparedEffectIntent)
  | { disposition: 'rejected'; settlement: ToolSettlementResult };

interface McpResultWarnings {
  attachmentError?: string;
  resultProcessingError?: string;
  automaticRetry?: false;
}

export type McpCallObservation =
  | ({ outcome: 'succeeded'; result: unknown; parts?: InlineDataPart[] } & McpResultWarnings)
  | ({ outcome: 'failed'; error: string; result: unknown; parts?: InlineDataPart[] } & McpResultWarnings)
  | { outcome: 'cancelled'; error: string }
  | { outcome: 'outcome_unknown'; error: string };

/** Connection objects are intentionally memory-only and rebuilt from settings by the host. */
export interface McpMemoryConnectionRegistry {
  toolAnnotations(serverId: string, toolName: string): Promise<McpToolAnnotations>;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown>;
}

/** Explicit pre/post-dispatch certainty supplied by the existing MCP adapter. */
export class McpInvocationError extends Error {
  public constructor(
    public readonly certainty: 'not_dispatched' | 'explicit_failure' | 'ambiguous_after_dispatch',
    message: string
  ) {
    super(message);
    this.name = 'McpInvocationError';
  }
}

/** Adapter to the existing ToolPolicy and PlanReviewPolicy authorities; it owns no policy state. */
export interface McpExistingPolicyGate {
  authorize(request: McpAuthorizationRequest): Promise<{
    toolPolicyAllowed: boolean;
    planReviewAllowed: boolean;
    reason?: string;
  }>;
}

const MCP_EFFECT_KIND = 'mcp_tool_call' as const;

/** Dedicated MCP dispatcher. It never persists settings or connection/client objects. */
export class McpEffectDispatcher {
  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly effects: EffectControlPlane,
    private readonly connections: McpMemoryConnectionRegistry,
    private readonly policyGate: McpExistingPolicyGate
  ) {}

  public async prepare(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    serverId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpPreparationResult> {
    if (input.source.kind !== 'internal') throw new TypeError('MCP prepare requires internal source kind.');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const serverId = requireId(input.serverId, 'serverId');
    const toolName = requireText(input.toolName, 'toolName');
    const annotations = normalizeAnnotations(await this.connections.toolAnnotations(serverId, toolName));
    const request: McpToolCallRequest = {
      serverId,
      toolName,
      arguments: normalizeArguments(input.arguments),
      riskLevel: mapMcpRisk(annotations)
    };
    const authorization = await this.policyGate.authorize({ ...request, toolCallId });
    if (!authorization.toolPolicyAllowed || !authorization.planReviewAllowed) {
      const settlement = await this.effects.settleWithoutEffect({
        source: input.source,
        toolCallId,
        status: 'rejected',
        detail: {
          kind: 'mcp-policy-rejection',
          serverId,
          toolName,
          reason: authorization.reason || 'Existing ToolPolicy/PlanReviewPolicy rejected the MCP call.'
        }
      });
      return { disposition: 'rejected', settlement };
    }
    const effect = await this.effects.prepareEffectIntent({
      source: input.source,
      toolCallId,
      effectKind: MCP_EFFECT_KIND,
      request
    });
    return { disposition: 'prepared', ...effect };
  }

  public async dispatch(effectIntentIdInput: string, signal?: AbortSignal): Promise<{
    observation: McpCallObservation | null;
    terminal: ToolTerminalResult | null;
  }> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    if (signal?.aborted) {
      const handoff = handoffReason(signal);
      if (handoff) throw handoff;
      const cancelled = await this.effects.cancelPendingEffect({
        source: { kind: 'internal', key: `mcp-call:${effectIntentId}:cancel-before-dispatch` },
        effectIntentId,
        detail: { reason: 'MCP call cancelled before capability dispatch.' }
      });
      if (cancelled) return { observation: null, terminal: cancelled.terminal ?? null };
    }
    if (!await retryLocalExecution(() => this.effects.claimEffectDispatch(effectIntentId))) return { observation: null, terminal: null };
    const observation = await this.executeDispatched(effectIntentId, signal);
    // The invocation has already completed. Keep its observation in this stack while only
    // idempotent local receipt work retries, even after cancellation or lease handoff.
    const intent = await retryLocalExecution(() => this.requireExisting('EffectIntent', effectIntentId));
    let recorded: RecordedEffectReceipt;
    let durableObservation = observation;
    try {
      recorded = await retryLocalExecution(() => this.effects.recordEffectReceipt({
        source: { kind: 'callback', key: `mcp-call:${String(intent.attempt_id)}:receipt` },
        attemptId: intent.attempt_id as string,
        effectKind: MCP_EFFECT_KIND,
        outcome: observation.outcome,
        detail: observation
      }));
    } catch (error) {
      if (!(error instanceof AttachmentAdmissionError)) throw error;
      // The server's observed execution outcome is already known. A local attachment failure
      // must never erase it or suggest that retrying the external action is safe.
      if (observation.outcome !== 'succeeded' && observation.outcome !== 'failed') throw error;
      const { parts: _parts, ...observed } = observation;
      durableObservation = {
        ...observed,
        result: withoutUnavailableAttachments(observed.result),
        attachmentError: `MCP result attachments could not be stored: ${boundedErrorMessage(error)}`,
        automaticRetry: false
      };
      recorded = await retryLocalExecution(() => this.effects.recordEffectReceipt({
        source: { kind: 'callback', key: `mcp-call:${String(intent.attempt_id)}:receipt` },
        attemptId: intent.attempt_id as string,
        effectKind: MCP_EFFECT_KIND,
        outcome: durableObservation.outcome,
        detail: durableObservation
      }));
    }
    return {
      observation: durableObservation,
      terminal: await retryLocalExecution(() => this.reconcileEffectReceipt(recorded.effectReceiptId, 'internal'))
    };
  }

  /** Executes one committed dispatch. The returned observation may be lost and later recovered as unknown. */
  public async executeDispatched(effectIntentIdInput: string, signal?: AbortSignal): Promise<McpCallObservation> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    const request = await retryLocalExecution(async () => {
      const intent = await this.requireExisting('EffectIntent', effectIntentId);
      if (intent.effect_kind !== MCP_EFFECT_KIND || intent.dispatch_state !== 'dispatched') {
        throw new Error('MCP call requires a committed dispatched mcp_tool_call EffectIntent.');
      }
      if ((await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 1)).length > 0) {
        throw new Error('mcp_tool_call already has a Receipt and cannot execute again.');
      }
      return normalizeRequest(await this.effects.readEffectRequest<McpToolCallRequest>(effectIntentId));
    });
    if (signal?.aborted) {
      return { outcome: 'cancelled', error: 'MCP call was cancelled before the connection was invoked.' };
    }
    const abortWaiter = createAbortWaiter(signal);
    if (signal?.aborted) {
      abortWaiter.dispose();
      return { outcome: 'cancelled', error: 'MCP call was cancelled before the connection was invoked.' };
    }
    let call: Promise<unknown>;
    try {
      call = this.connections.callTool(
        request.serverId,
        request.toolName,
        request.arguments,
        signal
      );
    } catch (error) {
      abortWaiter.dispose();
      return mcpInvocationFailure(error, signal);
    }
    const invocation = Promise.resolve(call).then(
      (result) => ({ kind: 'result' as const, result }),
      (error: unknown) => ({ kind: 'error' as const, error })
    );
    const settled = abortWaiter.promise
      ? await Promise.race([invocation, abortWaiter.promise])
      : await invocation;
    abortWaiter.dispose();
    if (settled.kind === 'aborted') {
      return {
        outcome: 'outcome_unknown',
        error: 'MCP call was dispatched, then its foreground observation was cancelled before a result was proved.'
      };
    }
    if (settled.kind === 'error') return mcpInvocationFailure(settled.error, signal);
    const result = settled.result;
    try {
      const binary = normalizeMcpBinaryResult(result);
      const normalized = { result: normalizePlainJson(binary.result, 'MCP result'), parts: binary.parts };
      if (isObservedMcpToolFailure(result)) {
        return {
          outcome: 'failed',
          error: mcpFailureMessage(result),
          result: normalized.result,
          ...(normalized.parts.length > 0 ? { parts: normalized.parts } : {})
        };
      }
      return {
        outcome: 'succeeded',
        result: normalized.result,
        ...(normalized.parts.length > 0 ? { parts: normalized.parts } : {})
      };
    } catch (error) {
      // Invocation returned a result; postprocessing uncertainty is separate from execution.
      const warning = { result: usableMcpText(result),
        resultProcessingError: `MCP result could not be fully represented: ${boundedErrorMessage(error)}`,
        automaticRetry: false as const };
      return isObservedMcpToolFailure(result)
        ? { outcome: 'failed', error: mcpFailureMessage(result), ...warning }
        : { outcome: 'succeeded', ...warning };
    }
  }

  /** A rebuilt connection is not proof of a prior call result; recovery never invokes callTool again. */
  public async recoverDispatched(input: {
    source: PhaseDCommandSource;
    effectIntentId: string;
  }): Promise<ToolTerminalResult | null> {
    if (input.source.kind !== 'recovery') throw new TypeError('MCP recovery requires recovery source kind.');
    const effectIntentId = requireId(input.effectIntentId, 'effectIntentId');
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    if (intent.effect_kind !== MCP_EFFECT_KIND) {
      throw new Error('MCP recovery target must be an mcp_tool_call EffectIntent.');
    }
    const existing = (await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2))[0];
    if (existing) return this.reconcileEffectReceipt(existing.id as string, 'recovery');
    if (intent.dispatch_state !== 'dispatched') {
      throw new Error('MCP recovery without a Receipt requires dispatch_state=dispatched.');
    }
    const recorded = await this.effects.recordEffectReceipt({
      source: input.source,
      attemptId: intent.attempt_id as string,
      effectKind: MCP_EFFECT_KIND,
      outcome: 'outcome_unknown',
      detail: {
        reason: 'MCP service cannot prove the result of the already-dispatched call after host restart.',
        automaticRetry: false
      }
    });
    return this.reconcileEffectReceipt(recorded.effectReceiptId, 'recovery');
  }

  public async reconcileEffectReceipt(
    effectReceiptId: string,
    sourceKind: 'internal' | 'recovery'
  ): Promise<ToolTerminalResult | null> {
    const receipt = await this.requireExisting('EffectReceipt', effectReceiptId);
    const outcome = requireMcpReceiptOutcome(receipt.outcome);
    return this.effects.completeOperation({
      source: { kind: sourceKind, key: `mcp-reconcile:${effectReceiptId}` },
      effectReceiptId,
      outcome
    });
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

export function mapMcpRisk(annotations: McpToolAnnotations | undefined): McpRiskLevel {
  if (annotations?.readOnlyHint === true && annotations.destructiveHint === true) {
    throw new TypeError('MCP tool annotations cannot be both read-only and destructive.');
  }
  if (annotations?.destructiveHint === true) return 'write';
  if (annotations?.readOnlyHint === true) return 'read';
  return 'command';
}

function normalizeRequest(value: McpToolCallRequest): McpToolCallRequest {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid mcp_tool_call request.');
  if (!['read', 'write', 'command'].includes(value.riskLevel)) throw new TypeError('Invalid MCP riskLevel.');
  return {
    serverId: requireId(value.serverId, 'serverId'),
    toolName: requireText(value.toolName, 'toolName'),
    arguments: normalizeArguments(value.arguments),
    riskLevel: value.riskLevel
  };
}

function normalizeArguments(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const normalized = normalizePlainJson(value, 'MCP arguments');
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new TypeError('MCP arguments must be a plain object.');
  }
  return normalized as Record<string, unknown>;
}

function normalizeAnnotations(value: McpToolAnnotations): McpToolAnnotations {
  const normalized = normalizePlainJson(value, 'MCP tool annotations');
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new TypeError('MCP tool annotations must be a plain object.');
  }
  const record = normalized as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== 'readOnlyHint' && key !== 'destructiveHint');
  if (unknown.length > 0) throw new TypeError(`Unsupported MCP annotation fields: ${unknown.join(', ')}.`);
  if (record.readOnlyHint !== undefined && typeof record.readOnlyHint !== 'boolean') {
    throw new TypeError('MCP readOnlyHint must be boolean when present.');
  }
  if (record.destructiveHint !== undefined && typeof record.destructiveHint !== 'boolean') {
    throw new TypeError('MCP destructiveHint must be boolean when present.');
  }
  return {
    ...(record.readOnlyHint === undefined ? {} : { readOnlyHint: record.readOnlyHint }),
    ...(record.destructiveHint === undefined ? {} : { destructiveHint: record.destructiveHint })
  };
}

function normalizeMcpBinaryResult(result: unknown): { result: unknown; parts: InlineDataPart[] } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { result, parts: [] };
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) return { result, parts: [] };
  const parts: InlineDataPart[] = [];
  const content = record.content.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const item = entry as Record<string, unknown>;
    if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string') {
      const mimeType = optionalMcpText(item.mimeType) ?? (item.type === 'image' ? 'image/png' : 'audio/mpeg');
      const name = optionalMcpText(item.name) ?? `mcp-${item.type}-${index + 1}${mcpExtension(mimeType)}`;
      const { data, ...metadata } = item;
      const sizeBytes = Buffer.from(data, 'base64').byteLength;
      parts.push({ inlineData: { mimeType, name, data, storage: 'embedded', status: 'available', sizeBytes } });
      return { ...metadata, name, sizeBytes, attachment: true };
    }
    if (item.type === 'resource' && item.resource && typeof item.resource === 'object' && !Array.isArray(item.resource)) {
      const resource = item.resource as Record<string, unknown>;
      if (typeof resource.blob !== 'string') return entry;
      const mimeType = optionalMcpText(resource.mimeType) ?? 'application/octet-stream';
      const name = optionalMcpText(resource.name)
        ?? mcpResourceName(optionalMcpText(resource.uri), index, mimeType);
      const { blob, ...resourceMetadata } = resource;
      const sizeBytes = Buffer.from(blob, 'base64').byteLength;
      parts.push({ inlineData: { mimeType, name, data: blob, storage: 'embedded', status: 'available', sizeBytes } });
      return {
        ...item,
        resource: { ...resourceMetadata, name, sizeBytes, attachment: true }
      };
    }
    return entry;
  });
  return { result: { ...record, content }, parts };
}

/** Removes unusable attachment bodies while keeping all text and non-binary result fields. */
function withoutUnavailableAttachments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUnavailableAttachments);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if ('inlineData' in record) {
    const { inlineData: _inlineData, ...siblings } = record;
    return { ...withoutUnavailableAttachments(siblings) as Record<string, unknown>, attachment: true, attachmentStatus: 'unavailable' };
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key,
    key === 'attachment' && entry === true ? true : withoutUnavailableAttachments(entry)
  ]).concat(record.attachment === true ? [['attachmentStatus', 'unavailable']] : []));
}

function usableMcpText(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { content: [] };
  const record = value as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    return item.type === 'text' && typeof item.text === 'string' ? [{ type: 'text', text: item.text }] : [];
  }) : typeof record.content === 'string' ? [{ type: 'text', text: record.content }] : [];
  return { content, ...(record.isError === true ? { isError: true } : {}) };
}

function optionalMcpText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mcpResourceName(uri: string | undefined, index: number, mimeType: string): string {
  const fromUri = uri?.split(/[\\/]/).filter(Boolean).at(-1)?.split(/[?#]/, 1)[0];
  return fromUri || `mcp-resource-${index + 1}${mcpExtension(mimeType)}`;
}

function mcpExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'application/pdf': return '.pdf';
    case 'audio/mpeg': return '.mp3';
    case 'audio/wav': return '.wav';
    case 'text/plain': return '.txt';
    default: return '';
  }
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

function isObservedMcpToolFailure(value: unknown): value is Record<string, unknown> & { isError: true } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).isError === true;
}

function mcpFailureMessage(value: Record<string, unknown>): string {
  const content = value.content;
  return typeof content === 'string' ? content : 'MCP server returned an observed tool error result.';
}

function requireMcpReceiptOutcome(
  value: unknown
): 'succeeded' | 'failed' | 'cancelled' | 'conflict' | 'outcome_unknown' {
  if (!['succeeded', 'failed', 'cancelled', 'conflict', 'outcome_unknown'].includes(String(value))) {
    throw new TypeError(`Invalid MCP EffectReceipt outcome: ${String(value)}.`);
  }
  return value as 'succeeded' | 'failed' | 'cancelled' | 'conflict' | 'outcome_unknown';
}

function boundedErrorMessage(error: unknown): string {
  return errorMessage(error).slice(0, 1000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mcpInvocationFailure(error: unknown, signal: AbortSignal | undefined): McpCallObservation {
  if (error instanceof McpInvocationError && error.certainty !== 'ambiguous_after_dispatch') {
    if (signal?.aborted && error.certainty === 'not_dispatched') {
      return { outcome: 'cancelled', error: error.message };
    }
    return { outcome: 'failed', error: error.message, result: null };
  }
  return {
    outcome: 'outcome_unknown',
    error: `MCP call was dispatched but its result cannot be proved: ${errorMessage(error)}`
  };
}

function createAbortWaiter(signal: AbortSignal | undefined): {
  promise?: Promise<{ kind: 'aborted' }>;
  dispose(): void;
} {
  if (!signal) return { dispose() {} };
  let listener: (() => void) | undefined;
  const promise = signal.aborted
    ? Promise.resolve({ kind: 'aborted' as const })
    : new Promise<{ kind: 'aborted' }>((resolve) => {
        listener = () => resolve({ kind: 'aborted' });
        signal.addEventListener('abort', listener, { once: true });
      });
  return {
    promise,
    dispose() {
      if (listener) signal.removeEventListener('abort', listener);
      listener = undefined;
    }
  };
}
