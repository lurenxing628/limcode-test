import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { CHILD_ANSWER_SOURCE_DELETED_CONTENT_TYPE } from './deliverySettlementSteps';
import { requirePhaseFId, requirePhaseFText } from './phaseFIdentity';
import {
  RUNTIME_DELIVERY_MODEL_CONTENT_TYPE,
  requireRuntimeDeliveryModelEnvelope
} from './runtimeDeliveryProjection';

export type AcceptedAnswerTextRepresentation = 'historical-runtime-envelope' | 'source-deleted-notice';

/** Bounded scalar evidence only. `title` is a preview; `content`/`reason` never enter this record. */
export interface AcceptedAnswerEnvelopeMetadata {
  kind: 'child_answer' | 'child_failure' | 'child_answer_source_deleted';
  submissionId: string;
  childExecutionId: string;
  answerBridgeId: string;
  sourceTurnId: string;
  title: string | null;
  childConversationId?: string;
  status?: 'submitted' | 'interrupted' | 'failed';
  sourceId?: string;
  deliveryId?: string;
  inboxItemId?: string;
  targetTurnId?: string;
  deliveredAt?: string;
  note?: string;
  contentType?: string;
}

export interface AcceptedAnswerTextReadOptions {
  signal?: AbortSignal;
  expected?: Partial<AcceptedAnswerEnvelopeMetadata>;
}

interface Checkpoint { rawOffset: number; decodedOffset: number }
interface TextIndex {
  identity: string;
  metadata: AcceptedAnswerEnvelopeMetadata;
  checkpoints: Checkpoint[];
  cursor?: Checkpoint;
  rawEnd: number;
  trimStart: number;
  totalBytes: number;
}

const READ_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_ENTRIES = 16;
const MAX_ACTIVE = 4;
const MAX_CHECKPOINTS = 256;
const INITIAL_CHECKPOINT_BYTES = 64 * 1024;
const MAX_DEPTH = 128;
const MAX_SCALAR_CHARACTERS = 4096;
const MAX_KEY_CHARACTERS = 64;
const TITLE_BYTES = 240;
const SCALAR_FIELDS = new Set([
  'kind', 'status', 'sourceId', 'deliveryId', 'inboxItemId', 'targetTurnId', 'deliveredAt', 'note',
  'submissionId', 'childExecutionId', 'answerBridgeId', 'sourceTurnId', 'childConversationId', 'title', 'contentType'
]);

/**
 * Lazy accepted-text paging. The first demand validates the entire JSON grammar and builds a
 * bounded offset index, without materializing the document or its text. Later pages start at a
 * sparse checkpoint or the most recent sequential cursor. All offsets count decoded UTF-8 bytes,
 * including offsets inside a multi-byte code point, just like ordinary CAS detail paging.
 *
 * The injected capability must be the verified CAS range reader (or its offline-fenced adapter),
 * never a bare file reader. Every demand, including a cached empty/EOF result, revalidates CAS.
 * Checkpoints bind the full content identity. A replaced file must pass the existing digest/root/
 * canonical-file fences before any cached checkpoint is reused; an identical verified digest has
 * identical string offsets. No body bytes, file handles or failed indexes are retained here.
 */
export class AcceptedAnswerTextPages {
  private readonly indexes = new Map<string, TextIndex>();
  private readonly messageIndexes = new Map<string, MessageTextIndex>();
  private active = 0;
  private generation = 0;

  public constructor(private readonly source: Pick<ContentAddressedStore, 'readChunk'>) {}

  public clear(): void { this.generation += 1; this.indexes.clear(); this.messageIndexes.clear(); }

  public cacheInspection(): { entries: number; checkpoints: number; active: number; maxEntries: number; maxCheckpoints: number } {
    let checkpoints = 0;
    for (const index of this.indexes.values()) checkpoints += index.checkpoints.length + (index.cursor ? 1 : 0);
    for (const index of this.messageIndexes.values()) checkpoints += index.checkpoints.length + (index.cursor ? 1 : 0);
    return { entries: this.indexes.size + this.messageIndexes.size, checkpoints, active: this.active,
      maxEntries: MAX_ENTRIES * 2, maxCheckpoints: MAX_ENTRIES * 2 * (MAX_CHECKPOINTS + 1) };
  }

  public async inspect(
    metadata: ContentObjectMetadata,
    representation: AcceptedAnswerTextRepresentation,
    options: AcceptedAnswerTextReadOptions = {}
  ): Promise<{ totalBytes: number; metadata: AcceptedAnswerEnvelopeMetadata }> {
    return this.admit(async () => {
      const index = await this.index(metadata, representation, options);
      return { totalBytes: index.totalBytes, metadata: { ...index.metadata } };
    });
  }

