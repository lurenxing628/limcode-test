export type ModelHandleKind = 'attachment' | 'process' | 'cursor' | 'child' | 'workEnvironment';

export class UnknownModelHandleReferenceError extends Error {
  public readonly code = 'UNKNOWN_MODEL_HANDLE_REFERENCE';

  public constructor(
    public readonly kind: ModelHandleKind,
    public readonly ref: string
  ) {
    super(`未知${handleKindLabel(kind)}引用：${ref}`);
    this.name = 'UnknownModelHandleReferenceError';
  }
}

export interface ModelHandleEntry {
  kind: ModelHandleKind;
  ref: string;
  target: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface ModelHandleCatalog {
  entries: ModelHandleEntry[];
}

interface ModelHandleCandidate {
  kind: ModelHandleKind;
  target: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

const HANDLE_PREFIX: Record<ModelHandleKind, string> = {
  attachment: 'F',
  process: 'P',
  cursor: 'O',
  child: 'A',
  workEnvironment: 'W'
};

const HANDLE_PATTERN = /^(?:F|P|O|A|W)[1-9]\d*$/;
const WORK_ENVIRONMENT_PATTERN = /\bwork-env-[a-zA-Z0-9._-]+\b/g;
const MAX_NESTED_JSON_CHARS = 16 * 1024 * 1024;

/**
 * Builds one small model-facing reference table from the exact values visible to a ModelRequest.
 * Canonical ids remain internal; only the short refs are rendered to the provider.
 */
export function buildModelHandleCatalog(
  values: readonly unknown[],
  seededEntries: readonly ModelHandleEntry[] = []
): ModelHandleCatalog {
  const candidates: ModelHandleCandidate[] = [];
  const seenObjects = new Set<object>();
  for (const value of values) collectCandidates(value, candidates, seenObjects);

  const normalizedSeeds = normalizeModelHandleCatalog({ entries: seededEntries }).entries;
  const byTarget = new Map<string, ModelHandleEntry>();
  const counters: Record<ModelHandleKind, number> = {
    attachment: 0,
    process: 0,
    cursor: 0,
    child: 0,
    workEnvironment: 0
  };
  const entries: ModelHandleEntry[] = [];
  for (const seed of normalizedSeeds) {
    const ordinal = Number(seed.ref.slice(1));
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
      throw new RangeError(`Seeded model handle ${seed.ref} is outside the safe ordinal range.`);
    }
    counters[seed.kind] = Math.max(counters[seed.kind], ordinal);
    const cloned = { ...seed };
    byTarget.set(targetKey(seed.kind, seed.target), cloned);
    entries.push(cloned);
  }
  for (const candidate of candidates) {
    const key = targetKey(candidate.kind, candidate.target);
    const existing = byTarget.get(key);
    if (existing) {
      mergeMetadata(existing, candidate);
      continue;
    }
    const ref = `${HANDLE_PREFIX[candidate.kind]}${++counters[candidate.kind]}`;
    const entry: ModelHandleEntry = {
      kind: candidate.kind,
      ref,
      target: candidate.target,
      ...(candidate.name ? { name: candidate.name } : {}),
      ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
      ...(candidate.sizeBytes !== undefined ? { sizeBytes: candidate.sizeBytes } : {})
    };
    byTarget.set(key, entry);
    entries.push(entry);
  }
  return { entries };
}

export function normalizeModelHandleCatalog(value: unknown): ModelHandleCatalog {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.entries)) return { entries: [] };
  const refs = new Set<string>();
  const targets = new Set<string>();
  const entries = record.entries.map((candidate, index): ModelHandleEntry => {
    const entry = asRecord(candidate);
    if (!entry) throw new TypeError(`modelHandleCatalog.entries[${index}] must be an object.`);
    const kind = requireKind(entry.kind, `modelHandleCatalog.entries[${index}].kind`);
    const ref = requireText(entry.ref, `modelHandleCatalog.entries[${index}].ref`);
    const target = requireText(entry.target, `modelHandleCatalog.entries[${index}].target`);
    if (!HANDLE_PATTERN.test(ref) || !ref.startsWith(HANDLE_PREFIX[kind])) {
      throw new TypeError(`modelHandleCatalog.entries[${index}].ref does not match its kind.`);
    }
    const targetIdentity = targetKey(kind, target);
    if (refs.has(ref)) throw new Error(`Duplicate model handle ref: ${ref}`);
    if (targets.has(targetIdentity)) throw new Error(`Duplicate model handle target for ${kind}: ${target}`);
    refs.add(ref);
    targets.add(targetIdentity);
    const sizeBytes = optionalNonNegativeInteger(entry.sizeBytes);
    const name = optionalText(entry.name);
    const mimeType = optionalText(entry.mimeType);
    return {
      kind,
      ref,
      target,
      ...(name ? { name } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {})
    };
  });
  return { entries };
}

