import type { SkillSource } from '../../../../shared/protocol';
import { skillSourceDisplay } from './skillLookup';

export interface SkillDescriptionEntry {
  name: string;
  description: string;
  source: SkillSource;
  hiddenFromModel?: true;
}

/** 技能清单占用工具描述的上限（字符）。与 Codex 的 8000 字符后备预算同量级，单条描述不超过 1024 字符。 */
export const SKILL_LISTING_MAX_CHARS = 12_000;
const SKILL_DESCRIPTION_MAX_CHARS = 1_024;
const SKILL_DESCRIPTION_SHORT_CHARS = 240;

/**
 * 把「当前已启用的技能」列表拼进 skills 工具描述，让 AI 感知可用技能。
 * 技能正文只在 AI 调用 skills({ name }) 时按需返回，避免污染 system prompt。
 * `disable-model-invocation` 的技能不列出（被点名时仍可载入）。超出预算时依次缩短描述、只列名字、
 * 最后省略尾部条目并注明数量。ECS schema contributor 与 reliableKernel toolDispatcher 共用此纯函数。
 */
export function composeSkillsToolDescription(baseDescription: string, skills: readonly SkillDescriptionEntry[]): string {
  const listed = skills.filter((skill) => !skill.hiddenFromModel);
  if (listed.length === 0) {
    return `${baseDescription}\n\nAvailable skills: none.`;
  }
  const entry = (skill: SkillDescriptionEntry, descriptionChars: number | undefined): string => {
    const lines = [`- name: ${skill.name}`, `  source: ${skillSourceDisplay(skill.source)}`];
    const description = skill.description.trim();
    if (descriptionChars !== undefined && description) lines.push(`  description: ${yamlScalar(truncate(description, descriptionChars))}`);
    return lines.join('\n');
  };
  const size = (lines: readonly string[]) => lines.reduce((total, line) => total + line.length + 1, 0);
  let lines = listed.map((skill) => entry(skill, SKILL_DESCRIPTION_MAX_CHARS));
  if (size(lines) > SKILL_LISTING_MAX_CHARS) lines = listed.map((skill) => entry(skill, SKILL_DESCRIPTION_SHORT_CHARS));
  for (let index = listed.length - 1; index >= 0 && size(lines) > SKILL_LISTING_MAX_CHARS; index -= 1) {
    lines[index] = entry(listed[index], undefined);
  }
  let omitted = 0;
  while (lines.length > 1 && size(lines) > SKILL_LISTING_MAX_CHARS) {
    lines.pop();
    omitted += 1;
  }
  const tail = omitted > 0 ? `\n(${omitted} more skills are not listed; load one by name when the user names it.)` : '';
  return `${baseDescription}\n\nAvailable skills (YAML):\n${lines.join('\n')}${tail}`;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

/** 把自由文本描述编码为安全的 YAML 标量：双引号包裹并转义换行/引号/反斜杠。 */
function yamlScalar(value: string): string {
  if (!value) return '""';
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
}