  public async read(
    metadata: ContentObjectMetadata,
    representation: AcceptedAnswerTextRepresentation,
    offset: number,
    maxBytes: number,
    options: AcceptedAnswerTextReadOptions = {}
  ): Promise<{ chunk: Buffer; totalBytes: number; metadata: AcceptedAnswerEnvelopeMetadata }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Accepted text offset must be non-negative.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_PAGE_BYTES) {
      throw new RangeError(`Accepted text page must be between 1 and ${MAX_PAGE_BYTES} bytes.`);
    }
    return this.admit(async () => {
      const index = await this.index(metadata, representation, options);
      if (offset > index.totalBytes) throw new RangeError('Accepted text offset exceeds text length.');
      const count = Math.min(maxBytes, index.totalBytes - offset);
      const output = Buffer.alloc(count);
      if (count > 0) {
        const start = offset + index.trimStart;
        const end = start + count;
        let checkpoint = index.checkpoints[0]!;
        for (const entry of index.checkpoints) {
          if (entry.decodedOffset <= start && entry.decodedOffset > checkpoint.decodedOffset) checkpoint = entry;
        }
        if (index.cursor && index.cursor.decodedOffset <= start && index.cursor.decodedOffset > checkpoint.decodedOffset) {
          checkpoint = index.cursor;
        }
        let decodedOffset = checkpoint.decodedOffset;
        let nextCursor = checkpoint;
        const decoder = new JsonStringDecoder((codePoint, rawStart, rawEnd) => {
          const width = utf8Width(codePoint);
          writeScalarSlice(output, codePoint, decodedOffset, start, end);
          // If the page cuts a scalar, retain its start so the next page can recover its suffix.
          if (decodedOffset < end) {
            nextCursor = decodedOffset + width <= end
              ? { rawOffset: rawEnd, decodedOffset: decodedOffset + width }
              : { rawOffset: rawStart, decodedOffset };
          }
          decodedOffset += width;
        });
        let rawOffset = checkpoint.rawOffset;
        while (decodedOffset < end) {
          checkCancelled(options.signal);
          const length = Math.min(READ_BYTES, index.rawEnd + 1 - rawOffset);
          if (length <= 0) throw invalidJson();
          const range = await this.source.readChunk(metadata, rawOffset, length);
          assertRange(range, metadata, rawOffset, length);
          checkCancelled(options.signal);
          for (let at = 0; at < range.chunk.length && decodedOffset < end; at += 1) {
            if ((at & 4095) === 0) checkCancelled(options.signal);
            if (decoder.push(range.chunk[at]!, rawOffset + at)) {
              if (decodedOffset < end) throw invalidJson();
              break;
            }
          }
          rawOffset += range.chunk.length;
        }
        index.cursor = nextCursor;
      }
      checkCancelled(options.signal);
      return { chunk: output, totalBytes: index.totalBytes, metadata: { ...index.metadata } };
    });
  }

  /** Normalizes MessageContent parts exactly once for indexing; only visible text is pageable. */
  public async readMessageContent(
    metadata: ContentObjectMetadata,
    offset: number,
    maxBytes: number,
    options: Pick<AcceptedAnswerTextReadOptions, 'signal'> = {}
  ): Promise<{ chunk: Buffer; totalBytes: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Accepted text offset must be non-negative.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_PAGE_BYTES) {
      throw new RangeError(`Accepted text page must be between 1 and ${MAX_PAGE_BYTES} bytes.`);
    }
    return this.admit(async () => {
      const index = await this.messageIndex(metadata, options.signal);
      if (offset > index.totalBytes) throw new RangeError('Accepted text offset exceeds text length.');
      const count = Math.min(maxBytes, index.totalBytes - offset);
      const output = Buffer.alloc(count);
      if (!count) return { chunk: output, totalBytes: index.totalBytes };
      const end = offset + count;
      let point = index.checkpoints[0]!;
      for (const candidate of index.checkpoints) {
        if (messagePointOffset(candidate) <= offset && messagePointOffset(candidate) > messagePointOffset(point)) point = candidate;
      }
      if (index.cursor && messagePointOffset(index.cursor) <= offset && messagePointOffset(index.cursor) > messagePointOffset(point)) point = index.cursor;
      let iterator: MessageSpanIterator | undefined;
      while (point.span.outputStart - (point.span.outputStart ? 1 : 0) < end) {
        checkCancelled(options.signal);
        const span = point.span;
        index.cursor = point;
        const newline = span.outputStart - 1;
        if (span.outputStart > 0 && newline >= offset && newline < end) output[newline - offset] = 10;
        const start = Math.max(offset, span.outputStart);
        const stop = Math.min(end, span.outputStart + span.totalBytes);
        if (start < stop) {
          const read = await readSelectedString(this.source, metadata, span, point.cursor,
            start - span.outputStart, stop - start, options.signal, iterator?.verifiedWindow());
          read.chunk.copy(output, start - offset);
          index.cursor = { span, cursor: read.cursor };
        }
        if (span.outputStart + span.totalBytes >= end) break;
        const nextStart = span.outputStart + span.totalBytes + 1;
        const knownNext = index.checkpoints.find((entry) => entry.span.outputStart === nextStart)?.span;
        if (knownNext) {
          // A sparse point inside a large part also proves its complete span/visibility. Reuse
          // that descriptor rather than scanning the entire part again just to read its start.
          point = { span: knownNext, cursor: { rawOffset: knownNext.rawStart, decodedOffset: knownNext.trimStart } };
          iterator = undefined;
          continue;
        }
        // Keep the scanner and one raw chunk for a run of small parts; there is no per-part list.
        iterator ??= new MessageSpanIterator(this.source, metadata, span.partRawEnd,
          span.outputStart + span.totalBytes, options.signal);
        const next = await iterator.next();
        if (!next) throw new Error('Accepted message text index conflicts with its verified source.');
        point = { span: next, cursor: { rawOffset: next.rawStart, decodedOffset: next.trimStart } };
      }
      checkCancelled(options.signal);
      return { chunk: output, totalBytes: index.totalBytes };
    });
  }

  private async messageIndex(metadata: ContentObjectMetadata, signal?: AbortSignal): Promise<MessageTextIndex> {
    const generation = this.generation;
    checkCancelled(signal);
    if (metadata.content_type !== 'application/vnd.limcode.message+json') throw new TypeError('Accepted message text has an unexpected content type.');
    const rawBytes = Number(metadata.byte_length);
    if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) throw new RangeError('Accepted text source exceeds safe byte addressing.');
    const identity = JSON.stringify([metadata.id, metadata.content_type, metadata.sha256, String(metadata.byte_length), metadata.storage_key]);
    const old = this.messageIndexes.get(metadata.id);
    if (old?.identity !== identity) this.messageIndexes.delete(metadata.id);
    const firstLength = Math.min(old?.identity === identity ? 1 : READ_BYTES, rawBytes);
    const first = await this.source.readChunk(metadata, 0, firstLength || 1);
    assertRange(first, metadata, 0, firstLength);
    checkCancelled(signal);
    if (old?.identity === identity) {
      if (generation === this.generation) {
        this.messageIndexes.delete(metadata.id); this.messageIndexes.set(metadata.id, old);
        while (this.messageIndexes.size > MAX_ENTRIES) this.messageIndexes.delete(this.messageIndexes.keys().next().value!);
      }
      return old;
    }
    const scanner = new EnvelopeScanner('message-content');
    scanner.push(first.chunk, 0, signal);
    for (let offset = first.chunk.length; offset < rawBytes;) {
      checkCancelled(signal);
      const count = Math.min(READ_BYTES, rawBytes - offset);
      const range = await this.source.readChunk(metadata, offset, count);
      assertRange(range, metadata, offset, count);
      checkCancelled(signal);
      scanner.push(range.chunk, offset, signal);
      offset += range.chunk.length;
    }
    const index = scanner.finishMessage(identity);
    checkCancelled(signal);
    if (generation === this.generation) {
      this.messageIndexes.delete(metadata.id); this.messageIndexes.set(metadata.id, index);
      while (this.messageIndexes.size > MAX_ENTRIES) this.messageIndexes.delete(this.messageIndexes.keys().next().value!);
    }
    return index;
  }

  private async admit<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_ACTIVE) {
      const error = new Error('Accepted answer detail readers are busy; retry this demand.');
      Object.assign(error, { code: 'ACCEPTED_ANSWER_DETAIL_BUSY', retryable: true });
      throw error;
    }
    this.active += 1;
    try { return await run(); } finally { this.active -= 1; }
  }

  private async index(
    metadata: ContentObjectMetadata,
    representation: AcceptedAnswerTextRepresentation,
    options: AcceptedAnswerTextReadOptions
  ): Promise<TextIndex> {
    const generation = this.generation;
    checkCancelled(options.signal);
    const expectedType = representation === 'historical-runtime-envelope'
      ? RUNTIME_DELIVERY_MODEL_CONTENT_TYPE : representation === 'source-deleted-notice'
        ? CHILD_ANSWER_SOURCE_DELETED_CONTENT_TYPE : undefined;
    if (!expectedType || metadata.content_type !== expectedType) throw new TypeError('Accepted text has an unexpected representation or content type.');
    const rawBytes = Number(metadata.byte_length);
    if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) throw new RangeError('Accepted text source exceeds safe byte addressing.');
    const identity = JSON.stringify([metadata.id, metadata.content_type, metadata.sha256, String(metadata.byte_length), metadata.storage_key, representation]);
    const old = this.indexes.get(metadata.id);
    if (old?.identity !== identity) this.indexes.delete(metadata.id);
    // Mandatory even for cached/empty results: preserve the existing root and physical file fences.
    const firstLength = Math.min(old?.identity === identity ? 1 : READ_BYTES, rawBytes);
    const first = await this.source.readChunk(metadata, 0, firstLength || 1);
    assertRange(first, metadata, 0, firstLength);
    checkCancelled(options.signal);
    if (old?.identity === identity) {
      assertExpected(old.metadata, options.expected);
      if (generation === this.generation) {
        this.indexes.delete(metadata.id); this.indexes.set(metadata.id, old);
        while (this.indexes.size > MAX_ENTRIES) this.indexes.delete(this.indexes.keys().next().value!);
      }
      return old;
    }
    const scanner = new EnvelopeScanner(representation);
    scanner.push(first.chunk, 0, options.signal);
    for (let offset = first.chunk.length; offset < rawBytes;) {
      checkCancelled(options.signal);
      const count = Math.min(READ_BYTES, rawBytes - offset);
      const range = await this.source.readChunk(metadata, offset, count);
      assertRange(range, metadata, offset, count);
      checkCancelled(options.signal);
      scanner.push(range.chunk, offset, options.signal);
      offset += range.chunk.length;
    }
    const index = scanner.finish(identity);
    assertExpected(index.metadata, options.expected);
    checkCancelled(options.signal);
    if (generation === this.generation) {
      this.indexes.delete(metadata.id); this.indexes.set(metadata.id, index);
      while (this.indexes.size > MAX_ENTRIES) this.indexes.delete(this.indexes.keys().next().value!);
    }
    return index;
  }
}

