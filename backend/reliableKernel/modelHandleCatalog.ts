import { SWITCH_WORK_ENVIRONMENT_TOOL_NAME, TRANSFER_TOOL_NAME } from '../../shared/protocol';
import { isCrossConversationTool } from '../world/modules/tools/definitions/crossConversation';
import { createModelHandleTextProjection } from './modelHandleTextProjection';
import { commandToolMode } from '../../shared/commandToolArguments';
import { isEmptyToolArgument, ToolArgumentError } from '../../shared/toolArgumentUtils';
import { compactReadFileToolArguments } from '../world/modules/tools/definitions/readFile';
import { selectCollaborationToolArguments } from './collaborationToolDispatcher';

export type ModelHandleKind = 'attachment' | 'process' | 'cursor' | 'child' | 'workEnvironment'
  | 'conversation' | 'collaborationMessage' | 'conversationMessage' | 'boardChannel' | 'boardThread' | 'boardPost';

/**
 * A model tool argument that cannot be turned into a canonical internal target. The message is
 * shown to the model: it names the argument, the accepted form and, when the model used an internal
 * key, the key to use instead. It echoes a rejected value only when that value is itself a short
 * reference; a rejected canonical ID would otherwise be projected into its authorized short ref and
 * read as if that valid reference had been refused.
 */
export class UnknownModelHandleReferenceError extends Error {
  public readonly code = 'UNKNOWN_MODEL_HANDLE_REFERENCE';

