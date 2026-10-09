import type { InlineDataPart } from '@shared/protocol';

/**
 * In-memory only preview bytes. Durable messages intentionally keep managed references instead of
 * embedding image bytes; this cache bridges the short gap between a composer preview and the
 * message projection without changing the persistence or model-input contract.
 */
const MAX_ENTRIES = 16;
const MAX_BYTES = 24 * 1024 * 1024;
const entries = new Map<string, { data: string; bytes: number; mimeType: string }>();
let cachedBytes = 0;

export function rememberInlineAttachmentPreview(part: InlineDataPart): void {
  const key = previewKey(part.inlineData);
  const data = part.inlineData.data;
  if (!key || !data) return;
  const bytes = Math.max(0, part.inlineData.sizeBytes ?? estimateBase64Bytes(data));
  if (bytes > MAX_BYTES) return;

  const previous = entries.get(key);
  if (previous) cachedBytes -= previous.bytes;
  entries.set(key, { data, bytes, mimeType: part.inlineData.mimeType });
  cachedBytes += bytes;
  while (entries.size > MAX_ENTRIES || cachedBytes > MAX_BYTES) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) break;
    const removed = entries.get(oldest);
    entries.delete(oldest);
    if (removed) cachedBytes -= removed.bytes;
  }
}

export function cachedInlineAttachmentPreview(part: InlineDataPart): InlineDataPart | undefined {
  const key = previewKey(part.inlineData);
  if (!key) return undefined;
  const cached = entries.get(key);
  if (!cached) return undefined;
  // LRU promotion keeps repeated images useful without allowing unbounded memory growth.
  entries.delete(key);
  entries.set(key, cached);
  return {
    inlineData: {
      ...part.inlineData,
      data: cached.data,
      mimeType: cached.mimeType,
      status: 'available'
    }
  };
}

function previewKey(inlineData: InlineDataPart['inlineData']): string | undefined {
  const sha256 = inlineData.sha256?.trim().toLowerCase();
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  const mimeType = inlineData.mimeType || 'application/octet-stream';
  const sizeBytes = Number.isSafeInteger(inlineData.sizeBytes) ? inlineData.sizeBytes : 0;
  return `${sha256}:${mimeType}:${sizeBytes}`;
}

function estimateBase64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}
