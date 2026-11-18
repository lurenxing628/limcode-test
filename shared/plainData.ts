export type PlainData = null | string | number | boolean | PlainData[] | { [key: string]: PlainData };

/** Recursively copies Vue/Pinia proxy-backed object graphs into structured-clone plain data. */
export function toStructuredClonePlainData(value: unknown, label = 'payload'): PlainData {
  return copyPlain(value, label, [], new WeakSet<object>(), false) as PlainData;
}

export function isStructuredClonePlainData(value: unknown): value is PlainData {
  try {
    toStructuredClonePlainData(value);
    return true;
  } catch {
    return false;
  }
}

function formatPlainPath(rootLabel: string, pathStack: ReadonlyArray<string | number>): string {
  if (pathStack.length === 0) return rootLabel;
  let formatted = rootLabel;
  for (let i = 0; i < pathStack.length; i += 1) {
    const segment = pathStack[i]!;
    formatted += typeof segment === 'number' ? `[${segment}]` : `.${segment}`;
  }
  return formatted;
}

function copyPlain(
  value: unknown,
  rootLabel: string,
  pathStack: Array<string | number>,
  ancestors: WeakSet<object>,
  allowUndefined: boolean
): PlainData | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${formatPlainPath(rootLabel, pathStack)} contains a non-finite number.`);
    return value;
  }
  if (value === undefined && allowUndefined) return undefined;
  if (value === undefined) {
    throw new TypeError(`${formatPlainPath(rootLabel, pathStack)} contains undefined outside an optional object field.`);
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`${formatPlainPath(rootLabel, pathStack)} contains unsupported ${typeof value}.`);
  }
  if (typeof value !== 'object') throw new TypeError(`${formatPlainPath(rootLabel, pathStack)} is not structured-clone plain data.`);
  if (value instanceof Map || value instanceof Set || value instanceof Date || value instanceof RegExp) {
    throw new TypeError(`${formatPlainPath(rootLabel, pathStack)} contains a forbidden class instance.`);
  }
  const object = value as object;
  if (ancestors.has(object)) throw new TypeError(`${formatPlainPath(rootLabel, pathStack)} contains a cycle.`);
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      const result = new Array<PlainData>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) continue;
        pathStack.push(index);
        const copied = copyPlain(value[index], rootLabel, pathStack, ancestors, true);
        pathStack.pop();
        result[index] = copied === undefined ? null : copied;
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${formatPlainPath(rootLabel, pathStack)} contains a non-plain class instance.`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const result: Record<string, PlainData> = {};
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      pathStack.push(key);
      const copied = copyPlain(record[key], rootLabel, pathStack, ancestors, true);
      pathStack.pop();
      if (copied !== undefined) result[key] = copied;
    }
    return result;
  } finally {
    ancestors.delete(object);
  }
}