  public constructor(
    public readonly kind: ModelHandleKind,
    public readonly argument: string,
    message: string
  ) {
    super(message);
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
  /** Reserved ordinals without an active target binding; private scopes never contribute aliases. */
  allocationHighWater?: Partial<Record<ModelHandleKind, number>>;
  /** One current identity contract; unmarked published recipes remain immutable historical facts. */
  identityContractRevision?: string;
  /** Ambiguous published Context addresses are never assigned or resolved again. */
  retiredRefs?: string[];
}

/** Read-only catalog data accepted by projection helpers; persisted catalogs keep their plain shape. */
export interface ReadonlyModelHandleCatalog {
  readonly entries: readonly Readonly<ModelHandleEntry>[];
  readonly allocationHighWater?: Readonly<Partial<Record<ModelHandleKind, number>>>;
  readonly identityContractRevision?: string;
  readonly retiredRefs?: readonly string[];
}

declare const preparedModelHandleCatalog: unique symbol;
export interface PreparedModelHandleCatalog extends ReadonlyModelHandleCatalog {
  readonly [preparedModelHandleCatalog]: true;
}

interface ModelHandleLookup {
  readonly byTarget: ReadonlyMap<string, Readonly<ModelHandleEntry>>;
  readonly byRef: ReadonlyMap<string, Readonly<ModelHandleEntry>>;
  readonly retiredRefs: ReadonlySet<string>;
  projectText?: (value: string) => string;
}

// Only privately created, deeply frozen snapshots are keys. Never cache arbitrary caller objects:
// callers may mutate a catalog between operations, and every new snapshot must validate that data.
const preparedModelHandleLookups = new WeakMap<object, ModelHandleLookup>();

/** Validate/copy once at an operation boundary, then share this immutable lookup during projection. */
export function prepareModelHandleCatalog(value: unknown): PreparedModelHandleCatalog {
  if (typeof value === 'object' && value !== null && preparedModelHandleLookups.has(value)) {
    return value as PreparedModelHandleCatalog;
  }
  const catalog = normalizeModelHandleCatalog(value);
  const byTarget = new Map<string, Readonly<ModelHandleEntry>>();
  const byRef = new Map<string, Readonly<ModelHandleEntry>>();
  for (const entry of catalog.entries) {
    Object.freeze(entry);
    byTarget.set(targetKey(entry.kind, entry.target), entry);
    byRef.set(entry.ref, entry);
  }
  Object.freeze(catalog.entries);
  if (catalog.retiredRefs) Object.freeze(catalog.retiredRefs);
  if (catalog.allocationHighWater) Object.freeze(catalog.allocationHighWater);
  // The opaque type has no wire marker; ownership is established only by the private map below.
  const prepared = Object.freeze(catalog) as unknown as PreparedModelHandleCatalog;
  preparedModelHandleLookups.set(prepared, { byTarget, byRef, retiredRefs: new Set(catalog.retiredRefs) });
  return prepared;
}

export const CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION = '2026-10-01';

/** Bounded diagnostics contain identities, never display metadata or historical message bodies. */
export interface ModelHandleIdentityConflict {
  kind: ModelHandleKind;
  referenceCount: number;
  targetCount: number;
  currentFactCount: number;
  legacyFactCount: number;
  facts: Array<{ ref: string; target: string; current: boolean }>;
  truncated: boolean;
}
export class ModelHandleIdentityConflictError extends Error {
  public readonly code = 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT';
  public constructor(message: string, public readonly conflict?: ModelHandleIdentityConflict) {
    super(message);
    this.name = 'ModelHandleIdentityConflictError';
  }
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

const compareModelHandleRefs = new Intl.Collator(undefined, { numeric: true }).compare;

const HANDLE_PATTERN = /^(?:F|P|O|A|W|C|M|R|H|T|B)[1-9]\d*$/;
const WORK_ENVIRONMENT_PATTERN = /\bwork-env-[a-zA-Z0-9._-]+\b/g;
const MAX_NESTED_JSON_CHARS = 16 * 1024 * 1024;

/**
 * Builds one small model-facing reference table from the exact values visible to a ModelRequest.
 * Canonical ids remain internal; only the short refs are rendered to the provider.
 */
export function buildModelHandleCatalog(
  values: readonly unknown[],
  seededEntries: readonly ModelHandleEntry[] | ReadonlyModelHandleCatalog = []
): ModelHandleCatalog {
  const candidates: ModelHandleCandidate[] = [];
  const seenObjects = new WeakSet<object>();
  for (const value of values) collectCandidates(value, candidates, seenObjects);
  const accumulator = createModelHandleCandidateAccumulator(seededEntries);
  for (const candidate of candidates) accumulator.add(candidate);
  return accumulator.finish();
}

/** Incremental discovery retains handle facts, never the parsed bodies used to discover them. */
export interface ModelHandleCatalogDelta {
  addedEntries: ModelHandleEntry[];
  metadataExtensions: ModelHandleEntry[];
}

export function createModelHandleCatalogBuilder(
  seededEntries: readonly ModelHandleEntry[] | ReadonlyModelHandleCatalog = []
): { add(value: unknown): void; finish(): ModelHandleCatalog; delta(): ModelHandleCatalogDelta } {
  const accumulator = createModelHandleCandidateAccumulator(seededEntries);
  const seen = new WeakSet<object>();
  return {
    add(value) {
      const candidates: ModelHandleCandidate[] = [];
      collectCandidates(value, candidates, seen);
      for (const candidate of candidates) accumulator.add(candidate);
    },
    finish: () => accumulator.finish(),
    delta: () => accumulator.delta()
  };
}

function createModelHandleCandidateAccumulator(
  seededEntries: readonly ModelHandleEntry[] | ReadonlyModelHandleCatalog
): { add(candidate: ModelHandleCandidate): void; finish(): ModelHandleCatalog; delta(): ModelHandleCatalogDelta } {
  const seedCatalog = normalizeModelHandleCatalog(Array.isArray(seededEntries)
    ? { entries: seededEntries } : seededEntries);
  const normalizedSeeds = seedCatalog.entries;
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
  for (const ref of seedCatalog.retiredRefs ?? []) {
    const kind = handleKindOfRef(ref)!;
    counters[kind] = Math.max(counters[kind], Number(ref.slice(1)));
  }
  const entries: ModelHandleEntry[] = [];
  for (const [kind, ordinal] of Object.entries(seedCatalog.allocationHighWater ?? {})) {
    counters[kind as ModelHandleKind] = Math.max(counters[kind as ModelHandleKind], ordinal);
  }
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
  const added = new Set<ModelHandleEntry>();
  const extended = new Set<ModelHandleEntry>();
  const add = (candidate: ModelHandleCandidate): void => {
    const key = targetKey(candidate.kind, candidate.target);
    const existing = byTarget.get(key);
    if (existing) {
      const changes = !existing.name && !!candidate.name || !existing.mimeType && !!candidate.mimeType
        || existing.sizeBytes === undefined && candidate.sizeBytes !== undefined;
      mergeMetadata(existing, candidate);
      if (changes && !added.has(existing)) extended.add(existing);
      return;
    }
    const ordinal = counters[candidate.kind] + 1;
    if (!Number.isSafeInteger(ordinal)) throw new RangeError(`Model handle ${HANDLE_PREFIX[candidate.kind]} has exhausted its safe ordinal range.`);
    counters[candidate.kind] = ordinal;
    const ref = `${HANDLE_PREFIX[candidate.kind]}${ordinal}`;
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
    added.add(entry);
  };
  return {
    add,
    finish: () => currentModelHandleCatalog(entries.map(entry => ({ ...entry })),
      seedCatalog.retiredRefs ?? [], seedCatalog.allocationHighWater),
    delta: () => ({ addedEntries: [...added].map(entry => ({ ...entry })),
      metadataExtensions: [...extended].map(entry => ({ ...entry })) })
  };
}

export function normalizeModelHandleCatalog(value: unknown): ModelHandleCatalog {
  if (value === undefined) return { entries: [] };
  const record = asRecord(value);
  if (!record) throw new TypeError('modelHandleCatalog must be an object when present.');
  if (preparedModelHandleLookups.has(record)) {
    const prepared = value as PreparedModelHandleCatalog;
    return {
      entries: prepared.entries.map(entry => ({ ...entry })),
      ...(prepared.allocationHighWater ? { allocationHighWater: { ...prepared.allocationHighWater } } : {}),
      ...(prepared.identityContractRevision === undefined ? {} : {
        identityContractRevision: prepared.identityContractRevision,
        retiredRefs: [...prepared.retiredRefs!]
      })
    };
  }
  const hasContract = 'identityContractRevision' in record;
  if (hasContract && record.identityContractRevision !== CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION) {
    throw new TypeError('modelHandleCatalog.identityContractRevision is not the current identity contract.');
  }
  if ('retiredRefs' in record && !hasContract) {
    throw new TypeError('modelHandleCatalog.retiredRefs requires the current identity contract.');
  }
  if (hasContract && (!Array.isArray(record.entries) || !Array.isArray(record.retiredRefs))) {
    throw new TypeError('Current modelHandleCatalog requires entries and retiredRefs arrays.');
  }
  if (!Array.isArray(record.entries)) throw new TypeError('modelHandleCatalog.entries must be an array.');
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
    requireSafeHandleOrdinal(ref);
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
  if (!hasContract) {
    if (record.allocationHighWater !== undefined) throw new TypeError('Allocation high-water reservations require the current identity contract.');
    return { entries };
  }
  const retired = new Set<string>();
  for (const candidate of record.retiredRefs as unknown[]) {
    const ref = requireText(candidate, 'modelHandleCatalog.retiredRefs entry');
    const kind = handleKindOfRef(ref);
    if (!kind || !isPersistentContextHandle(kind)) {
      throw new TypeError('Only persistent Context references may be retired; attachment references belong to their registry.');
    }
    requireSafeHandleOrdinal(ref);
    if (retired.has(ref)) throw new TypeError(`Duplicate retired model handle ref: ${ref}`);
    if (refs.has(ref)) throw modelHandleIdentityError(`Retired model handle reference ${ref} is still assigned.`);
    retired.add(ref);
  }
  return currentModelHandleCatalog(entries, [...retired], normalizeAllocationHighWater(record.allocationHighWater));
}

/** Strictly combines current identity facts; this never repairs or chooses among conflicting maps. */
export function mergeModelHandleCatalogs(...catalogs: readonly ModelHandleCatalog[]): ModelHandleCatalog {
  const normalized = catalogs.map(normalizeModelHandleCatalog);
  const retired = new Set(normalized.flatMap(catalog => catalog.retiredRefs ?? []));
  const byRef = new Map<string, ModelHandleEntry>();
  const byTarget = new Map<string, ModelHandleEntry>();
  for (const entry of normalized.flatMap(catalog => catalog.entries)) {
    if (retired.has(entry.ref)) throw modelHandleIdentityError(`Retired model handle reference ${entry.ref} is still assigned.`);
    const priorRef = byRef.get(entry.ref);
    const priorTarget = byTarget.get(targetKey(entry.kind, entry.target));
    if ((priorRef && (priorRef.kind !== entry.kind || priorRef.target !== entry.target))
      || (priorTarget && priorTarget.ref !== entry.ref)) {
      throw modelHandleIdentityError(`Conflicting frozen child reference ${entry.ref}.`);
    }
    const merged = priorRef ?? { ...entry };
    mergeMetadata(merged, entry);
    byRef.set(entry.ref, merged);
    byTarget.set(targetKey(entry.kind, entry.target), merged);
  }
  return currentModelHandleCatalog([...byRef.values()], [...retired], mergeAllocationHighWater(normalized));
}

/**
 * Published unmarked maps could lose reserved Context references when wall clocks moved backwards
 * or request windows changed. Retire each ambiguous identity component in full instead of choosing
 * a historical target. Current-contract facts and registry-owned attachment identities stay strict.
 */
export function reconcileHistoricalModelHandleCatalogs(catalogs: readonly ModelHandleCatalog[],
  options: {
    allocationHighWater?: Partial<Record<ModelHandleKind, number>>;
    /** Offline upgrade only: current-contract facts that collide among themselves are retired and reallocated. */
    allowCurrentPersistentReallocation?: boolean;
  } = {}): ModelHandleCatalog {
  const retired = new Set<string>();
  // A reserved ordinal can have no selected binding (private lookup entries, edited prose or a
  // fork's reservation scope). It must fence repair allocation, not just the returned catalog.
  const allocationHighWater = normalizeAllocationHighWater(options.allocationHighWater) ?? {};
  const counters = new Map<ModelHandleKind, number>(
    Object.entries(allocationHighWater) as Array<[ModelHandleKind, number]>);
  const uniqueFacts = new Map<string, { entry: ModelHandleEntry; current: boolean }>();
  const retiredTargets = new Map<string, ModelHandleEntry>();
  for (const input of catalogs) {
    const catalog = normalizeModelHandleCatalog(input);
    for (const [kind, ordinal] of Object.entries(catalog.allocationHighWater ?? {})) {
      const handleKind = kind as ModelHandleKind;
      allocationHighWater[handleKind] = Math.max(allocationHighWater[handleKind] ?? 0, ordinal);
      counters.set(handleKind, Math.max(counters.get(handleKind) ?? 0, ordinal));
    }
    const current = catalog.identityContractRevision === CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION;
    for (const ref of catalog.retiredRefs ?? []) {
      retired.add(ref);
      const kind = handleKindOfRef(ref)!;
      counters.set(kind, Math.max(counters.get(kind) ?? 0, Number(ref.slice(1))));
    }
    for (const entry of catalog.entries) {
      counters.set(entry.kind, Math.max(counters.get(entry.kind) ?? 0, Number(entry.ref.slice(1))));
      const identity = JSON.stringify([entry.kind, entry.ref, entry.target]);
      const prior = uniqueFacts.get(identity);
      if (!prior) {
        uniqueFacts.set(identity, { entry: { ...entry }, current });
      } else {
        const preferIncoming = current && !prior.current
          || current === prior.current && compareHandleText(JSON.stringify(entry), JSON.stringify(prior.entry)) < 0;
        if (preferIncoming) {
          const replacement = { ...entry };
          mergeMetadata(replacement, prior.entry);
          prior.entry = replacement;
        } else mergeMetadata(prior.entry, entry);
        prior.current ||= current;
      }
    }
  }
  const facts: Array<{ entry: ModelHandleEntry; current: boolean }> = [];
  for (const fact of uniqueFacts.values()) {
    if (!retired.has(fact.entry.ref)) {
      facts.push(fact);
      continue;
    }
    if (fact.current) throw modelHandleIdentityError(`Retired model handle reference ${fact.entry.ref} is still assigned.`);
    // A later historical import may reveal another target behind an already-retired address.
    // Its address stays unusable, but the canonical object must still receive a fresh address.
    const key = targetKey(fact.entry.kind, fact.entry.target);
    const target = retiredTargets.get(key);
    if (target) mergeMetadata(target, fact.entry);
    else retiredTargets.set(key, { ...fact.entry });
  }
  // Stable representatives also make metadata independent of repository enumeration order.
  facts.sort((left, right) => Number(right.current) - Number(left.current)
    || compareHandleText(JSON.stringify(left.entry), JSON.stringify(right.entry)));
  const byNode = new Map<string, number[]>();
  for (const [index, { entry }] of facts.entries()) {
    for (const node of [`ref:${entry.ref}`, `target:${targetKey(entry.kind, entry.target)}`]) {
      const members = byNode.get(node) ?? [];
      members.push(index);
      byNode.set(node, members);
    }
  }
  const visited = new Set<number>();
  const entries: ModelHandleEntry[] = [];
  const reallocate: ModelHandleEntry[] = [];
  for (let index = 0; index < facts.length; index += 1) {
    if (visited.has(index)) continue;
    const pending = [index];
    const component: typeof facts = [];
    const refs = new Set<string>();
    const targets = new Map<string, ModelHandleEntry>();
    const visitedNodes = new Set<string>();
    for (let position = 0; position < pending.length; position += 1) {
      const member = pending[position]!;
      if (visited.has(member)) continue;
      visited.add(member);
      const fact = facts[member]!;
      component.push(fact);
      refs.add(fact.entry.ref);
      const key = targetKey(fact.entry.kind, fact.entry.target);
      const target = targets.get(key);
      if (target) mergeMetadata(target, fact.entry);
      else targets.set(key, { ...fact.entry });
      for (const node of [`ref:${fact.entry.ref}`, `target:${key}`]) {
        if (visitedNodes.has(node)) continue;
        visitedNodes.add(node);
        for (const adjacent of byNode.get(node)!) pending.push(adjacent);
      }
    }
    if (refs.size === 1 && targets.size === 1) {
      entries.push([...targets.values()][0]!);
      continue;
    }
    // An offline upgrade may retire and reallocate current-contract facts that collide only among
    // themselves; a current fact against a legacy fact stays a real conflict to report.
    const reallocatesCurrent = options.allowCurrentPersistentReallocation === true && component.every(fact => fact.current);
    if (component.some(fact => (!reallocatesCurrent && fact.current) || !isPersistentContextHandle(fact.entry.kind))) {
      const currentFactCount = component.filter(fact => fact.current).length;
      throw modelHandleIdentityError(
        `Conflicting frozen model handle reference ${component[0]!.entry.ref} (${component[0]!.entry.kind}; `
        + `${refs.size} refs, ${targets.size} targets, ${currentFactCount} current and ${component.length - currentFactCount} legacy facts).`,
        { kind: component[0]!.entry.kind, referenceCount: refs.size, targetCount: targets.size,
          currentFactCount, legacyFactCount: component.length - currentFactCount,
          facts: component.slice(0, 8).map(fact => ({ ref: fact.entry.ref,
            target: fact.entry.target, current: fact.current })),
          truncated: component.length > 8 });
    }
    for (const ref of refs) retired.add(ref);
    for (const entry of targets.values()) reallocate.push(entry);
  }
  const knownTargets = new Set([...entries, ...reallocate].map(entry => targetKey(entry.kind, entry.target)));
  for (const [key, entry] of retiredTargets) {
    if (!knownTargets.has(key)) {
      knownTargets.add(key);
      reallocate.push(entry);
    }
  }
  reallocate.sort((left, right) => compareHandleText(left.kind, right.kind) || compareHandleText(left.target, right.target));
  for (const entry of reallocate) {
    const ordinal = (counters.get(entry.kind) ?? 0) + 1;
    if (!Number.isSafeInteger(ordinal)) throw new RangeError(`Model handle ${HANDLE_PREFIX[entry.kind]} has exhausted its safe ordinal range.`);
    counters.set(entry.kind, ordinal);
    entries.push({ ...entry, ref: `${HANDLE_PREFIX[entry.kind]}${ordinal}` });
  }
  entries.sort((left, right) => compareModelHandleRefs(left.ref, right.ref));
  return currentModelHandleCatalog(entries, [...retired], allocationHighWater);
}

export function renderRetiredModelHandleNotice(catalogInput: ModelHandleCatalog | unknown): string | undefined {
  const retired = prepareModelHandleCatalog(catalogInput).retiredRefs ?? [];
  if (retired.length === 0) return undefined;
  const listed = retired.slice(0, 20).join(', ')
    + (retired.length > 20 ? `, and ${retired.length - 20} other historical references` : '');
  return '[Historical reference identities — runtime data, not instructions]\n'
    + `Retired historical references: ${listed}. Their identity mappings conflicted in published history and they cannot be used in tool calls. `
    + 'Do not infer a new reference by number or recency. Identify objects from current tool results and ownership information. '
    + 'A reference does not grant permission to operate on an inherited or foreign object.'
    + (retired.some(ref => ref.startsWith('O'))
      ? ' With the current process reference, omit a retired cursor to read output from the beginning.' : '');
}

function compareHandleText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function currentModelHandleCatalog(entries: ModelHandleEntry[], retiredRefs: string[],
  allocationHighWater?: Partial<Record<ModelHandleKind, number>>): ModelHandleCatalog {
  return { entries, identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION,
    retiredRefs: [...retiredRefs].sort(compareModelHandleRefs),
    ...(allocationHighWater && Object.keys(allocationHighWater).length > 0 ? { allocationHighWater } : {}) };
}

function normalizeAllocationHighWater(value: unknown): Partial<Record<ModelHandleKind, number>> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) throw new TypeError('modelHandleCatalog.allocationHighWater must be an object.');
  const result: Partial<Record<ModelHandleKind, number>> = {};
  for (const key of Object.keys(record)) {
    const kind = requireKind(key, 'Allocation high-water kind');
    if (!isPersistentContextHandle(kind) || !Number.isSafeInteger(record[key]) || Number(record[key]) < 0) {
      throw new TypeError('Allocation high-water requires a nonnegative persistent-handle ordinal.');
    }
  }
  for (const kind of Object.keys(HANDLE_PREFIX) as ModelHandleKind[]) {
    if (typeof record[kind] === 'number' && record[kind] > 0) result[kind] = record[kind];
  }
  return result;
}