type Frame = { role?: 'parts' | 'part'; kind: 'object'; state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd'; key: string }
  | { role?: 'parts' | 'part'; kind: 'array'; state: 'valueOrEnd' | 'value' | 'commaOrEnd' };
type NumberState = 'minus' | 'zero' | 'integer' | 'point' | 'fraction' | 'exponent' | 'sign' | 'exponentDigits';

/** A strict streaming JSON grammar recognizer; unrelated values are validated and discarded. */
class EnvelopeScanner {
  private readonly frames: Frame[] = [];
  private readonly scalars: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  private readonly seen = new Set<string>();
  private root: 'start' | 'done' = 'start';
  private string?: JsonStringDecoder;
  private stringEnd?: (position: number) => void;
  private number?: NumberState;
  private literal?: { text: string; at: number; done: () => void };
  private bodySeen = false;
  private bodyStart = 0;
  private bodyEnd = -1;
  private decodedBytes = 0;
  private firstNonWhitespace?: number;
  private lastNonWhitespaceEnd = 0;
  private checkpoints: Checkpoint[] = [];
  private checkpointStride = INITIAL_CHECKPOINT_BYTES;
  private nextCheckpoint = INITIAL_CHECKPOINT_BYTES;

  public readonly message?: MessagePartsCollector;

  public constructor(
    private readonly representation: AcceptedAnswerTextRepresentation | 'message-content',
    onPart?: (span: MessageSpan) => void,
    resumeOutputBytes?: number
  ) {
    if (representation === 'message-content') {
      this.message = new MessagePartsCollector(onPart);
      if (resumeOutputBytes !== undefined) {
        this.root = 'done';
        this.frames.push({ kind: 'object', state: 'commaOrEnd', key: 'parts' },
          { kind: 'array', state: 'commaOrEnd', role: 'parts' });
        this.message.resume(resumeOutputBytes);
      }
    }
  }

  public push(bytes: Buffer, rawOffset: number, signal?: AbortSignal, stop?: () => boolean): number {
    for (let at = 0; at < bytes.length; at += 1) {
      if (stop?.()) return at;
      if ((at & 4095) === 0) checkCancelled(signal);
      const byte = bytes[at]!;
      const position = rawOffset + at;
      if (this.string) {
        if (this.string.push(byte, position)) {
          const done = this.stringEnd!;
          this.string = undefined; this.stringEnd = undefined; done(position);
        }
        continue;
      }
      if (this.literal) {
        if (byte !== this.literal.text.charCodeAt(this.literal.at)) throw invalidJson();
        this.literal.at += 1;
        if (this.literal.at === this.literal.text.length) {
          const done = this.literal.done; this.literal = undefined; done();
        }
        continue;
      }
      if (this.number && this.numberByte(byte)) continue;
      this.structuralByte(byte, position);
    }
    return bytes.length;
  }

  public finishMessage(identity: string): MessageTextIndex {
    if (this.number) this.finishNumber();
    if (this.string || this.literal || this.frames.length || this.root !== 'done' || !this.message?.hasParts) throw invalidJson();
    return this.message.finish(identity);
  }

  public finish(identity: string): TextIndex {
    if (this.number) this.finishNumber();
    if (this.string || this.literal || this.frames.length || this.root !== 'done' || !this.bodySeen || this.bodyEnd < 0) throw invalidJson();
    const metadata = this.validateMetadata();
    const trim = this.representation === 'source-deleted-notice';
    const trimStart = trim ? this.firstNonWhitespace ?? this.decodedBytes : 0;
    const totalBytes = trim ? this.lastNonWhitespaceEnd - trimStart : this.decodedBytes;
    if (trim && totalBytes <= 0) throw new TypeError('Deleted child notice reason must be non-empty text.');
    return { identity, metadata, checkpoints: this.checkpoints, rawEnd: this.bodyEnd, trimStart, totalBytes };
  }

  private closeFrame(position: number): void {
    const frame = this.frames.pop()!;
    if (frame.role === 'part') this.message!.endPart(position + 1);
  }

  private structuralByte(byte: number, position: number): void {
    if (isJsonWhitespace(byte)) return;
    const frame = this.frames[this.frames.length - 1];
    if (!frame) {
      if (this.root !== 'start' || byte !== 0x7b) throw invalidJson();
      this.root = 'done'; this.frames.push({ kind: 'object', state: 'keyOrEnd', key: '' }); return;
    }
    if (frame.kind === 'object') {
      if (frame.state === 'keyOrEnd' && byte === 0x7d) { this.closeFrame(position); return; }
      if (frame.state === 'keyOrEnd' || frame.state === 'key') {
        if (byte !== 0x22) throw invalidJson();
        let key = ''; let oversized = false;
        this.string = new JsonStringDecoder((cp) => {
          if (oversized) return;
          const part = String.fromCodePoint(cp);
          if (key.length + part.length > MAX_KEY_CHARACTERS) { oversized = true; key = ''; }
          else key += part;
        });
        this.stringEnd = () => { frame.key = oversized ? '' : key; frame.state = 'colon'; };
        return;
      }
      if (frame.state === 'colon') {
        if (byte !== 0x3a) throw invalidJson(); frame.state = 'value'; return;
      }
      if (frame.state === 'commaOrEnd') {
        if (byte === 0x7d) this.closeFrame(position);
        else if (byte === 0x2c) frame.state = 'key';
        else throw invalidJson();
        return;
      }
    } else {
      if (frame.state === 'valueOrEnd' && byte === 0x5d) { this.closeFrame(position); return; }
      if (frame.state === 'commaOrEnd') {
        if (byte === 0x5d) this.closeFrame(position);
        else if (byte === 0x2c) frame.state = 'value';
        else throw invalidJson();
        return;
      }
    }
    const field = this.frames.length === 1 && frame.kind === 'object' ? frame.key : '';
    const partField = frame.kind === 'object' && frame.role === 'part' ? frame.key : '';
    const parts = Boolean(this.message) && field === 'parts';
    if (parts) this.message!.resetParts(byte === 0x5b);
    if (this.message && partField === 'text') this.message.beginText(byte === 0x22 ? position + 1 : undefined);
    if (this.message && partField === 'thought') this.message.thought = byte === 0x74;
    frame.state = 'commaOrEnd';
    const body = !this.message && field === (this.representation === 'historical-runtime-envelope' ? 'content' : 'reason');
    const capture = !this.message && SCALAR_FIELDS.has(field);
    if (body || capture) {
      if (this.seen.has(field)) throw new TypeError('Accepted text envelope repeats an authority field.');
      this.seen.add(field);
      if (byte !== 0x22 && !(capture && byte === 0x6e && (field === 'title' || field === 'childConversationId'))) throw invalidJson();
    }
    if (byte === 0x22) {
      if (this.message && partField === 'text') {
        this.string = new JsonStringDecoder((cp, rawStart) => this.message!.textScalar(cp, rawStart));
        this.stringEnd = (end) => this.message!.endText(end);
      } else if (body) {
        this.bodySeen = true; this.bodyStart = position + 1;
        this.checkpoints = [{ rawOffset: this.bodyStart, decodedOffset: 0 }];
        this.string = new JsonStringDecoder((cp, rawStart) => this.bodyScalar(cp, rawStart));
        this.stringEnd = (end) => { this.bodyEnd = end; };
      } else {
        let value = ''; let titleStarted = false; let titleBytes = 0; let titleFull = false;
        this.string = new JsonStringDecoder((cp) => {
          if (!capture) return;
          const part = String.fromCodePoint(cp);
          if (field === 'title') {
            if (!titleStarted && isTrimWhitespace(cp)) return;
            titleStarted = true;
            if (!titleFull && titleBytes + utf8Width(cp) <= TITLE_BYTES) { value += part; titleBytes += utf8Width(cp); }
            else titleFull = true;
          } else {
            if (value.length + part.length > MAX_SCALAR_CHARACTERS) throw new RangeError('Accepted text identity exceeds bounded scalar limit.');
            value += part;
          }
        });
        this.stringEnd = () => { if (capture) this.scalars[field] = field === 'title' ? value.trim() : value; };
      }
      return;
    }
    if (byte === 0x7b || byte === 0x5b) {
      if (this.frames.length >= MAX_DEPTH) throw new RangeError('Accepted text JSON exceeds bounded nesting limit.');
      const role = this.message && frame.role === 'parts' && byte === 0x7b ? 'part' : parts && byte === 0x5b ? 'parts' : undefined;
      if (role === 'part') this.message!.beginPart();
      this.frames.push(byte === 0x7b ? { kind: 'object', state: 'keyOrEnd', key: '', role } : { kind: 'array', state: 'valueOrEnd', role });
      return;
    }
    const literal = byte === 0x74 ? 'true' : byte === 0x66 ? 'false' : byte === 0x6e ? 'null' : undefined;
    if (literal) {
      this.literal = { text: literal, at: 1, done: () => { if (capture) this.scalars[field] = null; } }; return;
    }
    if (byte === 0x2d) this.number = 'minus';
    else if (byte === 0x30) this.number = 'zero';
    else if (byte >= 0x31 && byte <= 0x39) this.number = 'integer';
    else throw invalidJson();
  }

  private bodyScalar(cp: number, rawStart: number): void {
    if (this.decodedBytes >= this.nextCheckpoint) {
      this.checkpoints.push({ rawOffset: rawStart, decodedOffset: this.decodedBytes });
      if (this.checkpoints.length > MAX_CHECKPOINTS) {
        this.checkpoints = this.checkpoints.filter((_entry, at) => at % 2 === 0);
        this.checkpointStride *= 2;
      }
      this.nextCheckpoint = this.decodedBytes + this.checkpointStride;
    }
    const width = utf8Width(cp);
    if (!isTrimWhitespace(cp)) {
      if (this.firstNonWhitespace === undefined) this.firstNonWhitespace = this.decodedBytes;
      this.lastNonWhitespaceEnd = this.decodedBytes + width;
    }
    this.decodedBytes += width;
    if (!Number.isSafeInteger(this.decodedBytes)) throw new RangeError('Accepted text exceeds safe byte addressing.');
  }

  private numberByte(byte: number): boolean {
    const digit = byte >= 0x30 && byte <= 0x39;
    switch (this.number) {
    case 'minus': if (!digit) throw invalidJson(); this.number = byte === 0x30 ? 'zero' : 'integer'; return true;
    case 'zero': case 'integer':
      if (digit) { if (this.number === 'zero') throw invalidJson(); return true; }
      if (byte === 0x2e) { this.number = 'point'; return true; }
      if (byte === 0x65 || byte === 0x45) { this.number = 'exponent'; return true; }
      break;
    case 'point': if (!digit) throw invalidJson(); this.number = 'fraction'; return true;
    case 'fraction':
      if (digit) return true;
      if (byte === 0x65 || byte === 0x45) { this.number = 'exponent'; return true; }
      break;
    case 'exponent':
      if (byte === 0x2b || byte === 0x2d) { this.number = 'sign'; return true; }
      if (!digit) throw invalidJson(); this.number = 'exponentDigits'; return true;
    case 'sign': if (!digit) throw invalidJson(); this.number = 'exponentDigits'; return true;
    case 'exponentDigits': if (digit) return true; break;
    }
    this.finishNumber();
    return false;
  }

  private finishNumber(): void {
    if (!['zero', 'integer', 'fraction', 'exponentDigits'].includes(this.number!)) throw invalidJson();
    this.number = undefined;
  }

  private validateMetadata(): AcceptedAnswerEnvelopeMetadata {
    if (this.representation === 'historical-runtime-envelope') {
      // Reuse the production normalizer on bounded scalars only; the large string never enters it.
      const envelope = requireRuntimeDeliveryModelEnvelope({ ...this.scalars, content: '' });
      if (envelope.kind !== 'child_answer' && envelope.kind !== 'child_failure') throw new TypeError('Accepted text is not a child answer.');
      const { content: _content, ...metadata } = envelope;
      return metadata;
    }
    const value = this.scalars;
    if (value.kind !== 'child_answer_source_deleted') throw new TypeError('Accepted text is not a deleted child notice.');
    return {
      kind: 'child_answer_source_deleted',
      submissionId: requirePhaseFId(value.submissionId, 'Deleted child notice.submissionId'),
      childExecutionId: requirePhaseFId(value.childExecutionId, 'Deleted child notice.childExecutionId'),
      answerBridgeId: requirePhaseFId(value.answerBridgeId, 'Deleted child notice.answerBridgeId'),
      sourceTurnId: requirePhaseFId(value.sourceTurnId, 'Deleted child notice.sourceTurnId'),
      title: value.title === null ? null : requirePhaseFText(value.title, 'Deleted child notice.title'),
      ...(value.childConversationId === undefined || value.childConversationId === null ? {} : {
        childConversationId: requirePhaseFId(value.childConversationId, 'Deleted child notice.childConversationId')
      })
    };
  }
}

/** Decodes a JSON string incrementally, including escapes and UTF-8 split across source chunks. */
class JsonStringDecoder {
  private state: 'normal' | 'escape' | 'unicode' | 'utf8' = 'normal';
  private start = 0;
  private digits = 0;
  private value = 0;
  private utf8Minimum = 0;
  private high?: { value: number; start: number; end: number };

  public constructor(private readonly emit: (codePoint: number, rawStart: number, rawEnd: number) => void) {}

  /** True consumes the closing quote. Returned scalar offsets never bisect an escape/pair. */
  public push(byte: number, position: number): boolean {
    if (this.state === 'unicode') {
      const hex = byte >= 48 && byte <= 57 ? byte - 48 : byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1;
      if (hex < 0) throw invalidJson();
      this.value = this.value * 16 + hex;
      if (--this.digits === 0) { this.state = 'normal'; this.scalar(this.value, this.start, position + 1); }
      return false;
    }
    if (this.state === 'utf8') {
      if ((byte & 0xc0) !== 0x80) throw invalidJson();
      this.value = this.value * 64 + (byte & 0x3f);
      if (--this.digits === 0) {
        if (this.value < this.utf8Minimum || this.value > 0x10ffff || (this.value >= 0xd800 && this.value <= 0xdfff)) throw invalidJson();
        this.state = 'normal'; this.scalar(this.value, this.start, position + 1);
      }
      return false;
    }
    if (this.state === 'escape') {
      if (byte === 0x75) { this.state = 'unicode'; this.digits = 4; this.value = 0; return false; }
      const escaped = byte === 0x22 || byte === 0x5c || byte === 0x2f ? byte
        : byte === 0x62 ? 8 : byte === 0x66 ? 12 : byte === 0x6e ? 10 : byte === 0x72 ? 13 : byte === 0x74 ? 9 : -1;
      if (escaped < 0) throw invalidJson();
      this.state = 'normal'; this.scalar(escaped, this.start, position + 1); return false;
    }
    if (byte === 0x22) { this.flushHigh(); return true; }
    if (byte === 0x5c) { this.start = position; this.state = 'escape'; return false; }
    if (byte < 0x20) throw invalidJson();
    if (byte < 0x80) { this.scalar(byte, position, position + 1); return false; }
    this.start = position; this.state = 'utf8';
    if (byte >= 0xc2 && byte <= 0xdf) { this.value = byte & 0x1f; this.digits = 1; this.utf8Minimum = 0x80; }
    else if (byte >= 0xe0 && byte <= 0xef) { this.value = byte & 0x0f; this.digits = 2; this.utf8Minimum = 0x800; }
    else if (byte >= 0xf0 && byte <= 0xf4) { this.value = byte & 0x07; this.digits = 3; this.utf8Minimum = 0x10000; }
    else throw invalidJson();
    return false;
  }

  private scalar(cp: number, start: number, end: number): void {
    if (this.high && cp >= 0xdc00 && cp <= 0xdfff) {
      this.emit(0x10000 + ((this.high.value - 0xd800) << 10) + cp - 0xdc00, this.high.start, end);
      this.high = undefined; return;
    }
    this.flushHigh();
    if (cp >= 0xd800 && cp <= 0xdbff) this.high = { value: cp, start, end };
    else this.emit(cp, start, end);
  }

  private flushHigh(): void {
    if (this.high) { const high = this.high; this.high = undefined; this.emit(high.value, high.start, high.end); }
  }
}

function utf8Width(cp: number): number { return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }

function writeScalarSlice(output: Buffer, codePoint: number, at: number, start: number, end: number): void {
  const cp = codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint;
  const width = utf8Width(cp);
  if (at + width <= start || at >= end) return;
  for (let index = 0; index < width; index += 1) {
    const position = at + index;
    if (position < start || position >= end) continue;
    const byte = width === 1 ? cp : index === 0
      ? (width === 2 ? 0xc0 : width === 3 ? 0xe0 : 0xf0) | (cp >> (6 * (width - 1)))
      : 0x80 | ((cp >> (6 * (width - index - 1))) & 0x3f);
    output[position - start] = byte;
  }
}

function isJsonWhitespace(byte: number): boolean { return byte === 32 || byte === 9 || byte === 10 || byte === 13; }
function isTrimWhitespace(cp: number): boolean {
  return (cp >= 9 && cp <= 13) || cp === 32 || cp === 0xa0 || cp === 0x1680
    || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029
    || cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === 0xfeff;
}
function invalidJson(): TypeError { return new TypeError('Accepted text envelope must contain complete valid JSON.'); }
function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) { const error = new Error('Accepted text read cancelled.'); error.name = 'AbortError'; throw error; }
}
function assertExpected(actual: AcceptedAnswerEnvelopeMetadata, expected?: Partial<AcceptedAnswerEnvelopeMetadata>): void {
  if (!expected) return;
  for (const key of Object.keys(expected) as Array<keyof AcceptedAnswerEnvelopeMetadata>) {
    if (actual[key] !== expected[key]) throw new Error(`Accepted text envelope conflicts with expected ${key}.`);
  }
}
function assertRange(
  range: { chunk: Buffer; totalBytes: number }, metadata: ContentObjectMetadata, offset: number, count: number
): void {
  if (range.totalBytes !== Number(metadata.byte_length) || range.chunk.length !== count || offset + count > range.totalBytes) {
    throw new Error('Verified accepted text range conflicts with content identity.');
  }
}

