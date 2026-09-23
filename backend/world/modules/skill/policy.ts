import type { SkillCatalogCapability } from '../../../capabilities/types';
import type { SkillDefinitionRecord, SkillPolicyRecord, SkillSource } from '../../../../shared/protocol';

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
 * found or read, just as it is left out of the skills tool description.
 */
export function skillCatalogWithinPolicy(
  catalog: SkillCatalogCapability,
  policy: Pick<SkillPolicyRecord, 'sourceConfigs'> | undefined
): SkillCatalogCapability {
  const get = (name: string, source?: SkillSource) => {
    const skill = catalog.get(name, source);
    return skill && isSkillEnabledByPolicy(policy, skill) ? skill : undefined;
  };
  return {
    list: () => catalog.list().filter((skill) => isSkillEnabledByPolicy(policy, skill)),
    get,
    async readBody(name, source) {
      if (!get(name, source)) throw new Error(`未找到技能：${name}`);
      return catalog.readBody(name, source);
    },
    refresh: () => catalog.refresh()
  };
}