function mergeAllocationHighWater(catalogs: readonly ModelHandleCatalog[]): Partial<Record<ModelHandleKind, number>> {
  const result: Partial<Record<ModelHandleKind, number>> = {};
  for (const catalog of catalogs) for (const [kind, ordinal] of Object.entries(catalog.allocationHighWater ?? {})) {
    result[kind as ModelHandleKind] = Math.max(result[kind as ModelHandleKind] ?? 0, ordinal);
  }
  return normalizeAllocationHighWater(result)!;
}

function requireSafeHandleOrdinal(ref: string): void {
  const ordinal = Number(ref.slice(1));
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) throw new RangeError(`Model handle ${ref} is outside the safe ordinal range.`);
}

function modelHandleIdentityError(message: string, conflict?: ModelHandleIdentityConflict): ModelHandleIdentityConflictError {
  return new ModelHandleIdentityConflictError(message, conflict);
}

export function modelHandleRef(
  catalogInput: ModelHandleCatalog | unknown,
  kind: ModelHandleKind,
  target: unknown
): string | undefined {
  const normalizedTarget = optionalText(target);
  if (!normalizedTarget) return undefined;
  const catalog = prepareModelHandleCatalog(catalogInput);
  return preparedModelHandleLookups.get(catalog)!.byTarget.get(targetKey(kind, normalizedTarget))?.ref;
}

