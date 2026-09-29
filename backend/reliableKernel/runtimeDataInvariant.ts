/** Typed data refusals survive the worker boundary; infrastructure/programming errors do not. */
export const RUNTIME_DATA_INVARIANT = 'RUNTIME_DATA_INVARIANT';

export class RuntimeDataInvariantError extends Error {
  public readonly code = RUNTIME_DATA_INVARIANT;
  public constructor(public readonly domain: string, public readonly recordId: string, message: string) {
    super(message);
    this.name = 'RuntimeDataInvariantError';
  }
}

export function isRuntimeDataInvariant(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === RUNTIME_DATA_INVARIANT || (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT'));
}
