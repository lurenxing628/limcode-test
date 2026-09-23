import {
  CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY,
  CROSS_CONVERSATION_TOOL_NAMES,
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
 * belong to it (their source configs alone admit them), nor do the tools the cross-conversation
 * switch grants.
 */
export function defaultToolNames(definitions: readonly ToolPolicyCatalogEntry[]): string[] {
  return uniqueNames(definitions
    .filter((tool) => tool.source?.kind !== 'mcp' && tool.metadata?.defaultEnabled !== false && !isSwitchGrantedTool(tool.name))
    .map((tool) => tool.name));
}

/**
 * The cross-conversation tools. The user's frozen switch grants them (see `toolAllowedByPolicy`):
 * no tool list controls them, and a name of theirs saved in a list is ignored.
 */
export function isSwitchGrantedTool(name: string): boolean {
  return (CROSS_CONVERSATION_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * The cross-conversation switch in resolved per-tool settings. Only a literal `true` turns it on;
 * any other stored value fails closed.
 */
export function crossConversationSwitchOn(toolConfigs: unknown): boolean {
  if (!isPlainRecord(toolConfigs)) return false;
  const runAgent = toolConfigs[RUN_AGENT_TOOL_NAME];
  return isPlainRecord(runAgent) && isPlainRecord(runAgent.config)
    && runAgent.config[CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY] === true;
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
 * Whether an effective tool list permits one cross-conversation tool while the switch is on.
 * Listing and reading need nothing more; sending, creating and forking act on other conversations
 * and need run_agent in the same list. The backend offers and admits exactly these, and the
 * settings page says so.
 */
export function crossConversationToolPermitted(allowedTools: ReadonlySet<string> | readonly string[], toolName: string): boolean {
  if ((READONLY_CROSS_CONVERSATION_TOOL_NAMES as readonly string[]).includes(toolName)) return true;
  return Array.isArray(allowedTools)
    ? allowedTools.includes(RUN_AGENT_TOOL_NAME)
    : (allowedTools as ReadonlySet<string>).has(RUN_AGENT_TOOL_NAME);
}

const RUN_AGENT_TOOL_NAME = 'run_agent';

/** The parts of a tool that identify it to the tool policy. */
export interface ToolPolicyTool {
  name: string;
  source?: { kind?: unknown; sourceId?: unknown; originalToolName?: unknown } | null;
}

/**
 * An MCP tool's stable identity: its source id and the name the server itself gives the tool. The
 * display name the model sees can move to another server's tool when servers connect, disconnect or
 * are removed, so no saved setting uses it.
 */
export function mcpToolIdentity(tool: ToolPolicyTool): { sourceId: string; toolName: string } | undefined {
  if (tool.source?.kind !== 'mcp') return undefined;
  const sourceId = typeof tool.source.sourceId === 'string' ? tool.source.sourceId.trim() : '';
  const toolName = typeof tool.source.originalToolName === 'string' ? tool.source.originalToolName : '';
  return sourceId && toolName ? { sourceId, toolName } : undefined;
}

/**
 * The key a tool's per-tool settings are saved under in `toolConfigs`: a built-in tool's name, and
 * for an MCP tool `mcp:<source id>/<original tool name>` (the source id URI-encoded so the key
 * splits one way only). An MCP tool without an identity gets no key that any saved entry uses.
 */
export function toolConfigKey(tool: ToolPolicyTool): string {
  if (tool.source?.kind !== 'mcp') return tool.name;
  const identity = mcpToolIdentity(tool);
  return identity ? `mcp:${encodeURIComponent(identity.sourceId)}/${identity.toolName}` : '';
}

/** One tool's resolved per-tool settings, found by `toolConfigKey`. */
export function toolConfigFor<T>(toolConfigs: Readonly<Record<string, T>> | undefined, tool: ToolPolicyTool): T | undefined {
  const key = toolConfigKey(tool);
  return key && toolConfigs && Object.prototype.hasOwnProperty.call(toolConfigs, key) ? toolConfigs[key] : undefined;
}

/** The source settings that decide one MCP source: its own entry, else an all-sources deny. */
export function mcpSourceConfigFor(sourceConfigs: unknown, sourceId: string): ToolPolicySourceConfigRecord | undefined {
  if (!isPlainRecord(sourceConfigs)) return undefined;
  const config = sourceConfigs[sourceId] ?? sourceConfigs[TOOL_POLICY_ALL_MCP_SOURCES];
  if (!isPlainRecord(config)) return undefined;
  return {
    enabled: config.enabled === true,
    ...(Array.isArray(config.enabledTools)
      ? { enabledTools: config.enabledTools.filter((name): name is string => typeof name === 'string') }
      : {}),
    ...(Array.isArray(config.disabledTools)
      ? { disabledTools: config.disabledTools.filter((name): name is string => typeof name === 'string') }
      : {})
  };
}

/**
 * Whether resolved source settings admit one of the source's tools (by its original name): the
 * source is enabled, the tool is in `enabledTools` when that allowlist is present, and it is not in
 * `disabledTools`. The backend and the settings page decide every MCP tool here.
 */
export function mcpSourceAdmits(config: ToolPolicySourceConfigRecord | undefined, toolName: string): boolean {
  if (!config?.enabled) return false;
  if (config.enabledTools && !config.enabledTools.includes(toolName)) return false;
  return !(config.disabledTools ?? []).includes(toolName);
}

/**
 * Whether a resolved (frozen) ToolPolicy admits one tool. A built-in tool needs its name in the
 * list, except the cross-conversation tools: the switch in the per-tool settings grants them, with
 * the run_agent rule of `crossConversationToolPermitted`, whatever the list names. An MCP tool
 * follows only its source settings, by source id and original tool name (`mcpToolIdentity`): an
 * enabled source admits the tools in its `enabledTools` allowlist when it has one, else every tool,
 * minus the ones it disables; a disabled, denied or unconfigured source admits none; tool lists
 * never admit an MCP tool. Offering, dispatch admission, the
 * provider adapter, the token estimate, the MCP policy gate and the settings view all use this;
 * offering and admission also keep the cross-conversation tools to top-level conversations.
 */
export function toolAllowedByPolicy(
  policy: { allowedTools: ReadonlySet<string> | readonly string[]; sourceConfigs?: unknown; toolConfigs?: unknown },
  tool: ToolPolicyTool
): boolean {
  if (tool.source?.kind === 'mcp') {
    const identity = mcpToolIdentity(tool);
    return !!identity && mcpSourceAdmits(mcpSourceConfigFor(policy.sourceConfigs, identity.sourceId), identity.toolName);
  }
  if (isSwitchGrantedTool(tool.name)) {
    return crossConversationSwitchOn(policy.toolConfigs) && crossConversationToolPermitted(policy.allowedTools, tool.name);
  }
  return Array.isArray(policy.allowedTools)
    ? policy.allowedTools.includes(tool.name)
    : (policy.allowedTools as ReadonlySet<string>).has(tool.name);
}

/**
 * Compiles raw settings layers in canonical low-to-high order.
 *
 * Capability lists are monotone: every layer with a list is an upper bound and may only narrow the
 * tools admitted by an earlier layer; a layer without a list narrows nothing. When no layer on the
 * chain has a list, the base is `defaultTools` (see `defaultToolNames`). Names of the tools the
 * cross-conversation switch grants are ignored in every list, so the result never holds them. A stored list that is
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
      const ceiling = new Set(uniqueNames(list).filter((name) => !isSwitchGrantedTool(name)));
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
    allowedTools: [...(allowed ?? new Set(uniqueNames(defaultTools).filter((name) => !isSwitchGrantedTool(name))))].sort(),
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
 * nothing an ancestor denied: disables add up and `enabledTools` allowlists intersect.
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
    // Allowlists only narrow: each layer that has one keeps the tools every such layer names.
    const enabledTools = current?.enabledTools && incoming.enabledTools
      ? uniqueNames(incoming.enabledTools).filter((name) => current.enabledTools!.includes(name)).sort()
      : (current?.enabledTools ?? (incoming.enabledTools ? uniqueNames(incoming.enabledTools).sort() : undefined));
    target[sourceId] = {
      enabled: current ? current.enabled && incoming.enabled === true : incoming.enabled === true,
      ...(enabledTools ? { enabledTools } : {}),
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