interface MessageSpan {
  /** First non-whitespace scalar; decoded addressing still includes trimStart. */
  rawStart: number;
  rawEnd: number;
  partRawEnd: number;
  trimStart: number;
  totalBytes: number;
  outputStart: number;
}
interface MessageSeekPoint { span: MessageSpan; cursor: Checkpoint }
interface MessageTextIndex {
  identity: string;
  totalBytes: number;
  checkpoints: MessageSeekPoint[];
  cursor?: MessageSeekPoint;
}

/** Holds only one part's scalar/index state; `thought` may legally follow its text field. */
class MessagePartsCollector {
  public hasParts = false;
  public thought = false;
  private rawStart = -1;
  private rawEnd = -1;
  private decodedBytes = 0;
  private trimStart?: number;
  private trimEnd = 0;
  private localPoints: Checkpoint[] = [];
  private localStride = INITIAL_CHECKPOINT_BYTES;
  private localNext = INITIAL_CHECKPOINT_BYTES;
  private outputBytes = 0;
  private points: MessageSeekPoint[] = [];
  private stride = INITIAL_CHECKPOINT_BYTES;
  private nextPoint = 0;

  public constructor(private readonly onPart?: (span: MessageSpan) => void) {}
  public resume(outputBytes: number): void { this.hasParts = true; this.outputBytes = outputBytes; }
  public resetParts(isArray: boolean): void {
    this.hasParts = isArray; this.outputBytes = 0; this.points = [];
    this.stride = INITIAL_CHECKPOINT_BYTES; this.nextPoint = 0;
  }
  public beginPart(): void { this.thought = false; this.beginText(undefined); }
  public beginText(rawStart: number | undefined): void {
    this.rawStart = rawStart ?? -1; this.rawEnd = -1;
    this.decodedBytes = 0; this.trimStart = undefined; this.trimEnd = 0;
    this.localPoints = rawStart === undefined ? [] : [{ rawOffset: rawStart, decodedOffset: 0 }];
    this.localStride = INITIAL_CHECKPOINT_BYTES; this.localNext = INITIAL_CHECKPOINT_BYTES;
  }
  public textScalar(cp: number, rawStart: number): void {
    if (this.decodedBytes >= this.localNext) {
      this.localPoints.push({ rawOffset: rawStart, decodedOffset: this.decodedBytes });
      if (this.localPoints.length > MAX_CHECKPOINTS) {
        this.localPoints = this.localPoints.filter((_point, at) => at % 2 === 0); this.localStride *= 2;
      }
      this.localNext = this.decodedBytes + this.localStride;
    }
    const width = utf8Width(cp);
    if (!isTrimWhitespace(cp)) {
      if (this.trimStart === undefined) {
        this.trimStart = this.decodedBytes;
        this.rawStart = rawStart;
        this.localPoints = [{ rawOffset: rawStart, decodedOffset: this.decodedBytes }];
        this.localStride = INITIAL_CHECKPOINT_BYTES;
        this.localNext = this.decodedBytes + this.localStride;
      }
      this.trimEnd = this.decodedBytes + width;
    }
    this.decodedBytes += width;
    if (!Number.isSafeInteger(this.decodedBytes)) throw new RangeError('Accepted message text exceeds safe byte addressing.');
  }
  public endText(rawEnd: number): void { this.rawEnd = rawEnd; }
  public endPart(partRawEnd: number): void {
    if (this.thought || this.rawStart < 0 || this.rawEnd < 0 || this.trimStart === undefined) return;
    const span: MessageSpan = { rawStart: this.rawStart, rawEnd: this.rawEnd, partRawEnd,
      trimStart: this.trimStart, totalBytes: this.trimEnd - this.trimStart,
      outputStart: this.outputBytes + (this.outputBytes ? 1 : 0) };
    this.outputBytes = span.outputStart + span.totalBytes;
    if (!Number.isSafeInteger(this.outputBytes)) throw new RangeError('Accepted message text exceeds safe byte addressing.');
    for (const cursor of this.localPoints) {
      const point = { span, cursor };
      const logical = messagePointOffset(point);
      // A point preceding the trimmed prefix remains a valid string restart. Points in trailing
      // whitespace cannot answer a visible-text request and are never retained.
      if (cursor.decodedOffset >= this.trimEnd) break;
      if (this.points.length && logical < this.nextPoint) continue;
      this.points.push(point);
      if (this.points.length > MAX_CHECKPOINTS) {
        this.points = this.points.filter((_point, at) => at % 2 === 0); this.stride *= 2;
      }
      this.nextPoint = logical + this.stride;
    }
    this.onPart?.(span);
  }
  public finish(identity: string): MessageTextIndex {
    return { identity, totalBytes: this.outputBytes, checkpoints: this.points };
  }
}

