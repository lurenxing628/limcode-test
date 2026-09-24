import type { SkillCatalogCapability } from '../../../capabilities/types';
import type { SkillDefinitionRecord, SkillPolicyRecord, SkillSource } from '../../../../shared/protocol';

/** 来源优先级（也用于列表展示排序）：.agents > .claude > 全局。未指定 source 时按此顺序挑选。 */
export const SKILL_SOURCE_PRIORITY: readonly SkillSource[] = ['agents', 'claude', 'global'];

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
  return !(config.disabledSkills ?? []).includes(skill.id);
}

/**
 * The skill catalog as one Turn's frozen policy sees it: a skill the policy turns off cannot be
 * found or read, just as it is left out of the skills tool description. A name without a source
 * resolves among the enabled candidates by source priority, so it finds the same skill the list
 * shows even when a higher-priority source has a disabled skill of that name.
 */
export function skillCatalogWithinPolicy(
  catalog: SkillCatalogCapability,
  policy: Pick<SkillPolicyRecord, 'sourceConfigs'> | undefined
): SkillCatalogCapability {
  const enabled = (skill: SkillDefinitionRecord | undefined) =>
    skill && isSkillEnabledByPolicy(policy, skill) ? skill : undefined;
  const get = (name: string, source?: SkillSource) => source
    ? enabled(catalog.get(name, source))
    : SKILL_SOURCE_PRIORITY.map((candidate) => enabled(catalog.get(name, candidate))).find((skill) => skill !== undefined);
  return {
    list: () => catalog.list().filter((skill) => isSkillEnabledByPolicy(policy, skill)),
    get,
    async readBody(name, source) {
      const skill = get(name, source);
      if (!skill) throw new Error(`未找到技能：${name}`);
      // Read exactly the enabled skill found above, never the catalog's own unfiltered first match.
      return catalog.readBody(name, skill.source);
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
    get: (name, source) => resolve().get(name, source),
    readBody: (name, source) => resolve().readBody(name, source),
    refresh: () => catalog.refresh()
  };
}
