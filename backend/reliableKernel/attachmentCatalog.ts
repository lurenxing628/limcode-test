import type {
  AttachmentCatalogEntry,
  MessageContent
} from '../../shared/protocol';

export const ATTACHMENT_CATALOG_HEADER = [
  '[LimCode 托管附件目录：仅包含不可变元数据，不包含附件正文。]',
  '仅在确实需要查看历史附件时调用 read，参数为 {"attachmentRef":"目录中的短编号"}。',
  'attachmentRef 只能使用下方目录里的 F1、F2 等真实短编号；不要留空、不要编造，也不要把文件名或 MIME 类型当作编号。'
].join('\n');

export const ATTACHMENT_PAGE_RANGE_GUIDANCE = [
  'TXT 或 PDF 可选 pages 范围，例如 {"attachmentRef":"F1","pages":"1-4"}。',
  'pages 省略时默认第 1 页，每次最多连续读取 4 页；如需继续，复制 read 结果中的 nextPages。图片不要填写 pages。'
].join('\n');

export interface AttachmentCatalogStoredItem {
  content: string;
  contentType?: string;
}

export type AttachmentCatalogPlacement =
  | {
      kind: 'attachment_catalog_delta';
      afterSegmentId: string;
      entries: AttachmentCatalogEntry[];
    }
  | {
      kind: 'attachment_catalog_checkpoint';
      afterSegmentId: string;
      entries: AttachmentCatalogEntry[];
    }
  | {
      kind: 'current_turn_delta';
      entries: AttachmentCatalogEntry[];
    };

/** Frozen model-only state. Catalog is the complete visible set; placements define exact delivery order. */
export interface AttachmentCatalogState {
  catalog: AttachmentCatalogEntry[];
  placements: AttachmentCatalogPlacement[];
}

export interface RenderedAttachmentCatalogState {
  catalog: AttachmentCatalogEntry[];
  afterSegment: ReadonlyMap<string, MessageContent>;
  currentTurn?: MessageContent;
}

/**
 * Collects immutable managed attachment references from durable JSON envelopes. Attachment bytes,
 * hashes and local paths are deliberately excluded from the resulting directory.
 */
export function collectAttachmentCatalog(value: unknown): AttachmentCatalogEntry[] {
  const entries: AttachmentCatalogEntry[] = [];
  collect(value, entries, new Set<object>());
  return mergeAttachmentCatalog(entries);
}

export function collectAttachmentCatalogFromStoredItems(
  items: readonly AttachmentCatalogStoredItem[]
): AttachmentCatalogEntry[] {
  return mergeAttachmentCatalog(...items.map((item) => {
    if (!isJsonContentType(item.contentType)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.content) as unknown;
    } catch {
      return [];
    }
    // Parsing failure means the item is not a JSON envelope. Once parsed, however, malformed
    // managed metadata and immutable metadata drift are authority violations and must fail closed.
    return collectAttachmentCatalog(parsed);
  }));
}

/** One reduction's normalized entries, retained in first-model-visible-appearance order. */
export class AttachmentCatalogAccumulator {
  private readonly byId = new Map<string, AttachmentCatalogEntry>();

  /** Returns the normalized id only when this candidate first enters the catalog. */
  public add(candidate: AttachmentCatalogEntry): string | undefined {
    const entry = normalizeEntry(candidate, 'attachmentCatalog entry');
    const existing = this.byId.get(entry.attachmentId);
    if (existing) {
      if (existing.name !== entry.name
        || existing.mimeType !== entry.mimeType
        || existing.sizeBytes !== entry.sizeBytes) {
        throw new Error(`Attachment catalog metadata changed for immutable attachment ${entry.attachmentId}.`);
      }
      return undefined;
    }
    this.byId.set(entry.attachmentId, entry);
    return entry.attachmentId;
  }

  public has(attachmentId: string): boolean {
    return this.byId.has(attachmentId);
  }

  /** Copies the prefix array; adding later entries never mutates an earlier snapshot. */
  public snapshot(): AttachmentCatalogEntry[] {
    return [...this.byId.values()];
  }
}

/** Merges catalogs in first-model-visible-appearance order and rejects immutable metadata drift. */
export function mergeAttachmentCatalog(
  ...catalogs: ReadonlyArray<readonly AttachmentCatalogEntry[]>
): AttachmentCatalogEntry[] {
  const accumulated = new AttachmentCatalogAccumulator();
  for (const catalog of catalogs) {
    for (const candidate of catalog) accumulated.add(candidate);
  }
  return accumulated.snapshot();
}

