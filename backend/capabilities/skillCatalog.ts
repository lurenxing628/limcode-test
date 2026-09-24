import * as vscode from 'vscode';
import type { SkillDefinitionRecord, SkillSource } from '../../shared/protocol';
import type { SkillCatalogCapability } from './types';
import { resolveDataRootUri } from './vscodeStorage/globalStatus';
import { SKILL_SOURCE_PRIORITY } from '../world/modules/skill/policy';

const SKILL_ENTRY_FILE = 'SKILL.md';
/** 项目级技能来源与其目录段。三者相互独立，同名 slug 各自保留。 */
const PROJECT_SKILL_ROOTS: readonly { source: SkillSource; segments: readonly string[] }[] = [
  { source: 'agents', segments: ['.agents', 'skills'] },
  { source: 'claude', segments: ['.claude', 'skills'] }
];
const GLOBAL_SKILLS_SEGMENT = 'skills';
/** 来源优先级（也用于列表展示排序）：.agents > .claude > 全局。未指定 source 时按此顺序取最优先者。 */
const SOURCE_ORDER: readonly SkillSource[] = SKILL_SOURCE_PRIORITY;

function sourceRank(source: SkillSource): number {
  const index = SOURCE_ORDER.indexOf(source);
  return index === -1 ? SOURCE_ORDER.length : index;
}

/**
 * 技能目录扫描能力实现。
 * .agents 技能：<workspaceFolder>/.agents/skills/<slug>/SKILL.md
 * .claude 技能：<workspaceFolder>/.claude/skills/<slug>/SKILL.md
 * 全局技能：<dataRoot>/skills/<slug>/SKILL.md
 * SKILL.md 采用 YAML frontmatter（name/description）+ markdown 正文，与 Claude Code 一致。
 * 三种来源相互独立（source 不同 → id 不同），同名 slug 可共存；调用方用 (name, source) 精确定位。
 */
export function createSkillCatalogCapability(context: vscode.ExtensionContext): SkillCatalogCapability {
  let skills: SkillDefinitionRecord[] = [];

  function findSkill(name: string, source?: SkillSource): SkillDefinitionRecord | undefined {
    const key = name.trim();
    if (!key) return undefined;
    const matches = (skill: SkillDefinitionRecord): boolean =>
      (skill.slug === key || skill.name === key || skill.id === key) && (source === undefined || skill.source === source);
    const candidates = skills.filter(matches);
    if (candidates.length <= 1) return candidates[0];
    // 未指定 source 且 name 命中多个来源时，按来源优先级返回最优先者（.agents > .claude > 全局）。
    return [...candidates].sort((left, right) => sourceRank(left.source) - sourceRank(right.source))[0];
  }

  async function refresh(): Promise<void> {
    const discovered: SkillDefinitionRecord[] = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const { source, segments } of PROJECT_SKILL_ROOTS) {
        const root = vscode.Uri.joinPath(folder.uri, ...segments);
        discovered.push(...await scanSkillsRoot(root, source, folder.uri.toString()));
      }
    }

    const globalRoot = vscode.Uri.joinPath(resolveDataRootUri(context), GLOBAL_SKILLS_SEGMENT);
    discovered.push(...await scanSkillsRoot(globalRoot, 'global'));

    discovered.sort((left, right) => SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source) || left.name.localeCompare(right.name));
    skills = discovered;
  }

  return {
    list: () => skills,
    get: (name, source) => findSkill(name, source),
    async readBody(name, source) {
      const skill = findSkill(name, source);
      if (!skill) throw new Error(`未找到技能：${name}${source ? `（来源 ${source}）` : ''}`);
      const raw = await readTextFile(vscode.Uri.file(skill.path));
      return stripFrontmatter(raw).trim();
    },
    refresh
  };
}

async function scanSkillsRoot(root: vscode.Uri, source: SkillSource, workspaceFolderUri?: string): Promise<SkillDefinitionRecord[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return [];
  }

  const skills: SkillDefinitionRecord[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    const slug = name.trim();
    if (!slug) continue;
    const dir = vscode.Uri.joinPath(root, name);
    const entryUri = vscode.Uri.joinPath(dir, SKILL_ENTRY_FILE);
    let raw: string;
    try {
      raw = await readTextFile(entryUri);
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(raw);
    skills.push({
      id: `skill:${source}:${slug}`,
      slug,
      name: frontmatter.name || slug,
      description: frontmatter.description || '',
      source,
      path: entryUri.fsPath,
      dir: dir.fsPath,
      ...(workspaceFolderUri ? { workspaceFolderUri } : {})
    });
  }
  return skills;
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

const FRONTMATTER_PATTERN = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 极简 frontmatter 解析：只取顶层 key: value（name/description），不引入 YAML 依赖。 */
function parseFrontmatter(raw: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) return {};
  const result: SkillFrontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (key !== 'name' && key !== 'description') continue;
    result[key] = stripInlineValue(line.slice(separator + 1));
  }
  return result;
}

function stripInlineValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripFrontmatter(raw: string): string {
  const match = FRONTMATTER_PATTERN.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}
