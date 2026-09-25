import { SKILLS_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';
import { SKILL_SOURCE_PRIORITY, describeSkillLookupFailure, normalizeSkillSource, skillSourceDisplay } from '../../../skill/skillLookup';

interface SkillsToolArgs { name?: unknown; source?: unknown }

export const skillsToolModule = defineToolDefinitionModule({
  id: SKILLS_TOOL_NAME,
  create() {
    return skillsTool;
  }
});

/**
 * skills 工具结果：界面按字段展示；给模型时按 renderLoadedSkill 渲染成“基准目录说明 + 正文”的纯文本，
 * 不作为 JSON 字符串转义。
 */
export interface SkillsToolOutput {
  name: string;
  /** 展示形式的来源（`.claude`、`user` 等）。 */
  source: string;
  baseDirectory: string;
  /** The directory of the plugin manifest above a plugin's skill. */
  pluginRoot?: string;
  entryPath: string;
  body: string;
  /** SKILL.md line the body starts on (after the frontmatter), so a cut body says exactly where to continue. */
  bodyStartLine: number;
}

export const SKILLS_TOOL_BASE_DESCRIPTION = `Load a skill's full instructions (its SKILL.md) into the current context.

A skill is a packaged workflow or domain playbook (SKILL.md plus optional scripts/, references/, assets/). The skills available in this Turn are listed at the end of this description.

How to use skills:
- If the user names a skill (e.g. "$name", "/name", or plain text), or the task clearly matches a skill's description, load it with this tool BEFORE doing the task, then follow it. If several skills apply, load each one and say in which order you use them. Do not pick a skill on keyword overlap alone.
- Follow the loaded instructions completely. If the result says it was truncated, read the rest of SKILL.md from entryPath with the read tool before acting.
- Relative paths in a skill (scripts/foo.py, references/x.md) resolve against the skill's base directory, given with the loaded skill. Read referenced files with the read tool by absolute path; prefer running or adapting bundled scripts over rewriting them. Open only files the skill points to.
- When a skill tells you to use another skill (e.g. "use superpowers:writing-plans", "REQUIRED SUB-SKILL: ..."), load that one with this tool too. Names written for other agents resolve here as well: "plugin:skill", "$skill", "/skill", or the bare skill name. "the Skill tool" in a skill means this tool.
- A child agent does not inherit skills you loaded. To give it one, pass the skill names in run_agent's skills parameter, or tell it which skill to load.
- If a skill cannot be loaded, say so briefly and continue with the best fallback.`;

export const skillsTool: ToolDefinition = {
  declaration: {
    name: SKILLS_TOOL_NAME,
    description: SKILLS_TOOL_BASE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name exactly as listed (e.g. "pdf" or "superpowers:brainstorming").' },
        source: {
          type: 'string',
          enum: SKILL_SOURCE_PRIORITY.map(skillSourceDisplay),
          description: 'Only needed when the same name is listed under several sources.'
        }
      },
      required: ['name']
    },
    metadata: {
      category: 'general',
      scope: 'skill',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'readonly_skill_load'),
  summary: summarizeSkillsToolCall,
  async execute(rawArgs, deps) {
    const args = (rawArgs ?? {}) as SkillsToolArgs;
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return { ok: false, output: 'Missing required argument: name' };
    const source = normalizeSkillSource(args.source);
    let lookup = deps.skills.lookup(name, source);
    if (lookup.status === 'missing' && !lookup.disabled) {
      // A skill created or installed moments ago (possibly by this agent) is found without a manual refresh.
      await deps.skills.refresh();
      lookup = deps.skills.lookup(name, source);
    }
    if (lookup.status !== 'found') return { ok: false, output: describeSkillLookupFailure(name, lookup, deps.skills.list()) };
    const skill = lookup.skill;
    const body = await deps.skills.readBody(skill);
    const output: SkillsToolOutput = {
      name: skill.name,
      source: skillSourceDisplay(skill.source),
      baseDirectory: skill.dir,
      ...(skill.pluginRoot ? { pluginRoot: skill.pluginRoot } : {}),
      // SKILL.md 的绝对路径：结果被截断时模型据此用 read 读完剩余部分。
      entryPath: skill.path,
      body: body.text,
      bodyStartLine: body.startLine
    };
    return { ok: true, output };
  }
};

function summarizeSkillsToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as SkillsToolArgs;
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const source = normalizeSkillSource(args.source);
  return name ? `载入技能 · ${source ? `${skillSourceDisplay(source)}:` : ''}${name}` : undefined;
}
