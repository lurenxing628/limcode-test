import { measurementRecord, singleResponseMeasurement, type SingleResponseMeasurement } from '../../shared/modelRequestMeasurement';
import { isGpt6FamilyModel } from '../../shared/openAIResponsesCapabilities';
import { nativeSessionCapabilities } from '../../shared/nativeSessionCapabilities';
import type Database from 'better-sqlite3';
import type { ClientProjectionContentAccess } from './clientProjection';
import { prepareCached } from './runtimeStatementCache';
import { requireRuntimeId } from './runtimeSqlRows';
import { parseNativeResponseTiming } from './nativeResponseMetrics';
import type { DomainRow } from './repositories';

const RECIPE_TYPE = 'application/vnd.limcode.model-request-recipe+json';
const CONTROL_TYPE = 'application/vnd.limcode.model-stream-checkpoint+json';
const MAX_RECIPE_BYTES = 2 * 1024 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
const CACHE_ENTRIES = 128;

/** Cheap selection only, never evidence that a request was ordinary. */
export function needsSingleResponseMeasurement(request: DomainRow): boolean {
  const usage = measurementRecord(request.usage_json);
  const stats = measurementRecord(request.stream_stats_json);
  return ['id', 'turn_id', 'provider_id', 'model_id', 'recipe_object_id', 'authority_snapshot_id'].every(key =>
    typeof request[key] === 'string' && (request[key] as string).length > 0 && (request[key] as string).length <= 512)
    && (request.settings_snapshot_object_id == null || (typeof request.settings_snapshot_object_id === 'string'
      && request.settings_snapshot_object_id.length <= 512))
    && request.status === 'terminal' && request.terminal_state === 'completed'
    && usage?.nativeChainBilling === true && usage.nativeChainUsageIncomplete !== true
    && usage.nativeChainUsageDetailsIncomplete !== true && usage.estimated !== true && usage.tokenEstimator === undefined
    && token(usage.promptTokenCount) && token(usage.candidatesTokenCount) && token(usage.totalTokenCount)
    && (usage.cachedContentTokenCount === undefined || token(usage.cachedContentTokenCount))
    && (usage.thoughtsTokenCount === undefined || token(usage.thoughtsTokenCount))
    && isGpt6FamilyModel(typeof request.model_id === 'string' ? request.model_id : undefined)
    && Boolean(stats) && stats!.nativeCapabilities === undefined && stats!.nativeInitialPromptTokenCount === undefined
    && stats!.nativeLatestResponseUsage === undefined && stats!.nativeResponseMetrics === undefined;
}

/**
 * Read-only evidence for ordinary HTTP responses that were incorrectly labelled chain billing.
 * This is not a data migration: raw usage, recipes, checkpoints and their CAS bytes never change.
 * Only a frozen ordinary recipe AND one exact created/completed pair under the terminal fence
 * can override that label. Missing or ambiguous evidence leaves the existing unknown untouched.
 */
export class SingleResponseMeasurementReader {
  private generation = '';
  private readonly cache = new Map<string, { identity: string; measurement: SingleResponseMeasurement }>();

  public constructor(private readonly database: Database.Database, private readonly content: ClientProjectionContentAccess) {}

