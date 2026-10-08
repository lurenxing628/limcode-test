import { createHash } from 'node:crypto';

/**
 * 为规范化后的纯 JSON 数据生成稳定内容指纹。
 *
 * 对象键顺序不会制造假冲突；数组顺序与任何业务字段变化都会推进 revision。
 */
export function createStorageRevision(value: unknown): string {
  const canonical = canonicalStorageJson(value);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Local equality uses the same JSON semantics as revisions, without computing a digest. */
export function sameStorageContent(left: unknown, right: unknown): boolean {
  return canonicalStorageJson(left) === canonicalStorageJson(right);
}

function canonicalStorageJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

/** 尚未创建资源时使用的确定性 revision，让首次写入也必须经过相同比对。 */
export function createMissingStorageRevision(resource: string): string {
  return createStorageRevision({ kind: 'storage.missing', resource });
}

function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Storage revision input contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      if (typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
        throw new TypeError(`Storage revision input contains an unsupported value at key "${key}".`);
      }
      result[key] = canonicalizeJson(child);
    }
    return result;
  }
  throw new TypeError(`Storage revision input is not JSON-compatible: ${typeof value}`);
}
