import type {
  ToolConfigRecord,
  ToolPolicyPresetKind,
  ToolPolicyScopeKind,
  ToolPolicySourceConfigRecord,
  ToolPolicyToolConfigRecord
} from './protocol';

export type ResolvedToolPolicyPreset = Exclude<ToolPolicyPresetKind, 'inherit'>;

export interface ToolPolicyLayerValue {
  id?: string;
  /** Absent: this layer sets per-tool settings only and narrows nothing. Any other non-list value fails closed. */
  allowedTools?: readonly string[];
  preset?: ToolPolicyPresetKind;
  toolConfigs?: Readonly<Record<string, ToolPolicyToolConfigRecord>>;
  sourceConfigs?: Readonly<Record<string, ToolPolicySourceConfigRecord>>;
}

export interface ToolPolicyLayer {
  scopeKind: ToolPolicyScopeKind;
  policy: ToolPolicyLayerValue;
}

/** The list a built-in Agent or workflow narrows to while its scope saves no list of its own. */
export interface BuiltinToolPolicyLayerValue {
  id?: string;
  allowedTools: readonly string[];
  toolConfigs?: Readonly<Record<string, ToolPolicyToolConfigRecord>>;
}

/** The parts of a tool definition that decide whether it belongs to the default tool set. */
export interface ToolPolicyCatalogEntry {
  name: string;
  source?: { kind?: string };
  metadata?: { defaultEnabled?: boolean };
}

export interface ResolvedToolPolicy {
  id: string | null;
  allowedTools: string[];
  preset: ResolvedToolPolicyPreset;
  toolConfigs: Record<string, ToolPolicyToolConfigRecord>;
  sourceConfigs: Record<string, ToolPolicySourceConfigRecord>;
}

/**
 * The default tool set: what a scope gets while no layer on its chain saves a list. MCP tools never
 * belong to it; their source configs alone admit them.
 */
export function defaultToolNames(definitions: readonly ToolPolicyCatalogEntry[]): string[] {
  return uniqueNames(definitions
    .filter((tool) => tool.source?.kind !== 'mcp' && tool.metadata?.defaultEnabled !== false)
    .map((tool) => tool.name));
}

/**
 * One settings scope as a layer: the saved record, a saved record without a list keeping the
 * scope's built-in list (so settings that only store per-tool config never widen a built-in
 * read-only Agent or workflow), or the built-in list alone. The backend compile and the settings
 * view build every layer here.
 */
export function toolPolicyScopeLayer(
  scopeKind: ToolPolicyScopeKind,
  saved: ToolPolicyLayerValue | undefined,
  builtin: BuiltinToolPolicyLayerValue | undefined
): ToolPolicyLayer | undefined {
  if (saved) {
    const policy = saved.allowedTools !== undefined || !builtin ? saved : { ...saved, allowedTools: builtin.allowedTools };
    return { scopeKind, policy };
  }
  if (!builtin) return undefined;
  return {
    scopeKind,
    policy: {
      ...(builtin.id ? { id: builtin.id } : {}),
      allowedTools: builtin.allowedTools,
      ...(builtin.toolConfigs ? { toolConfigs: builtin.toolConfigs } : {})
    }
  };
}

/**
 * Compiles raw settings layers in canonical low-to-high order.
 *
 * Capability lists are monotone: every layer with a list is an upper bound and may only narrow the
 * tools admitted by an earlier layer; a layer without a list narrows nothing. When no layer on the
 * chain has a list, the base is `defaultTools` (see `defaultToolNames`). A stored list that is
 * neither absent nor an array of names fails closed instead of narrowing nothing. YOLO changes
 * approval/application behavior only; it never widens a Global/Agent/Workflow capability boundary.
 * `inherit` (and the pre-preset shape where preset is absent) inherits only the Global execution
 * preset, while the layer's allowedTools and per-tool settings remain active.
 *
 * MCP source denies are also monotone: a disabled ancestor or disabled tool cannot be re-enabled
 * by a more specific layer. Per-tool settings are ordinary low-to-high overrides, with deep merge
 * for config/display objects so an empty local record does not erase Global defaults.
 */
export function resolveToolPolicyLayers(
  layersInput: readonly ToolPolicyLayer[],
  defaultTools: readonly string[]
): ResolvedToolPolicy {
  const layers = [...layersInput];
  const globalLayer = layers.find((layer) => layer.scopeKind === 'global');
  const globalPreset = explicitPreset(globalLayer?.policy.preset) ?? 'custom';
  let preset: ResolvedToolPolicyPreset = globalPreset;

  let allowed: Set<string> | undefined;
  const toolConfigs: Record<string, ToolPolicyToolConfigRecord> = {};
  const sourceConfigs: Record<string, ToolPolicySourceConfigRecord> = {};

  for (const layer of layers) {
    const rawPreset = layer.policy.preset;
    if (layer.scopeKind === 'global') {
      preset = globalPreset;
    } else {
      preset = explicitPreset(rawPreset) ?? globalPreset;
    }

    const list = layerAllowedTools(layer);
    if (list) {
      const ceiling = new Set(uniqueNames(list));
      allowed = allowed ? new Set([...allowed].filter((name) => ceiling.has(name))) : ceiling;
    }

    mergeToolConfigs(toolConfigs, layer.policy.toolConfigs);
    mergeSourceConfigs(sourceConfigs, layer.policy.sourceConfigs);
  }

  const id = [...layers]
    .reverse()
    .map((layer) => layer.policy.id?.trim())
    .find((value): value is string => !!value) ?? null;

  return {
    id,
    allowedTools: [...(allowed ?? new Set(uniqueNames(defaultTools)))].sort(),
    preset,
    toolConfigs,
    sourceConfigs
  };
}

