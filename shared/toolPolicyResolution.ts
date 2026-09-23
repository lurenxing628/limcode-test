import {
  READONLY_CROSS_CONVERSATION_TOOL_NAMES,
  TOOL_POLICY_ALL_MCP_SOURCES,
  type ToolConfigRecord,
  type ToolPolicyPresetKind,
  type ToolPolicyScopeKind,
  type ToolPolicySourceConfigRecord,
  type ToolPolicyToolConfigRecord
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

/**
 * The list a built-in Agent or workflow narrows to while its scope saves no list of its own, and the
 * MCP source restrictions it always carries.
 */
export interface BuiltinToolPolicyLayerValue {
  id?: string;
  allowedTools: readonly string[];
  toolConfigs?: Readonly<Record<string, ToolPolicyToolConfigRecord>>;
  sourceConfigs?: Readonly<Record<string, ToolPolicySourceConfigRecord>>;
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
 * read-only Agent or workflow), or the built-in list alone. A built-in scope's MCP source
 * restrictions always stay in its layer: its all-sources deny wins over whatever the scope saved
 * under that key, and the scope's own saved entries for real source ids apply over the rest, so
 * enabling a source at that Agent or workflow scope is the one way to opt it in. The backend
 * compile and the settings view build every layer here.
 */
export function toolPolicyScopeLayer(
  scopeKind: ToolPolicyScopeKind,
  saved: ToolPolicyLayerValue | undefined,
  builtin: BuiltinToolPolicyLayerValue | undefined
): ToolPolicyLayer | undefined {
  if (saved) {
    if (!builtin) return { scopeKind, policy: saved };
    const builtinDenyAll = builtin.sourceConfigs?.[TOOL_POLICY_ALL_MCP_SOURCES];
    const sourceConfigs = builtin.sourceConfigs || saved.sourceConfigs
      ? {
        ...(builtin.sourceConfigs ?? {}),
        ...(saved.sourceConfigs ?? {}),
        ...(builtinDenyAll ? { [TOOL_POLICY_ALL_MCP_SOURCES]: builtinDenyAll } : {})
      }
      : undefined;
    return {
      scopeKind,
      policy: {
        ...saved,
        ...(saved.allowedTools === undefined ? { allowedTools: builtin.allowedTools } : {}),
        ...(sourceConfigs ? { sourceConfigs } : {})
      }
    };
  }
  if (!builtin) return undefined;
  return {
    scopeKind,
    policy: {
      ...(builtin.id ? { id: builtin.id } : {}),
      allowedTools: builtin.allowedTools,
      ...(builtin.toolConfigs ? { toolConfigs: builtin.toolConfigs } : {}),
      ...(builtin.sourceConfigs ? { sourceConfigs: builtin.sourceConfigs } : {})
    }
  };
}

/**
 * Whether an effective tool list permits one cross-conversation tool. Listing and reading need
 * nothing more; sending, creating and forking act on other conversations and need run_agent in
 * the same list. The backend offers and admits exactly these, and the settings page says so.
 */
export function crossConversationToolPermitted(allowedTools: ReadonlySet<string> | readonly string[], toolName: string): boolean {
  if ((READONLY_CROSS_CONVERSATION_TOOL_NAMES as readonly string[]).includes(toolName)) return true;
  return Array.isArray(allowedTools)
    ? allowedTools.includes(RUN_AGENT_TOOL_NAME)
    : (allowedTools as ReadonlySet<string>).has(RUN_AGENT_TOOL_NAME);
}

const RUN_AGENT_TOOL_NAME = 'run_agent';

/** The source settings that decide one MCP source: its own entry, else an all-sources deny. */
export function mcpSourceConfigFor(sourceConfigs: unknown, sourceId: string): ToolPolicySourceConfigRecord | undefined {
  if (!isPlainRecord(sourceConfigs)) return undefined;
  const config = sourceConfigs[sourceId] ?? sourceConfigs[TOOL_POLICY_ALL_MCP_SOURCES];
  if (!isPlainRecord(config)) return undefined;
  return {
    enabled: config.enabled === true,
    ...(Array.isArray(config.disabledTools)
      ? { disabledTools: config.disabledTools.filter((name): name is string => typeof name === 'string') }
      : {})
  };
}

/**
 * Whether a resolved (frozen) ToolPolicy admits one tool. A built-in tool needs its name in the
 * list. An MCP tool follows its source settings: an enabled source admits every tool it does not
 * disable, a disabled or denied source admits none, and a source no layer configures falls back to
 * the list. Offering, dispatch admission, the MCP policy gate and the settings view all use this.
 */
export function toolAllowedByPolicy(
  policy: { allowedTools: ReadonlySet<string> | readonly string[]; sourceConfigs?: unknown },
  tool: { name: string; source?: { kind?: unknown; sourceId?: unknown } | null }
): boolean {
  const explicitlyAllowed = Array.isArray(policy.allowedTools)
    ? policy.allowedTools.includes(tool.name)
    : (policy.allowedTools as ReadonlySet<string>).has(tool.name);
  const sourceId = tool.source?.kind === 'mcp' && typeof tool.source.sourceId === 'string' ? tool.source.sourceId.trim() : '';
  if (!sourceId) return explicitlyAllowed;
  const config = mcpSourceConfigFor(policy.sourceConfigs, sourceId);
  if (!config) return explicitlyAllowed;
  if (!config.enabled) return false;
  return !(config.disabledTools ?? []).includes(tool.name);
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

/**
 * Merges one layer's MCP source settings. An all-sources entry only denies: every source this layer
 * does not enable itself turns off, and later layers cannot turn it back on (it stays the fallback
 * for sources they name). A stored all-sources value that is not an object fails closed as a deny.
 * The layer's own source entries then apply over what earlier layers left, so they re-enable
 * nothing an ancestor denied.
 */
function mergeSourceConfigs(
  target: Record<string, ToolPolicySourceConfigRecord>,
  source: Readonly<Record<string, ToolPolicySourceConfigRecord>> | undefined
): void {
  const entries = Object.entries(source ?? {}).flatMap(([rawSourceId, incoming]) => {
    const sourceId = rawSourceId.trim();
    if (sourceId === TOOL_POLICY_ALL_MCP_SOURCES && !isPlainRecord(incoming)) {
      return [[sourceId, { enabled: false } as ToolPolicySourceConfigRecord] as const];
    }
    return sourceId && incoming && typeof incoming === 'object' && !Array.isArray(incoming)
      ? [[sourceId, incoming] as const]
      : [];
  });
  const ancestors = { ...target };
  const denyAll = entries.some(([sourceId, incoming]) => sourceId === TOOL_POLICY_ALL_MCP_SOURCES && incoming.enabled !== true);
  if (denyAll) {
    for (const [sourceId, current] of Object.entries(target)) target[sourceId] = { ...current, enabled: false };
    target[TOOL_POLICY_ALL_MCP_SOURCES] = { enabled: false };
  }
  for (const [sourceId, incoming] of entries) {
    if (sourceId === TOOL_POLICY_ALL_MCP_SOURCES) continue;
    const current = ancestors[sourceId] ?? ancestors[TOOL_POLICY_ALL_MCP_SOURCES];
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
