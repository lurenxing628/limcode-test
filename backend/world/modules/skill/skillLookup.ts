import type { SkillLookup } from '../../../capabilities/types';
import type { SkillDefinitionRecord, SkillSource } from '../../../../shared/protocol';

/** 来源优先级（也用于列表展示排序）：项目 .agents > .claude > .github > .codex > 用户主目录 > 数据根。未指定 source 时按此顺序挑选。 */
export const SKILL_SOURCE_PRIORITY: readonly SkillSource[] = ['agents', 'claude', 'github', 'codex', 'user', 'global'];

const SOURCE_DISPLAY: Record<SkillSource, string> = {
  agents: '.agents',
  claude: '.claude',
  github: '.github',
  codex: '.codex',
  user: 'user',
  global: 'global'
};

export function skillSourceDisplay(source: SkillSource): string {
  return SOURCE_DISPLAY[source] ?? source;
}

/** 接受来源 id 与带点的展示形式（`.claude`），大小写不敏感。 */
export function normalizeSkillSource(value: unknown): SkillSource | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^\./, '').toLowerCase();
  return (SKILL_SOURCE_PRIORITY as readonly string[]).includes(normalized) ? normalized as SkillSource : undefined;
}

function sourceRank(source: SkillSource): number {
  const index = SKILL_SOURCE_PRIORITY.indexOf(source);
  return index === -1 ? SKILL_SOURCE_PRIORITY.length : index;
}

export function compareSkillsByPriority(left: SkillDefinitionRecord, right: SkillDefinitionRecord): number {
  return sourceRank(left.source) - sourceRank(right.source) || left.name.localeCompare(right.name);
}

export interface SkillLookupOptions {
  /** Plugin namespaces of the whole catalog: a turned-off plugin still owns its `ns:` prefix. */
  namespaces?: ReadonlySet<string>;
}

/**
 * 按模型或用户给出的名字查找技能。依次尝试：规范名（`套件:技能` 或目录名）、id、别名（frontmatter name），
 * 再不分大小写重试；仍未命中时按不带套件前缀的名字匹配，这样 `superpowers:brainstorming` 能找到平铺安装的
 * `brainstorming`，`brainstorming` 也能找到插件里的 `superpowers:brainstorming`；带了套件前缀时不会落到别的
 * 套件的同名技能上（`telegram:access` 不会找到 `discord:access`）。同一层命中多个来源时取优先级最高的来源；
 * 最高来源里仍有多个（如 discord:access 与 telegram:access）时返回候选让调用方指明。
 * 也接受 Codex 的 `$name`、Claude Code 的 `/name` 写法，以及 `.claude:name` 这种带来源前缀的写法。
 */
export function lookupSkill(
  skills: readonly SkillDefinitionRecord[],
  query: string,
  source?: SkillSource,
  options: SkillLookupOptions = {}
): SkillLookup {
  return lookupSkillWithTier(skills, query, source, options).lookup;
}

/** lookupSkill plus how exact the match was: the index of the matching tier, lower is more exact. */
export function lookupSkillWithTier(
  skills: readonly SkillDefinitionRecord[],
  query: string,
  source?: SkillSource,
  options: SkillLookupOptions = {}
): { lookup: SkillLookup; tier: number } {
  const missing = { lookup: { status: 'missing' } as SkillLookup, tier: Number.POSITIVE_INFINITY };
  let key = query.trim().replace(/^[$/](?=\S)/, '');
  if (!key) return missing;
  const namespaces = options.namespaces ?? new Set(skills.flatMap((skill) => (skill.namespace ? [skill.namespace] : [])));
  let scopedSource = source;
  if (!scopedSource) {
    const prefixed = /^([^:/\s]+)[:/](.+)$/.exec(key);
    const prefixSource = prefixed ? normalizeSkillSource(prefixed[1]) : undefined;
    if (prefixed && prefixSource && !namespaces.has(prefixed[1])) {
      scopedSource = prefixSource;
      key = prefixed[2].trim();
    }
  }
  const pool = scopedSource ? skills.filter((skill) => skill.source === scopedSource) : [...skills];
  const lower = key.toLowerCase();
  const separator = key.lastIndexOf(':');
  const queryNamespace = separator === -1 ? undefined : key.slice(0, separator).trim().toLowerCase();
  const bareLower = (separator === -1 ? key : key.slice(separator + 1)).trim().toLowerCase();
  const tiers: ((skill: SkillDefinitionRecord) => boolean)[] = [
    (skill) => skill.name === key || skill.id === key,
    (skill) => (skill.aliases ?? []).includes(key),
    (skill) => skill.name.toLowerCase() === lower || (skill.aliases ?? []).some((alias) => alias.toLowerCase() === lower),
    (skill) => !!bareLower
      && (queryNamespace === undefined || !skill.namespace || skill.namespace.toLowerCase() === queryNamespace)
      && (skill.slug.toLowerCase() === bareLower
        || (skill.aliases ?? []).some((alias) => unqualified(alias).toLowerCase() === bareLower))
  ];
  for (const [tier, matches] of tiers.entries()) {
    const hits = pool.filter(matches);
    if (hits.length === 0) continue;
    const best = Math.min(...hits.map((skill) => sourceRank(skill.source)));
    const top = hits.filter((skill) => sourceRank(skill.source) === best);
    return {
      lookup: top.length === 1
        ? { status: 'found', skill: top[0] }
        : { status: 'ambiguous', candidates: [...hits].sort(compareSkillsByPriority) },
      tier
    };
  }
  return missing;
}