export function modelHandleRef(
  catalogInput: ModelHandleCatalog | unknown,
  kind: ModelHandleKind,
  target: unknown
): string | undefined {
  const normalizedTarget = optionalText(target);
  if (!normalizedTarget) return undefined;
  return normalizeModelHandleCatalog(catalogInput).entries.find((entry) =>
    entry.kind === kind && entry.target === normalizedTarget)?.ref;
}

export function modelHandleTarget(
  catalogInput: ModelHandleCatalog | unknown,
  kind: ModelHandleKind,
  ref: unknown
): string | undefined {
  const normalizedRef = optionalText(ref);
  if (!normalizedRef) return undefined;
  return normalizeModelHandleCatalog(catalogInput).entries.find((entry) =>
    entry.kind === kind && entry.ref === normalizedRef)?.target;
}

export function modelHandleEntries(
  catalogInput: ModelHandleCatalog | unknown,
  kind?: ModelHandleKind
): ModelHandleEntry[] {
  const entries = normalizeModelHandleCatalog(catalogInput).entries;
  return entries.filter((entry) => kind === undefined || entry.kind === kind);
}

/** Removes durable result-envelope ids and replaces actionable canonical values with short refs. */
export function projectToolResultForModel(
  toolName: string,
  value: unknown,
  catalogInput: ModelHandleCatalog | unknown
): unknown {
  const catalog = normalizeModelHandleCatalog(catalogInput);
  const envelope = asRecord(value);
  if (envelope && typeof envelope.status === 'string' && 'detail' in envelope) {
    return {
      status: envelope.status,
      detail: projectKnownToolValue(toolName, envelope.detail, catalog)
    };
  }
  return projectKnownToolValue(toolName, value, catalog);
}

export function projectKnownToolValue(
  toolName: string,
  value: unknown,
  catalogInput: ModelHandleCatalog | unknown
): unknown {
  const catalog = normalizeModelHandleCatalog(catalogInput);
  const projected = projectKnownValue(value, catalog);
  const record = asRecord(projected);
  if (!record) return projected;

  if (toolName === 'bash' || toolName === 'shell') {
    const hasMore = record.hasMore === true;
    const running = record.status === 'running' || record.status === 'background_started'
      || record.complete === false;
    if (!hasMore) delete record.nextCursor;
    if (!running && !hasMore) delete record.processRef;
  }
  if (toolName === 'run_agent' || toolName === 'read_agent_answer' || toolName === 'submit_agent_answer') {
    for (const key of [
      'agentId', 'runId', 'conversationId', 'childExecutionId', 'submissionId',
      'sourceTurnId', 'activeTurnIds', 'cancelledIntentIds'
    ]) delete record[key];
  }
  return record;
}