export function normalizeAttachmentCatalog(
  value: unknown,
  label = 'attachmentCatalog'
): AttachmentCatalogEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return mergeAttachmentCatalog(value.map((entry, index) => normalizeEntry(entry, `${label}[${index}]`)));
}

export function normalizeAttachmentCatalogState(
  value: unknown,
  label = 'attachmentCatalogState'
): AttachmentCatalogState {
  const record = asRecord(value);
  if (!record) throw new TypeError(`${label} must be an object.`);
  const catalog = normalizeAttachmentCatalog(record.catalog, `${label}.catalog`);
  if (!Array.isArray(record.placements)) throw new TypeError(`${label}.placements must be an array.`);
  const catalogById = new Map(catalog.map((entry) => [entry.attachmentId, entry]));
  const active = new Map<string, AttachmentCatalogEntry>();
  const firstAppearance: string[] = [];
  const segmentAnchors = new Set<string>();
  let currentTurnSeen = false;
  const placements = record.placements.map((value, index): AttachmentCatalogPlacement => {
    const placement = asRecord(value);
    if (!placement) throw new TypeError(`${label}.placements[${index}] must be an object.`);
    const kind = placement.kind;
    if (kind !== 'attachment_catalog_delta'
      && kind !== 'attachment_catalog_checkpoint'
      && kind !== 'current_turn_delta') {
      throw new TypeError(`${label}.placements[${index}].kind is unsupported.`);
    }
    if (currentTurnSeen) throw new Error(`${label}.current_turn_delta must be the final placement.`);
    const entries = normalizeAttachmentCatalog(
      placement.entries,
      `${label}.placements[${index}].entries`
    );
    if (entries.length === 0) throw new Error(`${label}.placements[${index}] must not be empty.`);
    for (const entry of entries) {
      const catalogEntry = catalogById.get(entry.attachmentId);
      if (!catalogEntry || !sameEntry(catalogEntry, entry)) {
        throw new Error(`${label}.placements[${index}] conflicts with catalog entry ${entry.attachmentId}.`);
      }
    }

    if (kind === 'attachment_catalog_checkpoint') {
      const checkpointIds = new Set(entries.map((entry) => entry.attachmentId));
      for (const attachmentId of active.keys()) {
        if (!checkpointIds.has(attachmentId)) {
          throw new Error(`${label}.placements[${index}] checkpoint drops active attachment ${attachmentId}.`);
        }
      }
      for (const entry of entries) {
        if (!active.has(entry.attachmentId)) firstAppearance.push(entry.attachmentId);
      }
      active.clear();
      for (const entry of entries) active.set(entry.attachmentId, entry);
    } else {
      for (const entry of entries) {
        if (active.has(entry.attachmentId)) {
          throw new Error(`${label}.placements[${index}] delta repeats active attachment ${entry.attachmentId}.`);
        }
        active.set(entry.attachmentId, entry);
        firstAppearance.push(entry.attachmentId);
      }
    }

    if (kind === 'current_turn_delta') {
      currentTurnSeen = true;
      return { kind, entries };
    }
    const afterSegmentId = requireText(
      placement.afterSegmentId,
      `${label}.placements[${index}].afterSegmentId`
    );
    if (segmentAnchors.has(afterSegmentId)) {
      throw new Error(`${label} has multiple placements after ContextSegment ${afterSegmentId}.`);
    }
    segmentAnchors.add(afterSegmentId);
    return { kind, afterSegmentId, entries };
  });

  if (active.size !== catalog.length
    || catalog.some((entry) => !active.has(entry.attachmentId))
    || firstAppearance.some((attachmentId, index) => catalog[index]?.attachmentId !== attachmentId)) {
    throw new Error(`${label} placements do not reconstruct the catalog in first-visible order.`);
  }
  return { catalog, placements };
}

/**
 * Renders and binds every frozen placement to an exact model-window anchor. Unknown or missing
 * anchors fail closed so a catalog can never silently drift to the request tail.
 */