function messagePointOffset(point: MessageSeekPoint): number {
  return point.span.outputStart + Math.max(0, point.cursor.decodedOffset - point.span.trimStart)
    - (point.cursor.decodedOffset <= point.span.trimStart && point.span.outputStart ? 1 : 0);
}

/** Resumes at one completed part, retaining a single 64 KiB source chunk and no part queue. */
class MessageSpanIterator {
  private readonly scanner: EnvelopeScanner;
  private rawOffset: number;
  private bytes: Buffer = Buffer.alloc(0);
  private at = 0;
  private part?: MessageSpan;
  public constructor(
    private readonly source: Pick<ContentAddressedStore, 'readChunk'>,
    private readonly metadata: ContentObjectMetadata,
    rawOffset: number,
    outputBytes: number,
    private readonly signal?: AbortSignal
  ) {
    this.rawOffset = rawOffset;
    this.scanner = new EnvelopeScanner('message-content', (span) => { this.part = span; }, outputBytes);
  }
  public verifiedWindow(): { rawOffset: number; bytes: Buffer } {
    return { rawOffset: this.rawOffset, bytes: this.bytes };
  }
  public async next(): Promise<MessageSpan | undefined> {
    this.part = undefined;
    const rawBytes = Number(this.metadata.byte_length);
    while (!this.part) {
      checkCancelled(this.signal);
      if (this.at === this.bytes.length) {
        this.rawOffset += this.bytes.length; this.at = 0;
        if (this.rawOffset === rawBytes) return undefined;
        const count = Math.min(READ_BYTES, rawBytes - this.rawOffset);
        const range = await this.source.readChunk(this.metadata, this.rawOffset, count);
        assertRange(range, this.metadata, this.rawOffset, count);
        checkCancelled(this.signal); this.bytes = range.chunk;
      }
      this.at += this.scanner.push(this.bytes.subarray(this.at), this.rawOffset + this.at,
        this.signal, () => this.part !== undefined);
    }
    return this.part;
  }
}

