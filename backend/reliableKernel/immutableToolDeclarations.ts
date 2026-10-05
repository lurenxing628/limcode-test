import type { ToolDeclaration, ToolDefinition } from '../world/modules/tools/registry';
import { normalizePlainJson, type PlainJsonValue } from './plainJson';

// A shallow Object.freeze supplied by a host is not an immutable schema contract. Only owned,
// recursively frozen copies made here may take the declaration-identity fast path.
const immutableDeclarations = new WeakMap<ToolDeclaration, number>();

export function immutableToolDefinition(definition: ToolDefinition): ToolDefinition {
  if (isImmutableToolDeclaration(definition.declaration)) {
    return Object.isFrozen(definition) ? definition : Object.freeze({ ...definition }) as ToolDefinition;
  }
  const declaration = normalizePlainJson(Object.fromEntries(
    Object.entries(definition.declaration).filter(([, value]) => value !== undefined)
  ), 'Tool declaration');
  freezeDeep(declaration);
  const snapshot = declaration as unknown as ToolDeclaration;
  // Computed at publication, never by walking retained schemas during a model round.
  immutableDeclarations.set(snapshot, Buffer.byteLength(JSON.stringify(declaration), 'utf8'));
  return Object.freeze({ ...definition, declaration: snapshot }) as ToolDefinition;
}

export function isImmutableToolDeclaration(declaration: ToolDeclaration): boolean {
  return immutableDeclarations.has(declaration);
}

export function immutableToolDeclarationByteLength(declaration: ToolDeclaration): number {
  const size = immutableDeclarations.get(declaration);
  if (size === undefined) throw new TypeError('Tool declaration is not an owned immutable snapshot.');
  return size;
}

/** Compare actual model inputs, including mutable/fresh custom hosts, without serialization. */
export function sameToolDeclarationProjection(left: ToolDeclaration, right: ToolDeclaration): boolean {
  if (immutableDeclarations.has(left) && immutableDeclarations.has(right)) return left === right;
  return left.name === right.name && left.description === right.description
    && samePlainJsonInput(left.parameters ?? {}, right.parameters ?? {})
    && samePlainJsonInput(left.source, right.source)
    && samePlainJsonInput(left.metadata, right.metadata)
    && samePlainJsonInput(left.defaultConfig, right.defaultConfig);
}

/** The right side is owned plain data; a mutable left side is inspected on every comparison. */
export function samePlainJsonInput(left: unknown, right: unknown, ancestors = new Set<object>()): boolean {
  if (typeof left === 'bigint') return left.toString() === right;
  if (left === null || typeof left !== 'object') return left === right;
  if (!right || typeof right !== 'object' || ancestors.has(left)) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== (right as unknown[]).length) return false;
  } else {
    const prototype = Object.getPrototypeOf(left);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  ancestors.add(left);
  try {
    return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && samePlainJsonInput((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], ancestors));
  } finally {
    ancestors.delete(left);
  }
}

function freezeDeep(value: PlainJsonValue): void {
  if (!value || typeof value !== 'object') return;
  for (const nested of Object.values(value)) freezeDeep(nested);
  Object.freeze(value);
}