/** Converts the short provider contract back to the existing canonical internal tool contract. */
export function resolveModelToolArguments(
  toolName: string,
  argumentsInput: unknown,
  catalogInput: ModelHandleCatalog | unknown
): unknown {
  const catalog = normalizeModelHandleCatalog(catalogInput);
  const args = cloneValue(argumentsInput);
  const record = asRecord(args);
  if (!record) return args;

  if (toolName === 'read') {
    replaceRef(record, 'attachmentRef', 'attachmentId', 'attachment', catalog);
  } else if (toolName === 'bash' || toolName === 'shell') {
    replaceRef(record, 'processRef', 'processId', 'process', catalog);
    replaceRef(record, 'cursor', 'outputHandle', 'cursor', catalog);
  } else if (toolName === 'run_agent' || toolName === 'read_agent_answer' || toolName === 'submit_agent_answer') {
    if ('childRef' in record) {
      const ref = optionalText(record.childRef);
      const target = ref ? modelHandleTarget(catalog, 'child', ref) : undefined;
      if (!target || ('answerBridgeId' in record && record.answerBridgeId !== target)) {
        throw new UnknownModelHandleReferenceError('child', ref ?? '(invalid childRef)');
      }
    }
    replaceRef(record, 'childRef', 'answerBridgeId', 'child', catalog);
    if ('childRefs' in record) {
      if (!Array.isArray(record.childRefs) || record.childRefs.length === 0 || record.childRefs.length > 32) {
        throw new UnknownModelHandleReferenceError('child', '(invalid childRefs)');
      }
      const targets = record.childRefs.map((value) => {
        const ref = optionalText(value);
        const target = ref ? modelHandleTarget(catalog, 'child', ref) : undefined;
        if (!target) throw new UnknownModelHandleReferenceError('child', ref ?? '(invalid childRef)');
        return target;
      });
      if ('answerBridgeIds' in record && JSON.stringify(record.answerBridgeIds) !== JSON.stringify(targets)) {
        throw new UnknownModelHandleReferenceError('child', '(conflicting childRefs)');
      }
      delete record.childRefs;
      record.answerBridgeIds = targets;
    }
  } else if (toolName === 'switch_work_environment') {
    replaceRef(record, 'workEnvironmentRef', 'workEnvironmentId', 'workEnvironment', catalog);
  } else if (toolName === 'transfer_files' && Array.isArray(record.transfers)) {
    for (const transferValue of record.transfers) {
      const transfer = asRecord(transferValue);
      if (!transfer) continue;
      replaceEnvironmentValue(transfer, 'fromEnvironment', catalog);
      replaceEnvironmentValue(transfer, 'toEnvironment', catalog);
    }
  }
  return args;
}

const MODEL_INTERNAL_RESULT_KEYS = new Set([
  'toolCallId',
  'processReceiptId',
  'originToolCallId',
  'sourceTurnId',
  'conversationId',
  'deliveryId',
  'inboxItemId',
  'targetTurnId',
  'sourceId',
  'agentId',
  'runId',
  'childExecutionId',
  'submissionId',
  'operationId',
  'effectIntentId',
  'receiptId'
]);

function projectKnownValue(value: unknown, catalog: ModelHandleCatalog): unknown {
  if (typeof value === 'string') return projectKnownText(value, catalog);
  if (Array.isArray(value)) return value.map((entry) => projectKnownValue(entry, catalog));
  const source = asRecord(value);
  if (!source) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (MODEL_INTERNAL_RESULT_KEYS.has(key)) continue;
    if (key === 'attachmentId' && typeof child === 'string') {
      const ref = modelHandleRef(catalog, 'attachment', child);
      if (ref) output.attachmentRef = ref;
      continue;
    }
    if (key === 'processId' && typeof child === 'string') {
      const ref = modelHandleRef(catalog, 'process', child);
      if (ref) output.processRef = ref;
      continue;
    }
    if (key === 'answerBridgeId' && typeof child === 'string') {
      const ref = modelHandleRef(catalog, 'child', child);
      if (ref) output.childRef = ref;
      continue;
    }
    if (key === 'answerBridgeIds' && Array.isArray(child)) {
      output.childRefs = child.map((target) => {
        const ref = modelHandleRef(catalog, 'child', target);
        if (!ref) throw new UnknownModelHandleReferenceError('child', '(unmapped child result)');
        return ref;
      });
      continue;
    }
    if (key === 'workEnvironmentId' && typeof child === 'string') {
      const ref = modelHandleRef(catalog, 'workEnvironment', child);
      if (ref) output.workEnvironmentRef = ref;
      continue;
    }
    if ((key === 'nextOutputHandle' || key === 'outputHandle') && typeof child === 'string') {
      const cursor = modelHandleRef(catalog, 'cursor', child);
      if (cursor) output[key === 'nextOutputHandle' ? 'nextCursor' : 'cursor'] = cursor;
      continue;
    }
    output[key] = projectKnownValue(child, catalog);
  }
  return output;
}

function projectKnownText(value: string, catalog: ModelHandleCatalog): string {
  let text = value;
  for (const entry of catalog.entries) text = text.split(entry.target).join(entry.ref);
  return text;
}

