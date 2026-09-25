import { isCrossConversationTool } from '../world/modules/tools/definitions/crossConversation';

export type ModelHandleKind = 'attachment' | 'process' | 'cursor' | 'child' | 'workEnvironment'
  | 'conversation' | 'collaborationMessage' | 'conversationMessage' | 'boardChannel' | 'boardThread' | 'boardPost';

export class UnknownModelHandleReferenceError extends Error {
  public readonly code = 'UNKNOWN_MODEL_HANDLE_REFERENCE';

  public constructor(
    public readonly kind: ModelHandleKind,
    public readonly ref: string,
    detail?: string
  ) {
    super(`未知${handleKindLabel(kind)}引用：${detail ?? (HANDLE_PATTERN.test(ref) ? ref : '(invalid model reference)')}`);
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
  workEnvironment: 'W',
  conversation: 'C',
  collaborationMessage: 'M',
  conversationMessage: 'R',
  boardChannel: 'H',
  boardThread: 'T',
  boardPost: 'B'
};

const HANDLE_PATTERN = /^(?:F|P|O|A|W|C|M|R|H|T|B)[1-9]\d*$/;
const HANDLE_TOKEN_PATTERN = /\b(?:F|P|O|A|W|C|M|R|H|T|B)[1-9]\d*\b/g;
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
    workEnvironment: 0,
    conversation: 0,
    collaborationMessage: 0,
    conversationMessage: 0,
    boardChannel: 0,
    boardThread: 0,
    boardPost: 0
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
  const projected = projectKnownValue(isCollaborationHandleTool(toolName)
    ? projectCollaborationValue(value, catalog) : value, catalog);
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
  dropEmptyReferenceArguments(record, modelReferenceKeys(toolName, record));

  if (isCollaborationHandleTool(toolName)) {
    resolveCollaborationArguments(toolName, record, catalog);
  } else if (toolName === 'read') {
    replaceRef(record, 'attachmentRef', 'attachmentId', 'attachment', catalog);
  } else if (toolName === 'bash' || toolName === 'shell') {
    if ('processId' in record) throw new UnknownModelHandleReferenceError('process', '(canonical id is not a model reference)');
    if ('outputHandle' in record) throw new UnknownModelHandleReferenceError('cursor', '(canonical output handle is not a model reference)');
    const mode = record.mode === 'output' || record.mode === 'kill' ? record.mode : 'execute';
    if (mode === 'execute' && 'processRef' in record) {
      throw new UnknownModelHandleReferenceError('process', '(processRef only belongs to output/kill)',
        'processRef 仅用于 mode=output/kill，执行新命令请勿提供进程引用');
    }
    if (mode !== 'output' && 'cursor' in record) {
      throw new UnknownModelHandleReferenceError('process', '(cursor only belongs to output)',
        'cursor 仅用于 mode=output 的分页读取');
    }
    if (mode !== 'execute' && !('processRef' in record)) {
      throw new UnknownModelHandleReferenceError('process', '(mode=output/kill requires processRef)',
        'mode=output/kill 必须提供当前目录授权的 processRef');
    }
    replaceRef(record, 'processRef', 'processId', 'process', catalog);
    replaceRef(record, 'cursor', 'outputHandle', 'cursor', catalog);
  } else if (toolName === 'run_agent' || toolName === 'read_agent_answer' || toolName === 'submit_agent_answer') {
    if ('childRef' in record) {
      const ref = optionalText(record.childRef);
      const target = ref ? modelHandleTarget(catalog, 'child', ref) : undefined;
      if (!target) throw new UnknownModelHandleReferenceError('child', ref ?? '(invalid childRef)');
    }
    replaceRef(record, 'childRef', 'answerBridgeId', 'child', catalog);
    if ('answerBridgeIds' in record) {
      throw new UnknownModelHandleReferenceError('child', '(canonical ids are not model references)');
    }
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
  // A tool result can claim any code, including the kernel's invalid-model-reference code. Never
  // exempt its "error" text from projection. Instead, avoid replacing only *part* of an already
  // written short reference: target "999" must not turn a rejected P999 into an apparent PC1.
  const references = Array.from(value.matchAll(HANDLE_TOKEN_PATTERN), (match) => ({
    start: match.index,
    end: match.index + match[0].length
  }));
  let projected = '';
  let offset = 0;
  // Keep each next match in the original text; rescanning a large result for every replacement
  // would make a result with many IDs quadratic in its text length.
  const nextIndexes = catalog.entries.map((entry) => value.indexOf(entry.target));
  while (offset < value.length) {
    let nextIndex = value.length;
    let nextEntry: ModelHandleEntry | undefined;
    for (let candidate = 0; candidate < catalog.entries.length; candidate += 1) {
      const entry = catalog.entries[candidate];
      let index = nextIndexes[candidate];
      if (index >= 0 && index < offset) index = value.indexOf(entry.target, offset);
      while (index >= 0 && overlapsPartOfHandleToken(index, index + entry.target.length, references)) {
        index = value.indexOf(entry.target, index + 1);
      }
      nextIndexes[candidate] = index;
      if (index >= 0 && (index < nextIndex
        || (index === nextIndex && entry.target.length > (nextEntry?.target.length ?? 0)))) {
        nextIndex = index;
        nextEntry = entry;
      }
    }
    if (!nextEntry) break;
    projected += value.slice(offset, nextIndex) + nextEntry.ref;
    offset = nextIndex + nextEntry.target.length;
  }
  return projected + value.slice(offset);
}

function overlapsPartOfHandleToken(
  start: number,
  end: number,
  references: readonly { start: number; end: number }[]
): boolean {
  let low = 0;
  let high = references.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (references[middle].end <= start) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < references.length && references[index].start < end; index += 1) {
    if (start > references[index].start || end < references[index].end) return true;
  }
  return false;
}

