/**
 * Shared native (OpenAI Responses / Astra) tool fact shapes and validators.
 *
 * This leaf module is the single definition point for the durable native tool contract:
 * - ToolCallEvent kinds marking native admission and result delivery;
 * - the CAS content shapes of those events (attribution only — the owning row holds identity);
 * - the persisted ModelStreamCheckpoint proof shapes the EffectControlPlane validates before
 *   admitting a streamed native ToolCall.
 *
 * It imports nothing from the control planes so both Phase D (effectControlPlane) and
 * Stage E (contextSequence) can share it without a module cycle.
 */
import type { ModelOutputItemReference } from '../../shared/protocol';
import { normalizeModelHandleCatalog, type ModelHandleCatalog } from './modelHandleCatalog';
import { normalizePlainJson } from './plainJson';

/** ToolCallEvent.event_kind marking the durable native async/sync streamed admission of a call. */
export const TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION = 'native_admission';
/** ToolCallEvent.event_kind marking the server-admitted delivery of the call's ToolModelResult. */
export const TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY = 'native_delivery';

export const NATIVE_TOOL_ADMISSION_CONTENT_TYPE = 'application/vnd.limcode.native-tool-admission+json';
export const NATIVE_TOOL_DELIVERY_CONTENT_TYPE = 'application/vnd.limcode.native-tool-delivery+json';

/** ModelStreamCheckpoint content type for a complete native call item (kind native_tool_call). */
export const NATIVE_TOOL_CALL_CHECKPOINT_TYPE = 'native_tool_call';

/** Stable error code for fork/model-switch guards blocking on unsettled native async work. */
export const NATIVE_ASYNC_WORK_PENDING_CODE = 'NATIVE_ASYNC_WORK_PENDING';

export interface NativePendingWorkRef {
  toolCallId: string;
  reason: string;
}

/** Thrown when a native async guard finds admitted calls whose result facts are not closed. */
export class NativeAsyncWorkPendingError extends Error {
  public readonly code = NATIVE_ASYNC_WORK_PENDING_CODE;

  public constructor(
    public readonly pending: readonly NativePendingWorkRef[],
    action: string
  ) {
    super(
      `${pending.length} native async ToolCall(s) are not closed: ${pending
        .map((entry) => `${entry.toolCallId} (${entry.reason})`)
        .join(', ')}. ${action}`
    );
    this.name = 'NativeAsyncWorkPendingError';
  }
}

/**
 * Stream identity of the persisted complete native call item checkpoint proving one admission.
 * All sequence fields are decimal strings of the ModelStreamCheckpoint bigint columns.
 */
export interface NativeToolCallStreamIdentity {
  attemptSeq: string;
  socketGeneration: string;
  streamSeq: string;
  /**
   * Required when the admitted call is synchronous (declared async:false): the native_control
   * response-boundary checkpoint stream_seq for the same provider response/epoch.
   */
  completedResponseStreamSeq?: string;
  /** Required for synchronous admission: the provider response identity of that boundary. */
  providerResponseId?: string;
}

/** Persisted content of a native_tool_call checkpoint row (complete item proof). */
export interface NativeToolCallCheckpointContent {
  type: typeof NATIVE_TOOL_CALL_CHECKPOINT_TYPE;
  /** Provider response identity that emitted the item; pins sync admission to one response/epoch. */
  responseId: string;
  toolName: string;
  arguments: unknown;
  /** Trusted local interpretation frozen beside (never instead of) the original provider args. */
  resolvedArguments: unknown;
  argumentResolutionError?: string;
  modelHandleCatalog: ModelHandleCatalog;
  providerCallId: string;
  providerOrdinal: number;
  async: boolean;
  /** Actual output-item reference of the completed item; copied verbatim, never inferred. */
  outputItem?: ModelOutputItemReference;
}

/** Persisted content of a native_control checkpoint row (provider control observation). */
export interface NativeControlCheckpointContent {
  type: string;
  responseId: string;
  reason?: string;
  /**
   * Present on response.created checkpoints that admit an explicit tool-result create: the
   * original provider call ids whose function_call_output the created response admits.
   */
  admittedToolResultCallIds?: string[];
}

