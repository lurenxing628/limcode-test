import type { ContentAddressedStore } from './contentAddressedStore';
import { frozenWorkEnvironmentPolicy, readFrozenTurnAuthority } from './frozenAuthority';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import type { FrozenWorkEnvironmentBoundaryPolicy } from './workEnvironmentBoundary';
import {
  ALLOW_OUTSIDE_PROJECT_PATHS_CONFIG_KEY,
  TOOL_POLICY_ALL_MCP_SOURCES,
  type SkillPolicySourceConfigRecord,
  type SkillSource,
  type ToolConfigRecord,
  type ToolPolicySourceConfigRecord,
  type ToolPolicyToolConfigRecord
} from '../../shared/protocol';
import { mcpSourceConfigFor, type ResolvedToolPolicy } from '../../shared/toolPolicyResolution';
import {
  DEFAULT_MAX_CHILD_AGENT_DEPTH,
  MAX_CHILD_AGENT_DEPTH_CONFIG_KEY
} from '../world/modules/tools/definitions/runAgent';

/**
 * The tool policy one Turn froze, as a child Turn inherits it. `inherited` is that Turn's own
 * parent bound, so the chain reaches the top-level conversation.
 */
export interface FrozenToolPolicyDocument {
  id: string | null;
  allowedTools: string[];
  preset: string;
  toolConfigs: Record<string, ToolPolicyToolConfigRecord>;
  sourceConfigs: Record<string, ToolPolicySourceConfigRecord>;
  inherited?: FrozenToolPolicyDocument;
}

export interface BoundToolPolicy extends ResolvedToolPolicy {
  inherited?: FrozenToolPolicyDocument;
}

/** One ancestor's settings for approvals and command rules, nearest first. */
export interface InheritedToolPolicyLayer {
  preset: string;
  toolConfigs: Record<string, ToolPolicyToolConfigRecord>;
}

export type SkillSourceConfigs = Partial<Record<SkillSource, SkillPolicySourceConfigRecord>>;

/** The skill settings one Turn froze, as a child Turn inherits them (already bounded by its own parent). */
export interface FrozenSkillPolicyDocument {
  id: string | null;
  sourceConfigs: SkillSourceConfigs;
}

export interface BoundSkillPolicy extends FrozenSkillPolicyDocument {
  inherited?: FrozenSkillPolicyDocument;
}

/** What a child execution inherited from the parent Turn that spawned it. */
export interface ChildExecutionBoundary {
  toolPolicy?: FrozenToolPolicyDocument;
  skillPolicy?: FrozenSkillPolicyDocument;
}

/** Nesting deeper than this is a corrupt snapshot, not a real Agent tree. */
const MAX_INHERITED_DEPTH = 64;

/**
 * A child Turn's tools: its own resolved policy intersected with the parent Turn's frozen policy.
 * Nothing the parent lacks is added back, whatever the child's Agent, workflow or conversation
 * settings say.
 *
 * - Built-in tools: in both lists. A child answers its parent with its final output, not a tool.
 * - MCP tools: the source is enabled on both sides; `enabledTools` lists intersect and
 *   `disabledTools` add up; a source the parent never enabled stays off.
 * - Settings that decide whether something may run at all, merged exactly: a path outside the
 *   project (`allowOutsideProjectPaths`) and ask_user/submit_plan auto-approval (`autoApprove`)
 *   need both sides; `denyCommands` add up; `maxChildAgentDepth` takes the smaller depth.
 * - Execution approval, automatic change application, automatic result submission and
 *   `allowCommands` depend on the call, so they stay per side: `inherited` keeps the parent's
 *   policy and dispatch requires every side on the chain to agree (`inheritedToolPolicyChain`).
 * - Tool parameters, display settings, native async and the preset stay the child's own.
 */
export function boundChildToolPolicy(own: ResolvedToolPolicy, parent: FrozenToolPolicyDocument): BoundToolPolicy {
  const parentTools = new Set(parent.allowedTools);
  return {
    ...own,
    allowedTools: own.allowedTools.filter((name) => parentTools.has(name)),
    toolConfigs: intersectToolConfigs(own.toolConfigs, parent.toolConfigs),
    sourceConfigs: intersectSourceConfigs(own.sourceConfigs, parent.sourceConfigs),
    inherited: clonePlain(parent)
  };
}