function collectCandidates(
  value: unknown,
  output: ModelHandleCandidate[],
  seen: Set<object>,
  collaborationScope = false
): void {
  if (typeof value === 'string') {
    collectNestedJson(value, output, seen, collaborationScope);
    for (const match of value.matchAll(WORK_ENVIRONMENT_PATTERN)) {
      pushCandidate(output, { kind: 'workEnvironment', target: match[0] });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const entry of value) collectCandidates(entry, output, seen, collaborationScope);
    return;
  }
  const record = asRecord(value);
  if (!record || seen.has(record)) return;
  seen.add(record);
  const toolName = asRecord(record.toolCall)?.toolName;
  collaborationScope ||= record.kind === 'agent_collaboration' || record.kind === 'cross_conversation'
    || record.kind === 'collaboration_message'
    || (typeof toolName === 'string' && isCollaborationHandleTool(toolName));

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
  if (collaborationScope) {
    for (const [key, , kind] of COLLABORATION_HANDLE_FIELDS) pushTextCandidate(output, kind, record[key]);
    if (Array.isArray(record.notifyConversationIds)) {
      for (const target of record.notifyConversationIds) pushTextCandidate(output, 'conversation', target);
    }
  }
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
  for (const child of Object.values(record)) collectCandidates(child, output, seen, collaborationScope);
}

function collectNestedJson(value: string, output: ModelHandleCandidate[], seen: Set<object>, collaborationScope: boolean): void {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NESTED_JSON_CHARS) return;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
  try {
    collectCandidates(JSON.parse(trimmed) as unknown, output, seen, collaborationScope);
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
  if (targetKey in record) throw new UnknownModelHandleReferenceError(kind, '(canonical id is not a model reference)');
  if (!(refKey in record)) return;
  const ref = optionalText(record[refKey]);
  const target = ref ? modelHandleTarget(catalog, kind, ref) : undefined;
  if (!target) throw new UnknownModelHandleReferenceError(kind, ref ?? `(invalid ${refKey})`);
  delete record[refKey];
  record[targetKey] = target;
}

function replaceEnvironmentValue(
  record: Record<string, unknown>,
  key: 'fromEnvironment' | 'toEnvironment',
  catalog: ModelHandleCatalog
): void {
  const ref = optionalText(record[key]);
  if (ref === 'current') return;
  const target = ref ? modelHandleTarget(catalog, 'workEnvironment', ref) : undefined;
  if (!target) throw new UnknownModelHandleReferenceError('workEnvironment', ref ?? `(invalid ${key})`);
  record[key] = target;
}

