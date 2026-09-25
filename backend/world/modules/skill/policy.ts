import type { SkillCatalogCapability } from '../../../capabilities/types';
import type { SkillDefinitionRecord, SkillPolicyRecord, SkillPolicySourceConfigRecord, SkillSource } from '../../../../shared/protocol';
import { lookupSkillWithTier, SKILL_SOURCE_PRIORITY } from './skillLookup';

export { SKILL_SOURCE_PRIORITY } from './skillLookup';

/**
 * 技能默认全部启用（opt-out）。
 * 仅当来源分组显式关闭（enabled=false），或该技能被列入 disabledSkills 时才停用。
 */
export function isSkillEnabledByPolicy(
  policy: Pick<SkillPolicyRecord, 'sourceConfigs'> | undefined,
  skill: Pick<SkillDefinitionRecord, 'id' | 'source'>
): boolean {
  const config = policy?.sourceConfigs?.[skill.source];
  if (!config) return true;
  if (config.enabled === false) return false;
  return !(Array.isArray(config.disabledSkills) ? config.disabledSkills : []).includes(skill.id);
}

/**
 * A skill policy's per-source settings, checked strictly: each key is a skill source and each value
 * `{ enabled: boolean, disabledSkills?: string[] }`. Saving, freezing and bounding a child all read
 * settings through this, so a malformed list can never be spread into characters and re-enable a
 * skill the parent turned off.
 */
export function requireSkillSourceConfigs(
  value: unknown,
  label: string
): Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object.`);
  const result: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> = {};
  for (const [source, config] of Object.entries(value)) {
    if (!(SKILL_SOURCE_PRIORITY as readonly string[]).includes(source)) throw new TypeError(`${label}.${source} is not a skill source.`);
    if (!isPlainRecord(config)) throw new TypeError(`${label}.${source} must be an object.`);
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new TypeError(`${label}.${source}.enabled must be a boolean.`);
    const disabled = config.disabledSkills;
    if (disabled !== undefined && (!Array.isArray(disabled) || disabled.some((id) => typeof id !== 'string' || !id.trim()))) {
      throw new TypeError(`${label}.${source}.disabledSkills must be an array of skill ids.`);
    }
    const disabledSkills = [...new Set((disabled ?? []) as string[])];
    result[source as SkillSource] = {
      enabled: config.enabled !== false,
      ...(disabledSkills.length > 0 ? { disabledSkills } : {})
    };
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The skill catalog as one Turn's frozen policy sees it: a skill the policy turns off cannot be
 * found or read, just as it is left out of the skills tool description. A name resolves among the
 * enabled skills only, so it finds the same skill the list shows even when a higher-priority source
 * has a disabled skill of that name; a name that only matches disabled skills reports which one.
 */
export function skillCatalogWithinPolicy(
  catalog: SkillCatalogCapability,
  policy: Pick<SkillPolicyRecord, 'sourceConfigs'> | undefined
): SkillCatalogCapability {
  const list = () => catalog.list().filter((skill) => isSkillEnabledByPolicy(policy, skill));
  return {
    list,
    lookup(name, source) {
      const all = catalog.list();
      const namespaces = new Set(all.flatMap((skill) => (skill.namespace ? [skill.namespace] : [])));
      const enabled = lookupSkillWithTier(all.filter((skill) => isSkillEnabledByPolicy(policy, skill)), name, source, { namespaces });
      const any = lookupSkillWithTier(all, name, source, { namespaces });
      // A turned-off skill the name matches more exactly than any enabled one is reported as turned
      // off, rather than resolving to a looser match (a copy whose frontmatter reuses its name).
      if (any.lookup.status === 'found' && !isSkillEnabledByPolicy(policy, any.lookup.skill)
        && (enabled.lookup.status === 'missing' || any.tier < enabled.tier)) {
        return { status: 'missing', disabled: any.lookup.skill };
      }
      return enabled.lookup;
    },
    async readBody(skill) {
      // Read exactly an enabled skill of this catalog, never one the Turn's policy turns off.
      if (!list().some((candidate) => candidate.id === skill.id)) throw new Error(`技能已关闭或不存在：${skill.name}`);
      return catalog.readBody(skill);
    },
    refresh: () => catalog.refresh()
  };
}

/**
 * The same bounded catalog, reading the Turn's frozen skill settings only when a skill is actually
 * looked up. A tool that never touches skills (`read` of an ordinary file) is then unaffected by a
 * malformed skill setting.
 */
export function lazySkillCatalogWithinPolicy(
  catalog: SkillCatalogCapability,
  readPolicy: () => Pick<SkillPolicyRecord, 'sourceConfigs'> | undefined
): SkillCatalogCapability {
  let bounded: SkillCatalogCapability | undefined;
  const resolve = () => bounded ??= skillCatalogWithinPolicy(catalog, readPolicy());
  return {
    list: () => resolve().list(),
    lookup: (name, source) => resolve().lookup(name, source),
    readBody: (skill) => resolve().readBody(skill),
    refresh: () => catalog.refresh()
  };
}
