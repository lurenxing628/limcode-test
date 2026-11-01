import * as vscode from 'vscode';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillCatalogActionPayload } from '../../shared/protocol';
import { resolveDataRootUri } from './vscodeStorage/globalStatus';

const SKILL_ENTRY_FILE = 'SKILL.md';
/** 与技能目录扫描一致：向下最多找 6 层，跳过隐藏目录与依赖目录。 */
const MAX_FIND_DEPTH = 6;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '__pycache__']);
/** 技能名就是目录名，也是模型点名用的名字：不能有空白和路径字符。 */
const SKILL_NAME_PATTERN = /^[^\s\\/:*?"<>|.][^\s\\/:*?"<>|]{0,63}$/;

interface SkillTarget extends vscode.QuickPickItem {
  dir: string;
}

/**
 * 技能设置页的“新建技能 / 导入技能 / 打开技能目录”：选一个技能目录（数据根、~/.agents/skills
 * 或项目 .agents/skills），在里面建好 <名称>/SKILL.md 模板、复制选中的技能文件夹，或在系统中打开它。
 * 返回是否改动了技能文件，调用方据此重新扫描技能目录。
 */
export async function runSkillCatalogAction(
  context: vscode.ExtensionContext,
  action: SkillCatalogActionPayload['action']
): Promise<boolean> {
  const placeHolder = action === 'create' ? '新技能放在哪里？' : action === 'import' ? '把技能导入到哪里？' : '打开哪个技能目录？';
  const target = await vscode.window.showQuickPick(skillTargets(context), { placeHolder });
  if (!target) return false;
  switch (action) {
    case 'create': return createSkill(target.dir);
    case 'import': return importSkills(target.dir);
    case 'openFolder':
      await fsp.mkdir(target.dir, { recursive: true });
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target.dir));
      return false;
  }
}

function skillTargets(context: vscode.ExtensionContext): SkillTarget[] {
  const targets: SkillTarget[] = [];
  const dataRoot = resolveDataRootUri(context);
  if (dataRoot.scheme === 'file') {
    targets.push({ label: '数据根技能', description: '只给 LimCode 用，所有项目共享', detail: path.join(dataRoot.fsPath, 'skills'), dir: path.join(dataRoot.fsPath, 'skills') });
  }
  const userDir = path.join(os.homedir(), '.agents', 'skills');
  targets.push({ label: '用户技能', description: '与 Codex、Copilot 等共用，所有项目共享', detail: userDir, dir: userDir });
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const dir = path.join(folder.uri.fsPath, '.agents', 'skills');
    targets.push({ label: `项目技能：${folder.name}`, description: '只在这个项目生效，可随仓库提交', detail: dir, dir });
  }
  return targets;
}

async function createSkill(root: string): Promise<boolean> {
  const name = await vscode.window.showInputBox({
    title: '新建技能',
    prompt: '技能名称，也是文件夹名和模型点名用的名字（建议小写字母、数字和短横线）',
    placeHolder: 'my-skill',
    validateInput: async (value) => {
      const trimmed = value.trim();
      if (!trimmed) return '请输入技能名称。';
      if (!SKILL_NAME_PATTERN.test(trimmed)) return '名称最多 64 个字符，不能有空格、路径字符，也不能以 . 开头。';
      return await exists(path.join(root, trimmed)) ? `${trimmed} 已存在。` : undefined;
    }
  });
  if (!name?.trim()) return false;
  const description = await vscode.window.showInputBox({
    title: '新建技能',
    prompt: '一句话说明这个技能做什么、什么时候该用（模型据此决定是否使用，可以之后再改）',
    placeHolder: '例如：整理会议记录时使用，输出决议与待办'
  });
  if (description === undefined) return false;
  const dir = path.join(root, name.trim());
  const file = path.join(dir, SKILL_ENTRY_FILE);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, skillTemplate(name.trim(), description.trim()), { encoding: 'utf8', flag: 'wx' });
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  return true;
}

function skillTemplate(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    // 单引号 YAML 只需把 ' 写成 ''，冒号、# 和双引号都能原样保留。
    `description: '${(description || '说明这个技能做什么、什么时候该用。').replace(/'/g, "''")}'`,
    '---',
    '',
    `# ${name}`,
    '',
    '在这里写技能的具体做法：适用场景、操作步骤、注意事项。',
    '',
    '同一文件夹里可以放 scripts/、references/ 等辅助文件，在正文里用相对路径引用。',
    ''
  ].join('\n');
}

async function importSkills(root: string): Promise<boolean> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: '导入技能',
    title: '选择技能文件夹（含 SKILL.md，也可以选包含多个技能的上级文件夹）'
  });
  if (!picked?.length) return false;
  const sources: string[] = [];
  for (const uri of picked) {
    for (const dir of await findSkillDirectories(uri.fsPath)) {
      if (!sources.some((source) => path.basename(source) === path.basename(dir))) sources.push(dir);
    }
  }
  if (sources.length === 0) {
    void vscode.window.showWarningMessage('LimCode：所选文件夹里没有找到 SKILL.md，没有导入任何技能。');
    return false;
  }
  const conflicts: string[] = [];
  for (const source of sources) {
    if (await exists(path.join(root, path.basename(source)))) conflicts.push(path.basename(source));
  }
  let overwrite = false;
  if (conflicts.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `目标目录里已有同名技能：${conflicts.join('、')}。覆盖会先删除原有文件夹。`,
      { modal: true },
      '覆盖',
      '跳过同名'
    );
    if (!choice) return false;
    overwrite = choice === '覆盖';
  }
  const imported: string[] = [];
  for (const source of sources) {
    const name = path.basename(source);
    const dest = path.join(root, name);
    if (path.resolve(source) === path.resolve(dest)) continue;
    if (conflicts.includes(name)) {
      if (!overwrite) continue;
      await fsp.rm(dest, { recursive: true, force: true });
    }
    await fsp.cp(source, dest, {
      recursive: true,
      filter: (entry) => !SKIPPED_DIRECTORIES.has(path.basename(entry))
    });
    imported.push(name);
  }
  if (imported.length > 0) void vscode.window.showInformationMessage(`LimCode：已导入 ${imported.length} 个技能：${imported.join('、')}。`);
  return imported.length > 0;
}

/** 选中的文件夹本身是技能就只取它；否则向下找所有含 SKILL.md 的文件夹（技能套件）。 */
async function findSkillDirectories(dir: string, depth = 0): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((entry) => entry.name === SKILL_ENTRY_FILE && entry.isFile())) return [dir];
  if (depth >= MAX_FIND_DEPTH) return [];
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    found.push(...await findSkillDirectories(path.join(dir, entry.name), depth + 1));
  }
  return found;
}

async function exists(fsPath: string): Promise<boolean> {
  return fsp.access(fsPath).then(() => true, () => false);
}