function handleKindLabel(kind: ModelHandleKind): string {
  switch (kind) {
    case 'attachment': return '附件';
    case 'process': return '进程';
    case 'cursor': return '输出游标';
    case 'child': return '子 Agent';
    case 'workEnvironment': return '工作环境';
    case 'conversation': return '对话';
    case 'collaborationMessage': return '协作消息';
    case 'conversationMessage': return '对话历史消息';
    case 'boardChannel': return '留言频道';
    case 'boardThread': return '留言讨论';
    case 'boardPost': return '留言';
  }
}

function targetKey(kind: ModelHandleKind, target: string): string {
  return `${kind}\u0000${target}`;
}

function requireKind(value: unknown, label: string): ModelHandleKind {
  if (value === 'attachment' || value === 'process' || value === 'cursor'
    || value === 'child' || value === 'workEnvironment' || value === 'conversation'
    || value === 'collaborationMessage' || value === 'conversationMessage' || value === 'boardChannel' || value === 'boardThread'
    || value === 'boardPost') return value;
  throw new TypeError(`${label} is invalid.`);
}

function requireText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new TypeError(`${label} must be non-empty text.`);
  return text;
}

/**
 * Models under provider-side strict schema normalization (Responses without `strict:false`, or relays
 * that translate Chat Completions into Responses) must fill every optional field, so an unused
 * reference arrives as "" or [""]. An empty reference names nothing: treat it as omitted. Tools whose
 * reference is required still fail on the missing field, so this never selects a different target.
 * Only the handle keys a builtin tool's model contract defines are cleaned: an MCP tool's own `baseRef`
 * or `labelRefs` (and any other *Ref argument) are real values and reach the tool exactly as sent.
 */
function dropEmptyReferenceArguments(record: Record<string, unknown>, keys: readonly string[]): void {
  const empty = (value: unknown) => value === null || (typeof value === 'string' && value.trim() === '');
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (empty(value) || (Array.isArray(value) && value.every(empty))) delete record[key];
  }
}

/** Handle-reference argument keys of the builtin tools that resolveModelToolArguments maps; none for other tools. */
function modelReferenceKeys(toolName: string, record: Record<string, unknown>): readonly string[] {
  if (isCollaborationHandleTool(toolName)) {
    const keys = collaborationArgumentFields(toolName, record).map(([refKey]) => refKey);
    return toolName === 'agent_board' ? [...keys, 'notifyConversationRefs'] : keys;
  }
  switch (toolName) {
    case 'read': return ['attachmentRef'];
    case 'bash':
    case 'shell': return ['processRef', 'cursor'];
    case 'run_agent':
    case 'read_agent_answer':
    case 'submit_agent_answer': return ['childRef', 'childRefs'];
    case 'switch_work_environment': return ['workEnvironmentRef'];
    default: return [];
  }
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

/** Short addresses are retained across compression; authorization always belongs to control planes. */
export function isPersistentAgentHandle(kind: ModelHandleKind): boolean {
  return kind === 'child' || kind === 'conversation' || kind === 'collaborationMessage' || kind === 'conversationMessage'
    || kind === 'boardChannel' || kind === 'boardThread' || kind === 'boardPost';
}

export function isCollaborationHandleTool(toolName: string): boolean {
  return ['list_agents', 'send_agent_message', 'followup_agent_task', 'read_agent_messages',
    'wait_agent_messages', 'agent_board'].includes(toolName) || isCrossConversationTool(toolName);
}

const COLLABORATION_HANDLE_FIELDS: ReadonlyArray<readonly [string, string, ModelHandleKind]> = [
  ['conversationId', 'conversationRef', 'conversation'],
  ['sourceConversationId', 'sourceConversationRef', 'conversation'],
  ['authorConversationId', 'authorConversationRef', 'conversation'],
  ['targetConversationId', 'targetConversationRef', 'conversation'],
  ['rootConversationId', 'rootConversationRef', 'conversation'],
  ['parentConversationId', 'parentConversationRef', 'conversation'],
  ['messageId', 'messageRef', 'collaborationMessage'],
  ['afterMessageId', 'afterMessageRef', 'collaborationMessage'],
  ['beforeMessageId', 'beforeMessageRef', 'collaborationMessage'],
  ['olderMessageId', 'olderMessageRef', 'collaborationMessage'],
  ['conversationMessageId', 'messageRef', 'conversationMessage'],
  ['olderConversationMessageId', 'olderMessageRef', 'conversationMessage'],
  ['replyToMessageId', 'replyToMessageRef', 'collaborationMessage'],
  ['nextAfterMessageId', 'nextAfterMessageRef', 'collaborationMessage'],
  ['channelId', 'channelRef', 'boardChannel'],
  ['threadId', 'threadRef', 'boardThread'],
  ['postId', 'postRef', 'boardPost']
];

function projectCollaborationValue(value: unknown, catalog: ModelHandleCatalog): unknown {
  if (Array.isArray(value)) return value.map(item => projectCollaborationValue(item, catalog));
  const record = asRecord(value);
  if (!record) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    // Board UI records retain id alongside an explicitly typed identity; only the typed ref goes to models.
    if (key === 'id' && (child === record.channelId || child === record.postId)) continue;
    const field = COLLABORATION_HANDLE_FIELDS.find(([idKey]) => idKey === key);
    if (field && (child === null || child === undefined)) {
      output[field[1]] = child;
    } else if (field) {
      const ref = modelHandleRef(catalog, field[2], child);
      if (!ref) throw new UnknownModelHandleReferenceError(field[2], '(unmapped collaboration result)');
      output[field[1]] = ref;
    } else if (key === 'notifyConversationIds' && Array.isArray(child)) {
      output.notifyConversationRefs = child.map(target => {
        const ref = modelHandleRef(catalog, 'conversation', target);
        if (!ref) throw new UnknownModelHandleReferenceError('conversation', '(unmapped notification target)');
        return ref;
      });
    } else output[key] = projectCollaborationValue(child, catalog);
  }
  return output;
}