async function readSelectedString(
  source: Pick<ContentAddressedStore, 'readChunk'>,
  metadata: ContentObjectMetadata,
  span: MessageSpan,
  checkpoint: Checkpoint,
  offset: number,
  count: number,
  signal?: AbortSignal,
  verifiedWindow?: { rawOffset: number; bytes: Buffer }
): Promise<{ chunk: Buffer; cursor: Checkpoint }> {
  const output = Buffer.alloc(count);
  const start = offset + span.trimStart;
  const end = start + count;
  let decodedOffset = checkpoint.decodedOffset;
  let cursor = checkpoint;
  const decoder = new JsonStringDecoder((cp, rawStart, rawEnd) => {
    const width = utf8Width(cp);
    writeScalarSlice(output, cp, decodedOffset, start, end);
    if (decodedOffset < end) cursor = decodedOffset + width <= end
      ? { rawOffset: rawEnd, decodedOffset: decodedOffset + width } : { rawOffset: rawStart, decodedOffset };
    decodedOffset += width;
  });
  for (let rawOffset = checkpoint.rawOffset; decodedOffset < end;) {
    checkCancelled(signal);
    const windowOffset = verifiedWindow ? rawOffset - verifiedWindow.rawOffset : -1;
    const insideWindow = windowOffset >= 0 && windowOffset < (verifiedWindow?.bytes.length ?? 0);
    const count = Math.min(READ_BYTES, span.rawEnd + 1 - rawOffset,
      insideWindow ? verifiedWindow!.bytes.length - windowOffset : READ_BYTES);
    if (count <= 0) throw invalidJson();
    // The iterator's buffer was obtained through this same verified reader during this demand.
    // Reusing it for tiny adjacent parts avoids one file open per part; it is never cached.
    const range = insideWindow
      ? { chunk: verifiedWindow!.bytes.subarray(windowOffset, windowOffset + count), totalBytes: Number(metadata.byte_length) }
      : await source.readChunk(metadata, rawOffset, count);
    assertRange(range, metadata, rawOffset, count);
    checkCancelled(signal);
    for (let at = 0; at < range.chunk.length && decodedOffset < end; at += 1) {
      if ((at & 4095) === 0) checkCancelled(signal);
      if (decoder.push(range.chunk[at]!, rawOffset + at)) {
        if (decodedOffset < end) throw invalidJson();
        break;
      }
    }
    rawOffset += range.chunk.length;
  }
  return { chunk: output, cursor };
}