function unqualified(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}

/** 载入失败时给模型的说明：列出可用名字，区分“不存在 / 被设置关掉 / 名字有歧义”。 */
export function describeSkillLookupFailure(
  query: string,
  lookup: Exclude<SkillLookup, { status: 'found' }>,
  available: readonly SkillDefinitionRecord[]
): string {
  if (lookup.status === 'ambiguous') {
    const options = lookup.candidates.map((skill) => `${skill.name} (source ${skillSourceDisplay(skill.source)})`).join(', ');
    return `技能名 "${query}" 对应多个技能：${options}。请用完整的 name，或同时给出 source。`;
  }
  if (lookup.disabled) {
    return `技能 "${lookup.disabled.name}"（source ${skillSourceDisplay(lookup.disabled.source)}）在当前 Turn 的技能设置里已关闭`
      + '（子 Agent 还受派出它的对话的设置限制），不能载入。';
  }
  const names = available.filter((skill) => !skill.hiddenFromModel).map((skill) => skill.name);
  const shown = names.slice(0, 60).join(', ');
  const more = names.length > 60 ? ` 等 ${names.length} 个` : '';
  return names.length === 0
    ? `未找到技能 "${query}"：当前没有可用的技能。`
    : `未找到技能 "${query}"。可用的技能：${shown}${more}。`;
}

/**
 * 技能正文交给模型时的形式：说明技能的基准目录，正文里的相对路径都相对它解析。
 * `${CLAUDE_SKILL_DIR}` 按 Claude Code 的约定换成技能目录。skills 工具结果与子 Agent 预载共用。
 * `source` 是展示形式（`.claude`、`user` 等），与 skills 工具结果里的字段一致。
 */
export function renderLoadedSkill(
  skill: { name: string; source: string; baseDirectory: string; pluginRoot?: string },
  body: string
): string {
  const expanded = body.split('${CLAUDE_SKILL_DIR}').join(skill.baseDirectory)
    .split('${CLAUDE_PLUGIN_ROOT}').join(skill.pluginRoot ?? skill.baseDirectory);
  return [
    `<skill name="${skill.name}" source="${skill.source}">`,
    `Base directory for this skill: ${skill.baseDirectory}`,
    ...(skill.pluginRoot ? [`Plugin root: ${skill.pluginRoot} (a path such as skills/<name>/... in this skill is relative to it)`] : []),
    'Relative paths in this skill (scripts/, references/, assets/, ...) resolve against this base directory: read them with the read tool by absolute path, and run bundled scripts by absolute path.',
    '',
    expanded,
    '</skill>'
  ].join('\n');
}

export function renderSkillRecord(skill: Pick<SkillDefinitionRecord, 'name' | 'source' | 'dir' | 'pluginRoot'>, body: string): string {
  return renderLoadedSkill({
    name: skill.name,
    source: skillSourceDisplay(skill.source),
    baseDirectory: skill.dir,
    ...(skill.pluginRoot ? { pluginRoot: skill.pluginRoot } : {})
  }, body);
}