function collaborationArgumentFields(
  toolName: string,
  record: Record<string, unknown>
): ReadonlyArray<readonly [string, string, ModelHandleKind]> {
  return toolName === 'agent_board'
    ? [['channelRef', 'channelId', 'boardChannel'], ['threadRef', 'threadId', 'boardThread'], ['postRef', 'postId', 'boardPost']]
    : isCrossConversationTool(toolName)
    // Cross-conversation tools address a whole Conversation, its transcript page or a reply.
    ? [['conversationRef', 'targetConversationId', 'conversation'], ['beforeMessageRef', 'beforeMessageId', 'conversationMessage'],
      ['messageRef', 'messageId', 'conversationMessage'], ['replyToMessageRef', 'replyToMessageId', 'collaborationMessage']]
    : [['conversationRef', 'targetConversationId', 'conversation'], ['messageRef', 'messageId', record.view === 'conversation' ? 'conversationMessage' : 'collaborationMessage'],
      ['afterMessageRef', 'afterMessageId', 'collaborationMessage'],
      ['beforeMessageRef', 'beforeMessageId', record.view === 'conversation' ? 'conversationMessage' : 'collaborationMessage'], ['replyToMessageRef', 'replyToMessageId', 'collaborationMessage']];
}

function resolveCollaborationArguments(toolName: string, record: Record<string, unknown>, catalog: ModelHandleCatalog): void {
  const fields = collaborationArgumentFields(toolName, record);
  for (const [refKey, targetKey, kind] of fields) {
    // Provider contracts accept only frozen short references. Canonical IDs cannot bypass the map.
    if (targetKey in record) throw new UnknownModelHandleReferenceError(kind, '(canonical id is not a model reference)');
    if (!(refKey in record)) continue;
    const ref = optionalText(record[refKey]);
    if (!ref || !modelHandleTarget(catalog, kind, ref)) {
      throw new UnknownModelHandleReferenceError(kind, ref ?? `(invalid ${refKey})`);
    }
    replaceRef(record, refKey, targetKey, kind, catalog);
  }
  if (toolName === 'agent_board') {
    if ('notifyConversationIds' in record) throw new UnknownModelHandleReferenceError('conversation', '(canonical notification targets)');
    if ('notifyConversationRefs' in record) {
      const refs = record.notifyConversationRefs;
      if (!Array.isArray(refs) || refs.length > 256) throw new UnknownModelHandleReferenceError('conversation', '(invalid notification targets)');
      record.notifyConversationIds = refs.map(ref => {
        const target = modelHandleTarget(catalog, 'conversation', ref);
        if (!target) throw new UnknownModelHandleReferenceError('conversation', typeof ref === 'string' ? ref : '(invalid reference)');
        return target;
      });
      delete record.notifyConversationRefs;
    }
  }
}