/**
 * The tool policy frozen in one AuthoritySnapshot document, with its own inherited chain. A Turn
 * that froze no tool policy could call no tool, so as a bound it allows nothing.
 */
export function frozenToolPolicyDocument(document: PlainJsonValue): FrozenToolPolicyDocument {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  if (authority.toolPolicy === undefined) {
    return { id: null, allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} };
  }
  return parseToolPolicy(authority.toolPolicy, 'AuthoritySnapshot.toolPolicy', 0);
}

/** The parent bound a child Turn froze; undefined for a top-level Turn or a legacy snapshot. */
export function frozenInheritedToolPolicy(document: PlainJsonValue): FrozenToolPolicyDocument | undefined {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  if (authority.toolPolicy === undefined) return undefined;
  const policy = requireRecord(authority.toolPolicy, 'AuthoritySnapshot.toolPolicy');
  return policy.inherited === undefined
    ? undefined
    : parseToolPolicy(policy.inherited, 'AuthoritySnapshot.toolPolicy.inherited', 1);
}

/**
 * A child Turn's skills: a skill is off when either side turns it off — its source disabled or the
 * skill listed in `disabledSkills` — the same opt-out rule as `isSkillEnabledByPolicy`. The parent's
 * frozen settings already include its own parent's, so one level of `inherited` is enough.
 */
export function boundChildSkillPolicy(own: FrozenSkillPolicyDocument, parent: FrozenSkillPolicyDocument): BoundSkillPolicy {
  const sourceConfigs: SkillSourceConfigs = {};
  const sources = new Set([...Object.keys(own.sourceConfigs), ...Object.keys(parent.sourceConfigs)] as SkillSource[]);
  for (const source of [...sources].sort()) {
    const mine = own.sourceConfigs[source];
    const theirs = parent.sourceConfigs[source];
    if (!mine && !theirs) continue;
    const disabledSkills = [...new Set([...(mine?.disabledSkills ?? []), ...(theirs?.disabledSkills ?? [])])].sort();
    sourceConfigs[source] = {
      enabled: mine?.enabled !== false && theirs?.enabled !== false,
      ...(disabledSkills.length > 0 ? { disabledSkills } : {})
    };
  }
  return { id: own.id, sourceConfigs, inherited: clonePlain(parent) };
}

/**
 * The skill settings frozen in one AuthoritySnapshot document, as a bound for its child. A Turn
 * that froze none had every skill on (skills are opt-out).
 */
export function frozenSkillPolicyDocument(document: PlainJsonValue): FrozenSkillPolicyDocument {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  if (authority.skillPolicy === undefined || authority.skillPolicy === null) return { id: null, sourceConfigs: {} };
  return parseSkillPolicy(authority.skillPolicy, 'AuthoritySnapshot.skillPolicy');
}

/** The parent skill bound a child Turn froze; undefined for a top-level Turn or a legacy snapshot. */
export function frozenInheritedSkillPolicy(document: PlainJsonValue): FrozenSkillPolicyDocument | undefined {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  if (authority.skillPolicy === undefined || authority.skillPolicy === null) return undefined;
  const policy = requireRecord(authority.skillPolicy, 'AuthoritySnapshot.skillPolicy');
  return policy.inherited === undefined
    ? undefined
    : parseSkillPolicy(policy.inherited, 'AuthoritySnapshot.skillPolicy.inherited');
}

/** Every ancestor's preset and per-tool settings, nearest first; empty for a top-level Turn. */
export function inheritedToolPolicyChain(toolPolicy: unknown): InheritedToolPolicyLayer[] {
  const chain: InheritedToolPolicyLayer[] = [];
  let current = requireRecord(toolPolicy, 'AuthoritySnapshot.toolPolicy').inherited;
  let label = 'AuthoritySnapshot.toolPolicy.inherited';
  while (current !== undefined) {
    if (chain.length >= MAX_INHERITED_DEPTH) throw new TypeError(`${label} is nested too deeply.`);
    const layer = requireRecord(current, label);
    chain.push({
      preset: typeof layer.preset === 'string' ? layer.preset : 'custom',
      toolConfigs: layer.toolConfigs === undefined
        ? {}
        : requireRecord(layer.toolConfigs, `${label}.toolConfigs`) as unknown as Record<string, ToolPolicyToolConfigRecord>
    });
    current = layer.inherited;
    label = `${label}.inherited`;
  }
  return chain;
}