  public read(request: DomainRow): SingleResponseMeasurement | undefined {
    if (!needsSingleResponseMeasurement(request) || typeof request.id !== 'string'
      || typeof request.recipe_object_id !== 'string' || typeof request.authority_snapshot_id !== 'string') return undefined;
    if (!this.database.inTransaction) throw new Error('Single response measurement requires one read snapshot.');
    const current = row(prepareCached(this.database, 'SELECT * FROM model_request WHERE id = ?').get(request.id));
    if (!current || !needsSingleResponseMeasurement(current) || singleResponseMeasurementIdentity(current) !== singleResponseMeasurementIdentity(request)) return undefined;
    // Reader connection data_version changes on writer commits (including other Hosts); total_changes
    // also covers same-connection writes in isolated tests/maintenance. Cache is scoped to this DB
    // instance AND the worker-owned verified CAS capability, never to a bare path or request id.
    const generation = `${(prepareCached(this.database, 'PRAGMA data_version').get() as { data_version: number | bigint }).data_version}:${
      (prepareCached(this.database, 'SELECT total_changes() AS value').get() as { value: number | bigint }).value}`;
    if (this.generation !== generation) { this.cache.clear(); this.generation = generation; }
    const key = singleResponseMeasurementIdentity(current);
    const cached = this.cache.get(request.id);
    if (cached?.identity === key) {
      this.cache.delete(request.id); this.cache.set(request.id, cached);
      return structuredClone(cached.measurement);
    }
    const controls = prepareCached(this.database, `SELECT * FROM model_stream_checkpoint
      WHERE model_request_id = ? AND checkpoint_kind = 'native_control'
      ORDER BY attempt_seq, socket_generation, stream_seq LIMIT 3`).all(request.id) as DomainRow[];
    const nativeCall = prepareCached(this.database, `SELECT id FROM model_stream_checkpoint
      WHERE model_request_id = ? AND checkpoint_kind = 'native_tool_call' LIMIT 1`).get(request.id);
    const fences = prepareCached(this.database, 'SELECT * FROM model_stream_fence WHERE model_request_id = ? LIMIT 2').all(request.id) as DomainRow[];
    const recipeMetadata = this.metadata(request.recipe_object_id);
    const authority = row(prepareCached(this.database, 'SELECT * FROM authority_snapshot WHERE id = ?').get(request.authority_snapshot_id));
    if (controls.length !== 2 || nativeCall || fences.length !== 1
      || !recipeMetadata || !authority || authority.turn_id !== current.turn_id
      || typeof authority.content_object_id !== 'string') return undefined;
    const stats = measurementRecord(current.stream_stats_json)!;
    const fence = fences[0];
    if (fence.model_request_id !== current.id || String(fence.attempt_seq) !== stats.attemptSeq
      || String(fence.socket_generation) !== stats.socketGeneration || fence.outcome !== 'completed') return undefined;
    controls.sort((a, b) => BigInt(String(a.stream_seq)) < BigInt(String(b.stream_seq)) ? -1 : 1);
    if (controls.some(control => control.model_request_id !== current.id
      || String(control.attempt_seq) !== stats.attemptSeq || String(control.socket_generation) !== stats.socketGeneration
      || BigInt(String(control.stream_seq)) >= BigInt(String(fence.terminal_stream_seq)))) return undefined;
    const recipe = this.readJson(recipeMetadata, RECIPE_TYPE, MAX_RECIPE_BYTES);
    if (!recipe || recipe.kind !== 'reliable-agent-turn' || recipe.nativeResponses !== undefined
      || recipe.nativeLogicalBudget !== undefined || recipe.nativeErrorRecovery !== undefined) return undefined;
    const createdMeta = this.metadata(String(controls[0].content_object_id));
    const completedMeta = this.metadata(String(controls[1].content_object_id));
    const authorityMeta = this.metadata(authority.content_object_id);
    if (!createdMeta || !completedMeta || !authorityMeta) return undefined;
    // Authority is verified immutable data, not the channel settings currently selected in the UI.
    const document = this.readJson(authorityMeta, 'application/vnd.limcode.turn-authority-snapshot+json', MAX_RECIPE_BYTES);
    const model = measurementRecord(document?.model);
    if (!model || model.provider !== 'openai-responses' || model.providerConfigId !== current.provider_id
      || model.modelId !== current.model_id || (model.openaiResponsesTransport !== undefined && model.openaiResponsesTransport !== 'http')) return undefined;
    const createdEnvelope = this.readJson(createdMeta, CONTROL_TYPE, MAX_CONTROL_BYTES);
    const completedEnvelope = this.readJson(completedMeta, CONTROL_TYPE, MAX_CONTROL_BYTES);
    if (createdEnvelope?.kind !== 'native_control' || completedEnvelope?.kind !== 'native_control'
      || createdEnvelope.streamSeq !== String(controls[0].stream_seq)
      || completedEnvelope.streamSeq !== String(controls[1].stream_seq)) return undefined;
    const created = measurementRecord(createdEnvelope.content);
    const completed = measurementRecord(completedEnvelope.content);
    const capabilities = measurementRecord(created?.capabilities);
    const capabilityFields = ['asyncTools', 'steering', 'reasoningUpdates', 'multiplexing', 'explicitCaching'];
    if (!created || !completed || created.type !== 'response.created' || completed.type !== 'response.completed'
      || typeof created.responseId !== 'string' || !created.responseId || created.responseId.length > 512
      || created.responseId !== completed.responseId || created.previousResponseId !== undefined || completed.previousResponseId !== undefined
      || !capabilities || Object.keys(capabilities).length !== capabilityFields.length
      || capabilityFields.some(key => typeof capabilities[key] !== 'boolean')
      || nativeSessionCapabilities(capabilities) || created.admittedToolResultCallIds !== undefined
      || completed.requiredInput !== undefined || completed.reason !== undefined) return undefined;
    const raw = measurementRecord(completed.usage);
    const usage = measurementRecord(current.usage_json)!;
    if (!raw || !token(raw.input_tokens) || !token(raw.output_tokens)
      || raw.input_tokens !== usage.promptTokenCount || raw.output_tokens !== usage.candidatesTokenCount
      || (raw.total_tokens !== undefined && raw.total_tokens !== raw.input_tokens + raw.output_tokens)
      || usage.totalTokenCount !== raw.input_tokens + raw.output_tokens) return undefined;
    const cachedTokens = measurementRecord(raw.input_tokens_details)?.cached_tokens;
    const reasoning = measurementRecord(raw.output_tokens_details)?.reasoning_tokens;
    if (cachedTokens !== usage.cachedContentTokenCount || reasoning !== usage.thoughtsTokenCount) return undefined;
    // This retained physical timing excludes response.created. Request-wide firstOutputAt from the
    // same producer may have counted that control event, so it is not used to repair old timing.
    if (completed.timing === undefined) return undefined;
    const timing = parseNativeResponseTiming(completed.timing);
    if (typeof stats.completedAt !== 'number' || typeof stats.providerStartedAt !== 'number'
      || timing.completedAt > stats.completedAt || timing.startedAt < stats.providerStartedAt) return undefined;
    const measurement: SingleResponseMeasurement = {
      recipeObjectId: String(current.recipe_object_id), responseId: created.responseId,
      attemptSeq: String(stats.attemptSeq), socketGeneration: String(stats.socketGeneration),
      inputTokens: raw.input_tokens, outputTokens: raw.output_tokens, totalTokens: usage.totalTokenCount as number,
      timing
    };
    if (!singleResponseMeasurement({ ...current, single_response_measurement: measurement })) return undefined;
    while (this.cache.size >= CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(request.id, { identity: key, measurement });
    return structuredClone(measurement);
  }

  public project(requests: DomainRow[]): DomainRow[] {
    const projected: DomainRow[] = [];
    // Sequential and bounded by the existing snapshot/page limits. No history/body traversal.
    for (const request of requests) {
      const measurement = this.read(request);
      const { single_response_measurement: _untrustedProjection, ...facts } = request;
      projected.push(measurement ? { ...facts, single_response_measurement: measurement } : facts);
    }
    return projected;
  }

  private metadata(id: string): DomainRow | undefined {
    return row(prepareCached(this.database, 'SELECT * FROM content_object WHERE id = ?').get(id));
  }

  private readJson(metadata: DomainRow, contentType: string, maximum: number): DomainRow | undefined {
    if (metadata.content_type !== contentType
      || BigInt(String(metadata.byte_length)) > BigInt(maximum)) return undefined;
    return measurementRecord(JSON.parse(this.content.readVerifiedBytes(metadata).toString('utf8')));
  }
}

export function singleResponseMeasurementIdentity(request: DomainRow): string {
  const usage = measurementRecord(request.usage_json);
  const stats = measurementRecord(request.stream_stats_json);
  return JSON.stringify([request.id, request.turn_id, request.provider_id, request.model_id, request.recipe_object_id,
    request.authority_snapshot_id, request.settings_snapshot_object_id ?? null, request.status, request.terminal_state,
    usage?.promptTokenCount, usage?.candidatesTokenCount, usage?.totalTokenCount, usage?.cachedContentTokenCount,
    usage?.thoughtsTokenCount, usage?.nativeChainBilling, stats?.attemptSeq, stats?.socketGeneration,
    stats?.providerStartedAt, stats?.firstOutputAt, stats?.completedAt, stats?.streamOutputDurationMs]);
}
function row(value: unknown): DomainRow | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DomainRow : undefined;
}
function token(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

const readers = new WeakMap<Database.Database, WeakMap<ClientProjectionContentAccess, SingleResponseMeasurementReader>>();
export function singleResponseMeasurementReader(database: Database.Database, content: ClientProjectionContentAccess): SingleResponseMeasurementReader {
  let stores = readers.get(database);
  if (!stores) { stores = new WeakMap(); readers.set(database, stores); }
  let reader = stores.get(content);
  if (!reader) { reader = new SingleResponseMeasurementReader(database, content); stores.set(content, reader); }
  return reader;
}

/** Dedicated read operation for backend calibration; client snapshot/page calls already hold a transaction. */
export function executeSingleResponseMeasurement(database: Database.Database, content: ClientProjectionContentAccess,
  requestId: string, expectedIdentity: string): SingleResponseMeasurement | null {
  requireRuntimeId(requestId);
  if (typeof expectedIdentity !== 'string' || expectedIdentity.length > 8192) throw new TypeError('Invalid measurement identity.');
  database.exec('BEGIN');
  try {
    const request = row(prepareCached(database, 'SELECT * FROM model_request WHERE id = ?').get(requestId));
    const measurement = request && singleResponseMeasurementIdentity(request) === expectedIdentity
      ? singleResponseMeasurementReader(database, content).read(request) : undefined;
    database.exec('COMMIT');
    return measurement ?? null;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