function collectCandidates(
  value: unknown,
  output: ModelHandleCandidate[],
  seen: Set<object>
): void {
  if (typeof value === 'string') {
    collectNestedJson(value, output, seen);
    for (const match of value.matchAll(WORK_ENVIRONMENT_PATTERN)) {
      pushCandidate(output, { kind: 'workEnvironment', target: match[0] });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const entry of value) collectCandidates(entry, output, seen);
    return;
  }
  const record = asRecord(value);
  if (!record || seen.has(record)) return;
  seen.add(record);

  const attachmentId = optionalText(record.attachmentId);
  const attachmentName = optionalText(record.name);
  const attachmentMimeType = optionalText(record.mimeType);
  const attachmentSizeBytes = optionalNonNegativeInteger(record.sizeBytes);
  if (attachmentId) {
    pushCandidate(output, {
      kind: 'attachment',
      target: attachmentId,
      ...(attachmentName ? { name: attachmentName } : {}),
      ...(attachmentMimeType ? { mimeType: attachmentMimeType } : {}),
      ...(attachmentSizeBytes !== undefined ? { sizeBytes: attachmentSizeBytes } : {})
    });
  }
  pushTextCandidate(output, 'process', record.processId);
  pushTextCandidate(output, 'child', record.answerBridgeId);
  if (Array.isArray(record.answerBridgeIds)) {
    for (const target of record.answerBridgeIds) pushTextCandidate(output, 'child', target);
  }
  pushTextCandidate(output, 'workEnvironment', record.workEnvironmentId);
  for (const key of ['nextOutputHandle', 'outputHandle']) {
    const handle = optionalText(record[key]);
    if (handle?.startsWith('rk-process-output:')) pushCandidate(output, { kind: 'cursor', target: handle });
  }
  for (const key of ['fromEnvironment', 'toEnvironment']) {
    const environment = optionalText(record[key]);
    if (environment?.startsWith('work-env-')) {
      pushCandidate(output, { kind: 'workEnvironment', target: environment });
    }
  }
  for (const child of Object.values(record)) collectCandidates(child, output, seen);
}

function collectNestedJson(value: string, output: ModelHandleCandidate[], seen: Set<object>): void {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NESTED_JSON_CHARS) return;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
  try {
    collectCandidates(JSON.parse(trimmed) as unknown, output, seen);
  } catch {
    // Ordinary text is not part of the handle catalog.
  }
}

function pushTextCandidate(
  output: ModelHandleCandidate[],
  kind: ModelHandleKind,
  value: unknown
): void {
  const target = optionalText(value);
  if (target) pushCandidate(output, { kind, target });
}

function pushCandidate(output: ModelHandleCandidate[], candidate: ModelHandleCandidate): void {
  if (!candidate.target.trim()) return;
  output.push(candidate);
}

function mergeMetadata(target: ModelHandleEntry, candidate: ModelHandleCandidate): void {
  if (!target.name && candidate.name) target.name = candidate.name;
  if (!target.mimeType && candidate.mimeType) target.mimeType = candidate.mimeType;
  if (target.sizeBytes === undefined && candidate.sizeBytes !== undefined) target.sizeBytes = candidate.sizeBytes;
}

function replaceRef(
  record: Record<string, unknown>,
  refKey: string,
  targetKey: string,
  kind: ModelHandleKind,
  catalog: ModelHandleCatalog
): void {
  const ref = optionalText(record[refKey]);
  if (!ref) return;
  const target = modelHandleTarget(catalog, kind, ref);
  if (!target) throw new UnknownModelHandleReferenceError(kind, ref);
  delete record[refKey];
  record[targetKey] = target;
}

function replaceEnvironmentValue(
  record: Record<string, unknown>,
  key: 'fromEnvironment' | 'toEnvironment',
  catalog: ModelHandleCatalog
): void {
  const ref = optionalText(record[key]);
  if (!ref || ref === 'current' || !/^W[1-9]\d*$/.test(ref)) return;
  const target = modelHandleTarget(catalog, 'workEnvironment', ref);
  if (!target) throw new UnknownModelHandleReferenceError('workEnvironment', ref);
  record[key] = target;
}

function handleKindLabel(kind: ModelHandleKind): string {
  switch (kind) {
    case 'attachment': return '附件';
    case 'process': return '进程';
    case 'cursor': return '输出游标';
    case 'child': return '子 Agent';
    case 'workEnvironment': return '工作环境';
  }
}

function targetKey(kind: ModelHandleKind, target: string): string {
  return `${kind}\u0000${target}`;
}

function requireKind(value: unknown, label: string): ModelHandleKind {
  if (value === 'attachment' || value === 'process' || value === 'cursor'
    || value === 'child' || value === 'workEnvironment') return value;
  throw new TypeError(`${label} is invalid.`);
}

function requireText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new TypeError(`${label} must be non-empty text.`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cloneValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