/** CAS content of a native_admission ToolCallEvent. Identity lives on the row, never here. */
export interface NativeToolAdmissionContent {
  type: typeof TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION;
  providerCallId: string;
  checkpointId: string;
  attemptSeq: string;
  socketGeneration: string;
  streamSeq: string;
  /** Provider response identity that emitted the call; survives checkpoint pruning. */
  responseId: string;
  declaredAsync: boolean;
  admittedAt: string;
  /** Actual output-item reference copied from the admission proof; survives checkpoint pruning. */
  outputItem?: ModelOutputItemReference;
}

/** CAS content of a native_delivery ToolCallEvent recording one server-admitted delivery. */
export interface NativeToolDeliveryContent {
  type: typeof TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY;
  toolModelResultId: string;
  messageRevisionId: string;
  providerCallId: string;
  carrierModelRequestId: string;
  providerResponseId: string;
  connectionGeneration?: string;
  streamId?: string;
  deliveredAt: string;
}

/** Boundary object check for persisted payloads; every field is still validated individually. */
function requireObjectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireRecordText(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} requires a non-empty string ${key}.`);
  }
  return value;
}

function optionalRecordText(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} requires ${key} to be a non-empty string when present.`);
  }
  return value;
}

function requireDecimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a non-negative decimal string.`);
  }
  return value;
}

/** Normalizes a caller-supplied stream identity; throws TypeError on malformed fields. */
export function normalizeNativeStreamIdentity(
  input: NativeToolCallStreamIdentity
): NativeToolCallStreamIdentity {
  const record = requireObjectRecord(input, 'Native stream identity');
  const identity: NativeToolCallStreamIdentity = {
    attemptSeq: requireDecimalString(record.attemptSeq, 'streamIdentity.attemptSeq'),
    socketGeneration: requireDecimalString(record.socketGeneration, 'streamIdentity.socketGeneration'),
    streamSeq: requireDecimalString(record.streamSeq, 'streamIdentity.streamSeq')
  };
  if (record.completedResponseStreamSeq !== undefined) {
    identity.completedResponseStreamSeq = requireDecimalString(
      record.completedResponseStreamSeq,
      'streamIdentity.completedResponseStreamSeq'
    );
  }
  if (record.providerResponseId !== undefined) {
    if (typeof record.providerResponseId !== 'string' || record.providerResponseId.length === 0) {
      throw new TypeError('streamIdentity.providerResponseId must be a non-empty string.');
    }
    identity.providerResponseId = record.providerResponseId;
  }
  return identity;
}

/**
 * Validates an actual ModelOutputItemReference carried by native proofs. The id is copied from the
 * persisted metadata and never inferred from any call id; malformed metadata is a hard error.
 */
export function parseNativeOutputItem(value: unknown, label: string): ModelOutputItemReference | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireObjectRecord(value, label);
  const id = requireRecordText(record, 'id', label);
  const ordinal = record.ordinal;
  if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new TypeError(`${label} ordinal must be a non-negative safe integer.`);
  }
  const phase = record.phase === 'commentary' || record.phase === 'final_answer'
    ? record.phase
    : undefined;
  if (record.phase !== undefined && record.phase !== null && phase === undefined) {
    throw new TypeError(`${label} phase must be 'commentary' or 'final_answer'.`);
  }
  const providerResponseId = optionalRecordText(record, 'providerResponseId', label);
  const previousResponseId = optionalRecordText(record, 'previousResponseId', label);
  return {
    id,
    ordinal,
    ...(phase ? { phase } : {}),
    ...(providerResponseId ? { providerResponseId } : {}),
    ...(previousResponseId ? { previousResponseId } : {})
  };
}

/** Parses persisted native_tool_call checkpoint content; throws TypeError on any drift. */
export function parseNativeToolCallCheckpoint(value: unknown): NativeToolCallCheckpointContent {
  const record = requireObjectRecord(value, 'Native tool-call checkpoint content');
  if (record.type !== NATIVE_TOOL_CALL_CHECKPOINT_TYPE) {
    throw new TypeError(`Native tool-call checkpoint content type must be ${NATIVE_TOOL_CALL_CHECKPOINT_TYPE}.`);
  }
  const toolName = requireRecordText(record, 'toolName', 'Native tool-call checkpoint');
  const responseId = requireRecordText(record, 'responseId', 'Native tool-call checkpoint');
  const providerCallId = requireRecordText(record, 'providerCallId', 'Native tool-call checkpoint');
  const providerOrdinal = record.providerOrdinal;
  if (typeof providerOrdinal !== 'number' || !Number.isSafeInteger(providerOrdinal) || providerOrdinal < 0) {
    throw new TypeError('Native tool-call checkpoint providerOrdinal must be a non-negative safe integer.');
  }
  if (typeof record.async !== 'boolean') {
    throw new TypeError('Native tool-call checkpoint async must be a boolean.');
  }
  if (!('arguments' in record)) {
    throw new TypeError('Native tool-call checkpoint requires an arguments field.');
  }
  if (!('resolvedArguments' in record)) throw new TypeError('Native tool-call checkpoint requires frozen resolvedArguments.');
  const catalogValue = requireObjectRecord(record.modelHandleCatalog, 'Native tool-call modelHandleCatalog');
  if (!Array.isArray(catalogValue.entries)) throw new TypeError('Native tool-call checkpoint requires modelHandleCatalog.entries.');
  const modelHandleCatalog = normalizeModelHandleCatalog(catalogValue);
  // The frozen resolution is content-addressed authority captured when the call was proven. It is
  // never re-derived with the current resolver: a later build may interpret handle references
  // differently, and re-deriving would reject (or silently change) an in-flight call. Only its
  // shape is validated here; identity fields above bind it to the provider call.
  normalizePlainJson(record.arguments, 'Native tool-call checkpoint arguments');
  normalizePlainJson(record.resolvedArguments, 'Native tool-call checkpoint resolvedArguments');
  const argumentResolutionError = optionalRecordText(record, 'argumentResolutionError', 'Native tool-call checkpoint');
  const outputItem = parseNativeOutputItem(record.outputItem, 'Native tool-call checkpoint outputItem');
  return {
    type: NATIVE_TOOL_CALL_CHECKPOINT_TYPE,
    responseId,
    toolName,
    arguments: record.arguments,
    resolvedArguments: record.resolvedArguments,
    modelHandleCatalog,
    ...(argumentResolutionError !== undefined ? { argumentResolutionError } : {}),
    providerCallId,
    providerOrdinal,
    async: record.async,
    ...(outputItem ? { outputItem } : {})
  };
}

/** Parses persisted native_control checkpoint content (the provider native event JSON). */
export function parseNativeControlCheckpoint(value: unknown): NativeControlCheckpointContent {
  const record = requireObjectRecord(value, 'Native control checkpoint content');
  const type = requireRecordText(record, 'type', 'Native control checkpoint');
  const responseId = requireRecordText(record, 'responseId', 'Native control checkpoint');
  const reason = optionalRecordText(record, 'reason', 'Native control checkpoint');
  const rawAdmitted = record.admittedToolResultCallIds;
  const admittedToolResultCallIds = rawAdmitted === undefined || rawAdmitted === null
    ? undefined
    : (() => {
        if (!Array.isArray(rawAdmitted) || rawAdmitted.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
          throw new TypeError('Native control checkpoint admittedToolResultCallIds must be a list of non-empty strings.');
        }
        return rawAdmitted as string[];
      })();
  return {
    type,
    responseId,
    ...(reason === undefined ? {} : { reason }),
    ...(admittedToolResultCallIds === undefined ? {} : { admittedToolResultCallIds })
  };
}

/**
 * A native_control checkpoint is a valid admission boundary for synchronous calls only at a real
 * response boundary: completed, or an incomplete steered boundary. Every other observation
 * (response.created, deltas, other incomplete reasons) is not a boundary.
 */
export function isNativeAdmissionBoundary(content: NativeControlCheckpointContent): boolean {
  return content.type === 'response.completed'
    || (content.type === 'response.incomplete' && content.reason === 'steered');
}

/** Serializes the durable admission attribution payload of one native ToolCall. */
export function nativeAdmissionContent(input: Omit<NativeToolAdmissionContent, 'type'>): NativeToolAdmissionContent {
  const outputItem = parseNativeOutputItem(input.outputItem, 'Native admission outputItem');
  return {
    type: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION,
    providerCallId: requireRecordText({ providerCallId: input.providerCallId }, 'providerCallId', 'Native admission'),
    checkpointId: requireRecordText({ checkpointId: input.checkpointId }, 'checkpointId', 'Native admission'),
    attemptSeq: requireDecimalString(input.attemptSeq, 'Native admission attemptSeq'),
    socketGeneration: requireDecimalString(input.socketGeneration, 'Native admission socketGeneration'),
    streamSeq: requireDecimalString(input.streamSeq, 'Native admission streamSeq'),
    responseId: requireRecordText({ responseId: input.responseId }, 'responseId', 'Native admission'),
    declaredAsync: input.declaredAsync === true,
    admittedAt: requireRecordText({ admittedAt: input.admittedAt }, 'admittedAt', 'Native admission'),
    ...(outputItem ? { outputItem } : {})
  };
}

/** Parses a persisted native_admission ToolCallEvent payload; throws TypeError on drift. */
export function parseNativeAdmissionContent(value: unknown): NativeToolAdmissionContent {
  const record = requireObjectRecord(value, 'Native admission content');
  if (record.type !== TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION) {
    throw new TypeError('Native admission content type mismatch.');
  }
  const outputItem = parseNativeOutputItem(record.outputItem, 'Native admission outputItem');
  return {
    type: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION,
    providerCallId: requireRecordText(record, 'providerCallId', 'Native admission'),
    checkpointId: requireRecordText(record, 'checkpointId', 'Native admission'),
    attemptSeq: requireDecimalString(record.attemptSeq, 'Native admission attemptSeq'),
    socketGeneration: requireDecimalString(record.socketGeneration, 'Native admission socketGeneration'),
    streamSeq: requireDecimalString(record.streamSeq, 'Native admission streamSeq'),
    responseId: requireRecordText(record, 'responseId', 'Native admission'),
    declaredAsync: record.declaredAsync === true,
    admittedAt: requireRecordText(record, 'admittedAt', 'Native admission'),
    ...(outputItem ? { outputItem } : {})
  };
}

/** Serializes the durable delivery attribution payload of one native ToolModelResult. */
export function nativeDeliveryContent(input: Omit<NativeToolDeliveryContent, 'type'>): NativeToolDeliveryContent {
  return readNativeDeliveryFields(requireObjectRecord(input, 'Native result delivery'));
}

function readNativeDeliveryFields(record: Record<string, unknown>): NativeToolDeliveryContent {
  const toolModelResultId = requireRecordText(record, 'toolModelResultId', 'Native result delivery');
  const messageRevisionId = requireRecordText(record, 'messageRevisionId', 'Native result delivery');
  const providerCallId = requireRecordText(record, 'providerCallId', 'Native result delivery');
  const carrierModelRequestId = requireRecordText(record, 'carrierModelRequestId', 'Native result delivery');
  const providerResponseId = requireRecordText(record, 'providerResponseId', 'Native result delivery');
  const deliveredAt = requireRecordText(record, 'deliveredAt', 'Native result delivery');
  const connectionGeneration = record.connectionGeneration === undefined || record.connectionGeneration === null
    ? undefined
    : requireDecimalString(record.connectionGeneration, 'Native result delivery connectionGeneration');
  const streamId = optionalRecordText(record, 'streamId', 'Native result delivery');
  return {
    type: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY,
    toolModelResultId,
    messageRevisionId,
    providerCallId,
    carrierModelRequestId,
    providerResponseId,
    ...(connectionGeneration === undefined ? {} : { connectionGeneration }),
    ...(streamId === undefined ? {} : { streamId }),
    deliveredAt
  };
}

/** Parses a persisted native_delivery ToolCallEvent payload; throws TypeError on drift. */
export function parseNativeDeliveryContent(value: unknown): NativeToolDeliveryContent {
  const record = requireObjectRecord(value, 'Native delivery content');
  if (record.type !== TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY) throw new TypeError('Native delivery content has an invalid type.');
  return readNativeDeliveryFields(record);
}