export function modelHandleTarget(
  catalogInput: ModelHandleCatalog | unknown,
  kind: ModelHandleKind,
  ref: unknown
): string | undefined {
  const normalizedRef = optionalText(ref);
  if (!normalizedRef) return undefined;
  const catalog = prepareModelHandleCatalog(catalogInput);
  const entry = preparedModelHandleLookups.get(catalog)!.byRef.get(normalizedRef);
  return entry?.kind === kind ? entry.target : undefined;
}

export function modelHandleEntries(
  catalogInput: ModelHandleCatalog | unknown,
  kind?: ModelHandleKind
): ModelHandleEntry[] {
  const entries = prepareModelHandleCatalog(catalogInput).entries;
  return entries.filter((entry) => kind === undefined || entry.kind === kind).map(entry => ({ ...entry }));
}

/** Removes durable result-envelope ids and replaces actionable canonical values with short refs. */
export function projectToolResultForModel(
  toolName: string,
  value: unknown,
  catalogInput: ModelHandleCatalog | unknown
): unknown {
  const catalog = prepareModelHandleCatalog(catalogInput);
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
  const catalog = prepareModelHandleCatalog(catalogInput);
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
  if (toolName === 'run_agent' || toolName === 'read_agent_answer') {
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
  const catalog = prepareModelHandleCatalog(catalogInput);
  const args = cloneValue(argumentsInput);
  const record = asRecord(args);
  if (!record) return args;
  dropEmptyReferenceArguments(record, modelReferenceKeys(toolName, record));
  // Optional opaque paging strings, like optional references, may be filled with an empty
  // string by strict-schema relays. Only declared cursor fields are absent in that case;
  // nonempty malformed values and all other tools still reach their normal validation.
  const cursorKeys = toolName === 'list_agents' || toolName === 'list_conversations' ? ['cursor']
    : toolName === 'read_agent_messages' || toolName === 'read_conversation' ? ['cursor', 'inputCursor'] : [];
  for (const key of cursorKeys) if (record[key] === null || typeof record[key] === 'string' && record[key].trim() === '') delete record[key];

  if (isCollaborationHandleTool(toolName)) {
    resolveCollaborationArguments(toolName, record, catalog);
  } else if (toolName === 'read') {
    // Unused references must not reject an otherwise executable selected path.
    if (compactReadFileToolArguments(record).path === undefined) {
      replaceRef(toolName, record, 'attachmentRef', 'attachmentId', 'attachment', catalog);
    }
  } else if (toolName === 'bash' || toolName === 'shell') {
    resolveCommandArguments(toolName, record, catalog);
  } else if (toolName === 'run_agent' || toolName === 'read_agent_answer') {
    const operation = typeof record.operation === 'string' ? record.operation.trim() : '';
    const ignoresChild = toolName === 'run_agent' && (operation === 'spawn' || operation === 'list');
    if (!ignoresChild) replaceRef(toolName, record, 'childRef', 'answerBridgeId', 'child', catalog);
    const usesChildList = toolName === 'run_agent' && !['spawn', 'send', 'list', 'read', 'interrupt_subtree'].includes(operation)
      && !('answerBridgeId' in record);
    if (usesChildList && 'answerBridgeIds' in record) throw canonicalArgumentError(toolName, 'answerBridgeIds', 'childRefs', 'child', true);
    if (usesChildList && 'childRefs' in record) {
      if (!Array.isArray(record.childRefs) || record.childRefs.length === 0 || record.childRefs.length > 32) {
        throw new UnknownModelHandleReferenceError('child', 'childRefs',
          `childRefs 必须是包含 1 到 32 个${shortRefForm('child')}的数组。`);
      }
      const targets = record.childRefs.map((value, index) =>
        requireRefTarget(catalog, 'child', `childRefs[${index}]`, value));
      delete record.childRefs;
      record.answerBridgeIds = targets;
    }
  } else if (toolName === SWITCH_WORK_ENVIRONMENT_TOOL_NAME) {
    replaceRef(toolName, record, 'workEnvironmentRef', 'workEnvironmentId', 'workEnvironment', catalog);
  } else if (toolName === TRANSFER_TOOL_NAME && Array.isArray(record.transfers)) {
    record.transfers.forEach((transferValue, index) => {
      const transfer = asRecord(transferValue);
      if (!transfer) return;
      for (const key of ['fromEnvironment', 'toEnvironment'] as const) {
        resolveTransferEnvironment(transfer, key, `transfers[${index}].${key}`, catalog);
      }
    });
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

function projectKnownValue(value: unknown, catalog: PreparedModelHandleCatalog): unknown {
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
        if (!ref) throw unmappedResultError('child', key);
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

function projectKnownText(value: string, catalog: PreparedModelHandleCatalog): string {
  if (!value.length || !catalog.entries.length) return value;
  const lookup = preparedModelHandleLookups.get(catalog)!;
  lookup.projectText ??= createModelHandleTextProjection(catalog.entries);
  return lookup.projectText(value);
}

function collectCandidates(
  value: unknown,
  output: ModelHandleCandidate[],
  seen: WeakSet<object>,
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

function collectNestedJson(value: string, output: ModelHandleCandidate[], seen: WeakSet<object>, collaborationScope: boolean): void {
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
  toolName: string,
  record: Record<string, unknown>,
  refKey: string,
  targetKey: string,
  kind: ModelHandleKind,
  catalog: PreparedModelHandleCatalog
): void {
  if (isEmptyToolArgument(record[targetKey]) || typeof record[targetKey] === 'string' && !(record[targetKey] as string).trim()) delete record[targetKey];
  if (targetKey in record) throw canonicalArgumentError(toolName, targetKey, refKey, kind);
  if (!(refKey in record)) return;
  const target = requireRefTarget(catalog, kind, refKey, record[refKey], toolName);
  delete record[refKey];
  record[targetKey] = target;
}

/**
 * transfer advertises exactly two environment forms: a W# from its environment list and `current`.
 * Environment names, `active` and canonical work-env IDs are rejected here instead of being matched
 * later by the capability, so the model's contract and the executed target cannot diverge.
 */
function resolveTransferEnvironment(
  record: Record<string, unknown>,
  key: 'fromEnvironment' | 'toEnvironment',
  argument: string,
  catalog: PreparedModelHandleCatalog
): void {
  if (optionalText(record[key]) === 'current') {
    record[key] = 'current';
    return;
  }
  record[key] = requireRefTarget(catalog, 'workEnvironment', argument, record[key], TRANSFER_TOOL_NAME,
    `工具说明列出的${shortRefForm('workEnvironment')}，或表示当前工作环境的 current`);
}

/** Resolves one short reference of the expected kind or explains precisely why the value is not one. */
function requireRefTarget(
  catalog: PreparedModelHandleCatalog,
  kind: ModelHandleKind,
  argument: string,
  value: unknown,
  toolName?: string,
  accepted = `上下文或工具结果中出现过的${shortRefForm(kind)}`
): string {
  const ref = optionalText(value);
  if (ref && handleKindOfRef(ref) === kind && preparedModelHandleLookups.get(catalog)!.retiredRefs.has(ref)) {
    return rejectArgument(kind, argument,
      `${argument}=${ref} 是已失效的历史${kindNoun(kind, '引用')}；历史编号的对应关系不唯一，不能根据编号或时间猜测新引用。请依据当前工具结果或工作环境说明确认对象后，使用它的新引用。`);
  }
  const target = ref ? modelHandleTarget(catalog, kind, ref) : undefined;
  if (target) return target;
  const refKind = ref ? handleKindOfRef(ref) : undefined;
  let message: string;
  if (value === undefined) {
    message = `缺少 ${argument}；请提供${accepted}。`;
  } else if (refKind === kind) {
    message = `${argument}=${ref} 不是当前可用的${kindNoun(kind, '引用')}；请使用${accepted}。`;
  } else if (refKind) {
    message = `${argument} 收到的 ${ref} 是${kindNoun(refKind, '引用')}；请使用${accepted}。`;
    if (toolName === 'read_agent_messages' && kind === 'collaborationMessage' && refKind === 'conversationMessage') {
      message += '读取对话历史消息（R#）时请同时传 view=conversation。';
    }
  } else {
    message = `${argument} 只接受${accepted}；不接受内部 ID、名称或其它形式的值。`;
  }
  return rejectArgument(kind, argument, message);
}

function canonicalArgumentError(
  toolName: string,
  canonicalKey: string,
  refKey: string,
  kind: ModelHandleKind,
  list = false
): UnknownModelHandleReferenceError {
  const form = list ? `由${shortRefForm(kind)}组成的数组` : shortRefForm(kind);
  return new UnknownModelHandleReferenceError(kind, canonicalKey,
    `${toolName} 不接受参数 ${canonicalKey}；请改用 ${refKey} 传入${form}。`);
}

function unmappedResultError(kind: ModelHandleKind, field: string): UnknownModelHandleReferenceError {
  return new UnknownModelHandleReferenceError(kind, field,
    `工具结果字段 ${field} 中的${handleKindLabel(kind)}不在当前上下文的引用表中。`);
}

function rejectArgument(kind: ModelHandleKind, argument: string, message: string): never {
  throw new UnknownModelHandleReferenceError(kind, argument, message);
}

function shortRefForm(kind: ModelHandleKind): string {
  return `${kindNoun(kind, '短引用')}（${HANDLE_PREFIX[kind]}#）`;
}

export function handleKindOfRef(value: string): ModelHandleKind | undefined {
  if (!HANDLE_PATTERN.test(value)) return undefined;
  return (Object.keys(HANDLE_PREFIX) as ModelHandleKind[]).find((kind) => HANDLE_PREFIX[kind] === value[0]);
}

/**
 * shell/bash execute a new command by default; processRef and cursor only observe a background
 * process. Mode misuse is reported as such, so a valid P#/O# is never described as unknown.
 */
function resolveCommandArguments(toolName: string, record: Record<string, unknown>, catalog: PreparedModelHandleCatalog): void {
  let mode: ReturnType<typeof commandToolMode>;
  try {
    // Resolve the selector first; the checks below explain process/cursor misuse with its ref.
    mode = commandToolMode({ mode: record.mode });
  } catch (error) {
    if (!(error instanceof ToolArgumentError)) throw error;
    rejectArgument('process', 'mode', error.message);
  }
  const hasExplicitMode = typeof record.mode === 'string' && record.mode.trim() !== '';
  if ((mode !== 'execute' || !hasExplicitMode) && 'processId' in record) throw canonicalArgumentError(toolName, 'processId', 'processRef', 'process');
  if ((mode === 'output' || !hasExplicitMode) && 'outputHandle' in record) throw canonicalArgumentError(toolName, 'outputHandle', 'cursor', 'cursor');
  const executeText = record.mode === undefined
    ? '未传 mode 时按 mode=execute 执行新命令'
    : record.mode === 'execute' ? 'mode=execute 用于执行新命令' : 'mode 只能是 execute、output 或 kill';
  if (mode === 'execute' && !hasExplicitMode && 'processRef' in record) {
    const ref = optionalText(record.processRef);
    const known = ref && modelHandleTarget(catalog, 'process', ref) ? ref : undefined;
    rejectArgument('process', 'processRef',
      `processRef 只用于 mode=output（读取后台进程输出）或 mode=kill（终止后台进程），${executeText}。`
      + (known ? `要读取或终止 ${known}，请同时传 mode=output 或 mode=kill。` : '执行新命令时不要传 processRef。'));
  }
  if (mode === 'execute' && !hasExplicitMode && 'cursor' in record) {
    rejectArgument('cursor', 'cursor',
      `cursor 只用于 mode=output 的分页读取；${executeText}。`);
  }
  if (mode !== 'execute' && !('processRef' in record)) {
    rejectArgument('process', 'processRef',
      `mode=${mode} 需要 processRef：请传之前 ${toolName} 结果或后台完成通知中给出的${shortRefForm('process')}。`);
  }
  if (mode !== 'execute') replaceRef(toolName, record, 'processRef', 'processId', 'process', catalog);
  if (mode === 'output') replaceRef(toolName, record, 'cursor', 'outputHandle', 'cursor', catalog);
}

/** Joins a kind label and a following noun, keeping a space after a Latin word such as "Agent". */
function kindNoun(kind: ModelHandleKind, noun: string): string {
  const label = handleKindLabel(kind);
  return /[A-Za-z]$/.test(label) ? `${label} ${noun}` : `${label}${noun}`;
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
    case 'read_agent_answer': return ['childRef', 'childRefs'];
    case SWITCH_WORK_ENVIRONMENT_TOOL_NAME: return ['workEnvironmentRef'];
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

/** Every short address a summary can retain must keep its identity across later request windows.
 * Attachments have their own ConversationAttachmentHandleRegistry; all other refs live in recipes.
 * Persistence reserves an address only: the target control plane still checks authorization.
 */
export function isPersistentContextHandle(kind: ModelHandleKind): boolean {
  return isPersistentAgentHandle(kind) || kind === 'process' || kind === 'cursor' || kind === 'workEnvironment';
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

function projectCollaborationValue(value: unknown, catalog: PreparedModelHandleCatalog): unknown {
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
      if (!ref) throw unmappedResultError(field[2], key);
      output[field[1]] = ref;
    } else if (key === 'notifyConversationIds' && Array.isArray(child)) {
      output.notifyConversationRefs = child.map(target => {
        const ref = modelHandleRef(catalog, 'conversation', target);
        if (!ref) throw unmappedResultError('conversation', key);
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

function resolveCollaborationArguments(toolName: string, record: Record<string, unknown>, catalog: PreparedModelHandleCatalog): void {
  const selected = toolName === 'agent_board' ? record : selectCollaborationToolArguments(toolName, record).arguments;
  const fields = collaborationArgumentFields(toolName, selected);
  // Provider contracts accept only frozen short references. Canonical IDs cannot bypass the map.
  for (const [refKey, targetKey, kind] of fields) {
    if (refKey in selected || targetKey in selected) replaceRef(toolName, record, refKey, targetKey, kind, catalog);
  }
  if (toolName === 'agent_board') {
    if ('notifyConversationIds' in record) {
      throw canonicalArgumentError(toolName, 'notifyConversationIds', 'notifyConversationRefs', 'conversation', true);
    }
    if ('notifyConversationRefs' in record) {
      const refs = record.notifyConversationRefs;
      if (!Array.isArray(refs) || refs.length > 256) {
        rejectArgument('conversation', 'notifyConversationRefs',
          `notifyConversationRefs 必须是最多包含 256 个${shortRefForm('conversation')}的数组。`);
      }
      record.notifyConversationIds = refs.map((ref, index) =>
        requireRefTarget(catalog, 'conversation', `notifyConversationRefs[${index}]`, ref, toolName));
      delete record.notifyConversationRefs;
    }
  }
}
