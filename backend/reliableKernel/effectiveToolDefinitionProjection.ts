import type { ToolDefinition } from '../world/modules/tools/registry';
import type { ReliableAgentToolDefinition } from './agentLoop';
import { frozenToolDefinitionsByteLength, prepareFrozenToolDefinitions } from './frozenToolDefinitions';
import {
  immutableToolDeclarationByteLength,
  immutableToolDefinition,
  isImmutableToolDeclaration,
  samePlainJsonInput,
  sameToolDeclarationProjection
} from './immutableToolDeclarations';

export interface EffectiveToolDefinitionInput {
  definition: ToolDefinition;
  allowChildSpawn: boolean;
  nativeAsync: boolean;
  skillDescription?: string;
  environmentText?: string;
  agentTypeList?: string;
}

export const EFFECTIVE_TOOL_DEFINITIONS_CACHE_LIMITS = Object.freeze({ entries: 16, bytes: 8 * 1024 * 1024 });

interface ProjectionSnapshot {
  inputs: readonly EffectiveToolDefinitionInput[];
  definitions: readonly ReliableAgentToolDefinition[];
  charge: number;
}

/**
 * Bounded, cross-Turn interning of exact effective ordered toolsets. Authority filtering and all
 * live descriptions are read before lookup; neither a Turn id nor a settings revision is a key.
 * Warm production lookups compare immutable declaration identities and the actual rendered text.
 */
export class EffectiveToolDefinitionProjection {
  private readonly snapshots = new Set<ProjectionSnapshot>();
  private bytes = 0;

  public resolve(
    inputs: readonly EffectiveToolDefinitionInput[],
    project: (input: EffectiveToolDefinitionInput) => ReliableAgentToolDefinition
  ): readonly ReliableAgentToolDefinition[] {
    for (const snapshot of this.snapshots) {
      if (inputs.length === snapshot.inputs.length
        && inputs.every((input, index) => sameProjectionInput(input, snapshot.inputs[index]))) {
        this.snapshots.delete(snapshot);
        this.snapshots.add(snapshot);
        return snapshot.definitions;
      }
    }
    const ownedInputs = inputs.map(ownProjectionInput);
    const projected = ownedInputs.map(project);
    // Changed raw inputs may have the same effective output (for example a declaration's native
    // async flag is stripped by frozen policy). This cold path compares individual plain values,
    // never hashes/serializes the full array to discover whether a revision changed.
    let definitions: readonly ReliableAgentToolDefinition[] | undefined;
    for (const snapshot of this.snapshots) {
      if (projected.length === snapshot.definitions.length
        && projected.every((definition, index) => samePlainJsonInput(definition, snapshot.definitions[index]))) {
        definitions = snapshot.definitions;
        this.snapshots.delete(snapshot);
        this.bytes -= snapshot.charge;
        break;
      }
    }
    definitions ??= prepareFrozenToolDefinitions(projected);
    const charge = 512 + frozenToolDefinitionsByteLength(definitions) * 8
      + ownedInputs.reduce((total, input) => total + 128
        + immutableToolDeclarationByteLength(input.definition.declaration) * 8
        + Buffer.byteLength(input.skillDescription ?? '', 'utf8') * 2
        + Buffer.byteLength(input.environmentText ?? '', 'utf8') * 2
        + Buffer.byteLength(input.agentTypeList ?? '', 'utf8') * 2, 0);
    if (Number.isSafeInteger(charge) && charge <= EFFECTIVE_TOOL_DEFINITIONS_CACHE_LIMITS.bytes) {
      const snapshot = { inputs: ownedInputs, definitions, charge };
      this.snapshots.add(snapshot);
      this.bytes += charge;
      while (this.snapshots.size > EFFECTIVE_TOOL_DEFINITIONS_CACHE_LIMITS.entries
        || this.bytes > EFFECTIVE_TOOL_DEFINITIONS_CACHE_LIMITS.bytes) {
        const oldest = this.snapshots.values().next().value!;
        this.snapshots.delete(oldest);
        this.bytes -= oldest.charge;
      }
    }
    return definitions;
  }
}

function sameProjectionInput(left: EffectiveToolDefinitionInput, right: EffectiveToolDefinitionInput): boolean {
  return left.allowChildSpawn === right.allowChildSpawn && left.nativeAsync === right.nativeAsync
    && left.skillDescription === right.skillDescription && left.environmentText === right.environmentText
    && left.agentTypeList === right.agentTypeList
    && sameToolDeclarationProjection(left.definition.declaration, right.definition.declaration);
}

function ownProjectionInput(input: EffectiveToolDefinitionInput): EffectiveToolDefinitionInput {
  // The immutable helper returns trusted production snapshots unchanged. Custom hosts can return
  // the same mutable object or a fresh one each call; own just their model-facing fields.
  if (isImmutableToolDeclaration(input.definition.declaration)) {
    return { ...input, definition: immutableToolDefinition(input.definition) };
  }
  const { name, description, parameters, source, metadata, defaultConfig } = input.definition.declaration;
  return { ...input, definition: immutableToolDefinition({
    ...input.definition,
    declaration: { name, description, parameters: parameters ?? {},
      ...(source ? { source } : {}), ...(metadata ? { metadata } : {}), ...(defaultConfig ? { defaultConfig } : {}) }
  }) };
}