/**
 * What one ChildExecution inherited when it was spawned: the tool and skill settings its first Turn
 * froze from the parent Turn. Every later Turn of the child, whoever starts it, uses the same bound,
 * so a Turn started by the user in the child conversation cannot widen what later ones get.
 */
export async function readChildExecutionBoundary(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  childExecutionId: string
): Promise<ChildExecutionBoundary> {
  const document = await readChildTurnDocument(database, contentStore, childExecutionId, 'asc');
  const toolPolicy = frozenInheritedToolPolicy(document);
  const skillPolicy = frozenInheritedSkillPolicy(document);
  return { ...(toolPolicy ? { toolPolicy } : {}), ...(skillPolicy ? { skillPolicy } : {}) };
}

/**
 * The work-environment boundary of a child's latest Turn, which the next one inherits: the rule a
 * continuation from the parent or a teammate already follows, now also used for Turns the user
 * starts in the child conversation.
 */
export async function readChildExecutionWorkEnvironmentBoundary(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  childExecutionId: string
): Promise<FrozenWorkEnvironmentBoundaryPolicy | undefined> {
  return frozenWorkEnvironmentPolicy(await readChildTurnDocument(database, contentStore, childExecutionId, 'desc'));
}

/** The frozen authority of a child's first ('asc') or latest ('desc') Turn. */
async function readChildTurnDocument(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  childExecutionId: string,
  direction: 'asc' | 'desc'
): Promise<PlainJsonValue> {
  const links = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').list({
      where: { child_execution_id: childExecutionId },
      orderBy: { column: 'turn_seq', direction },
      limit: 1
    })
  ]);
  const link = (links.snapshot[0] as Array<Record<string, unknown>> | undefined)?.[0];
  if (!link) throw new Error(`ChildExecution ${childExecutionId} has no Turn lineage.`);
  const turnId = String(link.turn_id);
  const snapshots = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').list({ where: { turn_id: turnId }, limit: 2 })
  ]);
  const rows = snapshots.snapshot[0] as Array<Record<string, unknown>> | undefined;
  if (!rows || rows.length !== 1) throw new Error(`Child Turn ${turnId} must have exactly one AuthoritySnapshot.`);
  return (await readFrozenTurnAuthority(database, contentStore, String(rows[0].id), turnId)).document;
}

function parseSkillPolicy(value: unknown, label: string): FrozenSkillPolicyDocument {
  const policy = requireRecord(value, label);
  return {
    id: typeof policy.id === 'string' ? policy.id : null,
    sourceConfigs: policy.sourceConfigs === undefined || policy.sourceConfigs === null
      ? {}
      : clonePlain(requireRecord(policy.sourceConfigs, `${label}.sourceConfigs`)) as SkillSourceConfigs
  };
}

function parseToolPolicy(value: unknown, label: string, depth: number): FrozenToolPolicyDocument {
  if (depth > MAX_INHERITED_DEPTH) throw new TypeError(`${label} is nested too deeply.`);
  const policy = requireRecord(value, label);
  if (!Array.isArray(policy.allowedTools) || policy.allowedTools.some((name) => typeof name !== 'string')) {
    throw new TypeError(`${label}.allowedTools must be an array of tool names.`);
  }
  return {
    id: typeof policy.id === 'string' ? policy.id : null,
    allowedTools: [...policy.allowedTools as string[]],
    preset: typeof policy.preset === 'string' ? policy.preset : 'custom',
    toolConfigs: policy.toolConfigs === undefined
      ? {}
      : clonePlain(requireRecord(policy.toolConfigs, `${label}.toolConfigs`)) as Record<string, ToolPolicyToolConfigRecord>,
    sourceConfigs: policy.sourceConfigs === undefined
      ? {}
      : clonePlain(requireRecord(policy.sourceConfigs, `${label}.sourceConfigs`)) as Record<string, ToolPolicySourceConfigRecord>,
    ...(policy.inherited === undefined
      ? {}
      : { inherited: parseToolPolicy(policy.inherited, `${label}.inherited`, depth + 1) })
  };
}