/** A layer's list, or undefined when it saves none; a hand-edited non-list value fails closed. */
function layerAllowedTools(layer: ToolPolicyLayer): readonly string[] | undefined {
  const value: unknown = layer.policy.allowedTools;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    throw new TypeError(`工具策略 ${layer.policy.id?.trim() || layer.scopeKind} 的 allowedTools 必须是工具名数组。`);
  }
  return value as readonly string[];
}

function explicitPreset(value: ToolPolicyPresetKind | undefined): ResolvedToolPolicyPreset | undefined {
  return value === 'custom' || value === 'yolo' ? value : undefined;
}

function uniqueNames(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const name = value.trim();
    if (name && !result.includes(name)) result.push(name);
  }
  return result;
}

function mergeToolConfigs(
  target: Record<string, ToolPolicyToolConfigRecord>,
  source: Readonly<Record<string, ToolPolicyToolConfigRecord>> | undefined
): void {
  for (const [rawToolName, incoming] of Object.entries(source ?? {})) {
    const toolName = rawToolName.trim();
    if (!toolName || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue;
    const current = target[toolName];
    target[toolName] = {
      config: mergeToolConfigRecords(current?.config, incoming.config),
      ...(incoming.autoApproveExecution !== undefined
        ? { autoApproveExecution: incoming.autoApproveExecution }
        : current?.autoApproveExecution !== undefined
          ? { autoApproveExecution: current.autoApproveExecution }
          : {}),
      ...(incoming.autoApplyChange !== undefined
        ? { autoApplyChange: incoming.autoApplyChange }
        : current?.autoApplyChange !== undefined
          ? { autoApplyChange: current.autoApplyChange }
          : {}),
      ...(incoming.autoApplyChangeDelaySeconds !== undefined
        ? { autoApplyChangeDelaySeconds: incoming.autoApplyChangeDelaySeconds }
        : current?.autoApplyChangeDelaySeconds !== undefined
          ? { autoApplyChangeDelaySeconds: current.autoApplyChangeDelaySeconds }
          : {}),
      ...(incoming.autoSubmitResult !== undefined
        ? { autoSubmitResult: incoming.autoSubmitResult }
        : current?.autoSubmitResult !== undefined
          ? { autoSubmitResult: current.autoSubmitResult }
          : {}),
      ...(incoming.nativeAsync !== undefined
        ? { nativeAsync: incoming.nativeAsync }
        : current?.nativeAsync !== undefined
          ? { nativeAsync: current.nativeAsync }
          : {}),
      ...(current?.display || incoming.display
        ? { display: { ...(current?.display ?? {}), ...(incoming.display ?? {}) } }
        : {})
    };
  }
}

function mergeSourceConfigs(
  target: Record<string, ToolPolicySourceConfigRecord>,
  source: Readonly<Record<string, ToolPolicySourceConfigRecord>> | undefined
): void {
  for (const [rawSourceId, incoming] of Object.entries(source ?? {})) {
    const sourceId = rawSourceId.trim();
    if (!sourceId || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue;
    const current = target[sourceId];
    const disabledTools = uniqueNames([
      ...(current?.disabledTools ?? []),
      ...(incoming.disabledTools ?? [])
    ]).sort();
    target[sourceId] = {
      enabled: current ? current.enabled && incoming.enabled === true : incoming.enabled === true,
      ...(disabledTools.length > 0 ? { disabledTools } : {})
    };
  }
}

function mergeToolConfigRecords(base: ToolConfigRecord | undefined, override: ToolConfigRecord | undefined): ToolConfigRecord {
  const result: ToolConfigRecord = cloneRecord(base);
  for (const [key, value] of Object.entries(override ?? {})) {
    const previous = result[key];
    result[key] = isPlainRecord(previous) && isPlainRecord(value)
      ? mergeUnknownRecords(previous, value)
      : cloneValue(value);
  }
  return result;
}

function mergeUnknownRecords(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = cloneUnknownRecord(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainRecord(result[key]) && isPlainRecord(value)
      ? mergeUnknownRecords(result[key] as Record<string, unknown>, value)
      : cloneUnknownValue(value);
  }
  return result;
}

function cloneRecord(value: ToolConfigRecord | undefined): ToolConfigRecord {
  const result: ToolConfigRecord = {};
  for (const [key, child] of Object.entries(value ?? {})) result[key] = cloneValue(child);
  return result;
}

function cloneValue<T>(value: T): T {
  return cloneUnknownValue(value) as T;
}

function cloneUnknownRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneUnknownValue(child)]));
}

function cloneUnknownValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneUnknownValue);
  if (isPlainRecord(value)) return cloneUnknownRecord(value);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
