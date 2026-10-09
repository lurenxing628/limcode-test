/** Parameter errors are tool results, never provider/network retry errors. */
export class ToolArgumentError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

export function toolArgumentRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolArgumentError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** Only information-free placeholders; zero and false retain their meaning. */
export function isEmptyToolArgument(value: unknown): boolean {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
}

/** Optional tool budgets use defaults and bounded execution, rather than rejecting a useful call. */
export function normalizeToolInteger(value: unknown, label: string, fallback: number, minimum: number, maximum: number): number {
  if (isEmptyToolArgument(value) || typeof value === 'string' && !value.trim()) return fallback;
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new ToolArgumentError(`${label} must be a non-negative integer.`);
  }
  return Math.min(maximum, Math.max(minimum, number));
}