/**
 * Per source: enabled on both sides, `enabledTools` intersected, `disabledTools` added up. A source
 * either side leaves unconfigured (and not covered by its all-sources deny) admits nothing, so it
 * is written as disabled; an all-sources deny on either side stays.
 */
function intersectSourceConfigs(
  own: Record<string, ToolPolicySourceConfigRecord>,
  parent: Record<string, ToolPolicySourceConfigRecord>
): Record<string, ToolPolicySourceConfigRecord> {
  const result: Record<string, ToolPolicySourceConfigRecord> = {};
  const sourceIds = new Set([...Object.keys(own), ...Object.keys(parent)]);
  sourceIds.delete(TOOL_POLICY_ALL_MCP_SOURCES);
  for (const sourceId of [...sourceIds].sort()) {
    const mine = mcpSourceConfigFor(own, sourceId);
    const theirs = mcpSourceConfigFor(parent, sourceId);
    if (!mine?.enabled || !theirs?.enabled) {
      result[sourceId] = { enabled: false };
      continue;
    }
    const enabledTools = mine.enabledTools && theirs.enabledTools
      ? mine.enabledTools.filter((name) => theirs.enabledTools!.includes(name)).sort()
      : (mine.enabledTools ?? theirs.enabledTools)?.slice().sort();
    const disabledTools = [...new Set([...(mine.disabledTools ?? []), ...(theirs.disabledTools ?? [])])].sort();
    result[sourceId] = {
      enabled: true,
      ...(enabledTools ? { enabledTools } : {}),
      ...(disabledTools.length > 0 ? { disabledTools } : {})
    };
  }
  if (own[TOOL_POLICY_ALL_MCP_SOURCES] !== undefined || parent[TOOL_POLICY_ALL_MCP_SOURCES] !== undefined) {
    result[TOOL_POLICY_ALL_MCP_SOURCES] = { enabled: false };
  }
  return result;
}

type ConfigRule = 'both' | 'union' | 'min';

/** Config keys that decide whether something may run at all, and how two sides combine. */
const BOUNDED_CONFIG_KEYS: ReadonlyArray<readonly [string, ConfigRule]> = [
  [ALLOW_OUTSIDE_PROJECT_PATHS_CONFIG_KEY, 'both'],
  ['autoApprove', 'both'],
  ['denyCommands', 'union'],
  [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY, 'min']
];

function intersectToolConfigs(
  own: Record<string, ToolPolicyToolConfigRecord>,
  parent: Record<string, ToolPolicyToolConfigRecord>
): Record<string, ToolPolicyToolConfigRecord> {
  const result = clonePlain(own);
  for (const key of new Set([...Object.keys(own), ...Object.keys(parent)])) {
    const mine = own[key]?.config;
    const theirs = parent[key]?.config;
    let merged: ToolConfigRecord | undefined;
    for (const [configKey, rule] of BOUNDED_CONFIG_KEYS) {
      const a = mine?.[configKey];
      const b = theirs?.[configKey];
      if (a === undefined && b === undefined) continue;
      merged ??= { ...(result[key]?.config ?? {}) };
      const value = combine(rule, a, b);
      if (value === undefined) delete merged[configKey];
      else merged[configKey] = value;
    }
    if (merged) result[key] = { ...(result[key] ?? {}), config: merged };
  }
  return result;
}

/**
 * 'both': a boolean that defaults the same on both sides — false if either says false, true only
 * if both say true, otherwise left to the default. 'union': command lists add up. 'min': the
 * smaller child depth, an unset side counting as the default depth.
 */
function combine(rule: ConfigRule, a: unknown, b: unknown): ToolConfigRecord[string] | undefined {
  if (rule === 'both') {
    if (a === false || b === false) return false;
    return a === true && b === true ? true : undefined;
  }
  if (rule === 'union') {
    const names = [...stringList(a), ...stringList(b)];
    return [...new Set(names)];
  }
  const depth = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : DEFAULT_MAX_CHILD_AGENT_DEPTH;
  return Math.min(depth(a), depth(b));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry.trim()] : []);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