export function renderAttachmentCatalogState(
  stateInput: AttachmentCatalogState | unknown,
  availableSegmentIds: readonly string[],
  referenceFor?: (entry: AttachmentCatalogEntry, index: number) => string | undefined,
  options: { allowCurrentTurnDelta?: boolean } = {}
): RenderedAttachmentCatalogState {
  const state = normalizeAttachmentCatalogState(stateInput);
  const available = new Set(availableSegmentIds.map((segmentId, index) =>
    requireText(segmentId, `availableSegmentIds[${index}]`)
  ));
  const afterSegment = new Map<string, MessageContent>();
  let currentTurn: MessageContent | undefined;
  for (const placement of state.placements) {
    const rendered = renderAttachmentCatalogPlacement(placement, referenceFor);
    if (placement.kind === 'current_turn_delta') {
      if (!options.allowCurrentTurnDelta) {
        throw new Error('Attachment catalog current_turn_delta has no current Turn input anchor.');
      }
      currentTurn = rendered;
      continue;
    }
    if (!available.has(placement.afterSegmentId)) {
      throw new Error(`Attachment catalog placement references unavailable ContextSegment ${placement.afterSegmentId}.`);
    }
    afterSegment.set(placement.afterSegmentId, rendered);
  }
  return {
    catalog: state.catalog,
    afterSegment,
    ...(currentTurn ? { currentTurn } : {})
  };
}

export function selectAttachmentCatalogStateSegments(
  stateInput: AttachmentCatalogState | unknown,
  segmentIds: readonly string[]
): AttachmentCatalogState {
  const state = normalizeAttachmentCatalogState(stateInput);
  const selectedIds = new Set(segmentIds.map((segmentId, index) =>
    requireText(segmentId, `segmentIds[${index}]`)
  ));
  const placements = state.placements.filter((placement) =>
    placement.kind !== 'current_turn_delta' && selectedIds.has(placement.afterSegmentId)
  );
  return normalizeAttachmentCatalogState({
    catalog: mergeAttachmentCatalog(...placements.map((placement) => placement.entries)),
    placements
  });
}

/** Rebases a tail state behind a new compression checkpoint for exact post-compression planning. */
export function rebaseAttachmentCatalogState(
  checkpointSegmentIdInput: string,
  checkpointCatalogInput: readonly AttachmentCatalogEntry[],
  tailStateInput: AttachmentCatalogState | unknown
): AttachmentCatalogState {
  const checkpointSegmentId = requireText(checkpointSegmentIdInput, 'checkpointSegmentId');
  const checkpointCatalog = mergeAttachmentCatalog(checkpointCatalogInput);
  const tailState = normalizeAttachmentCatalogState(tailStateInput, 'tailAttachmentCatalogState');
  const active = new Map(checkpointCatalog.map((entry) => [entry.attachmentId, entry]));
  const placements: AttachmentCatalogPlacement[] = checkpointCatalog.length > 0
    ? [{
        kind: 'attachment_catalog_checkpoint',
        afterSegmentId: checkpointSegmentId,
        entries: checkpointCatalog
      }]
    : [];
  for (const placement of tailState.placements) {
    if (placement.kind === 'attachment_catalog_checkpoint') {
      const entries = mergeAttachmentCatalog([...active.values()], placement.entries);
      active.clear();
      for (const entry of entries) active.set(entry.attachmentId, entry);
      placements.push({ ...placement, entries });
      continue;
    }
    const entries = placement.entries.filter((entry) => !active.has(entry.attachmentId));
    for (const entry of entries) active.set(entry.attachmentId, entry);
    if (entries.length > 0) placements.push({ ...placement, entries });
  }
  return normalizeAttachmentCatalogState({
    catalog: mergeAttachmentCatalog(checkpointCatalog, tailState.catalog),
    placements
  });
}

export function renderAttachmentCatalog(
  catalog: readonly AttachmentCatalogEntry[],
  referenceFor?: (entry: AttachmentCatalogEntry, index: number) => string | undefined
): MessageContent | undefined {
  const normalized = mergeAttachmentCatalog(catalog);
  return normalized.length > 0
    ? renderAttachmentCatalogEntries('attachment_catalog_checkpoint', normalized, referenceFor)
    : undefined;
}

export function renderAttachmentCatalogPlacement(
  placement: AttachmentCatalogPlacement,
  referenceFor?: (entry: AttachmentCatalogEntry, index: number) => string | undefined
): MessageContent {
  return renderAttachmentCatalogEntries(placement.kind, placement.entries, referenceFor);
}

function renderAttachmentCatalogEntries(
  kind: AttachmentCatalogPlacement['kind'],
  catalog: readonly AttachmentCatalogEntry[],
  referenceFor?: (entry: AttachmentCatalogEntry, index: number) => string | undefined
): MessageContent {
  const normalized = mergeAttachmentCatalog(catalog);
  if (normalized.length === 0) throw new Error('Attachment catalog state placement must not be empty.');
  const rows = normalized.map((entry, index) => JSON.stringify({
    attachmentRef: referenceFor?.(entry, index) ?? `F${index + 1}`,
    name: entry.name,
    mimeType: entry.mimeType,
    sizeBytes: entry.sizeBytes
  }));
  const includesPagedAttachment = normalized.some((entry) =>
    entry.mimeType === 'text/plain' || entry.mimeType === 'application/pdf');
  const stateGuidance = kind === 'attachment_catalog_checkpoint'
    ? '这是附件目录检查点：它替换此前目录状态。'
    : '这是附件目录增量：把下列条目加入当前目录状态。';
  return {
    // MessageContent currently exposes only user/model roles. This explicit system-reminder envelope
    // is rendered only at the Provider boundary and is never persisted as Conversation user prose.
    role: 'user',
    parts: [{
      text: [
        '<system-reminder>',
        ATTACHMENT_CATALOG_HEADER,
        `状态类型：${kind}`,
        stateGuidance,
        ...(includesPagedAttachment ? [ATTACHMENT_PAGE_RANGE_GUIDANCE] : []),
        ...rows,
        '</system-reminder>'
      ].join('\n')
    }]
  };
}

function sameEntry(left: AttachmentCatalogEntry, right: AttachmentCatalogEntry): boolean {
  return left.attachmentId === right.attachmentId
    && left.name === right.name
    && left.mimeType === right.mimeType
    && left.sizeBytes === right.sizeBytes;
}

function collect(value: unknown, entries: AttachmentCatalogEntry[], seen: Set<object>): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const entry of value) collect(entry, entries, seen);
    return;
  }
  const record = asRecord(value);
  if (!record || seen.has(record)) return;
  seen.add(record);

  const inlineData = asRecord(record.inlineData);
  if (inlineData) {
    const entry = optionalInlineDataEntry(inlineData);
    if (entry) entries.push(entry);
  }
  for (const [key, child] of Object.entries(record)) {
    // Base64 bodies and provider-native ciphertext can be enormous and can never contain directory
    // structure. Skipping them also guarantees catalog collection is independent of payload size.
    if (key === 'data' || key === 'encryptedContent') continue;
    if (key === 'result' && typeof child === 'string') {
      collectNestedJson(child, entries, seen);
      continue;
    }
    collect(child, entries, seen);
  }
}

function collectNestedJson(value: string, entries: AttachmentCatalogEntry[], seen: Set<object>): void {
  const trimmed = value.trim();
  if ((!trimmed.startsWith('{') && !trimmed.startsWith('[')) || trimmed.length > 16 * 1024 * 1024) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    // Tool result text may start with JSON punctuation without being a JSON envelope.
    return;
  }
  collect(parsed, entries, seen);
}

function optionalInlineDataEntry(value: Record<string, unknown>): AttachmentCatalogEntry | undefined {
  if (value.attachmentId === undefined) return undefined;
  const attachmentId = requireText(value.attachmentId, 'inlineData.attachmentId');
  const name = requireText(value.name, 'inlineData.name');
  const mimeType = requireText(value.mimeType, 'inlineData.mimeType');
  const sizeBytes = nonNegativeInteger(value.sizeBytes);
  if (sizeBytes === undefined) {
    throw new TypeError('inlineData.sizeBytes must be a non-negative safe integer.');
  }
  return { attachmentId, name, mimeType, sizeBytes };
}

function normalizeEntry(value: unknown, label: string): AttachmentCatalogEntry {
  const record = asRecord(value);
  if (!record) throw new TypeError(`${label} must be an object.`);
  const attachmentId = requireText(record.attachmentId, `${label}.attachmentId`);
  const name = requireText(record.name, `${label}.name`);
  const mimeType = requireText(record.mimeType, `${label}.mimeType`);
  const sizeBytes = nonNegativeInteger(record.sizeBytes);
  if (sizeBytes === undefined) throw new TypeError(`${label}.sizeBytes must be a non-negative safe integer.`);
  return { attachmentId, name, mimeType, sizeBytes };
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  return normalized === 'application/json' || normalized.endsWith('+json');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new TypeError(`${label} must be non-empty text.`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
