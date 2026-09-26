import * as vscode from 'vscode';
import { promises as fsp, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillDefinitionRecord, SkillSource } from '../../shared/protocol';
import type { SkillCatalogCapability } from './types';
import { resolveDataRootUri } from './vscodeStorage/globalStatus';
import { compareSkillsByPriority, lookupSkill, SKILL_SOURCE_PRIORITY } from '../world/modules/skill/skillLookup';
import { parseSkillFrontmatter, yamlBoolean, yamlMapping, yamlText } from './skillFrontmatter';
import { isPathInside, isSamePath } from './filesystem/pathContainment';
import { realPath } from './filesystem/realPath';

const SKILL_ENTRY_FILE = 'SKILL.md';
/** 项目级技能目录（相对工作区文件夹），各 Agent 工具的约定位置。 */
const PROJECT_SKILL_ROOTS: readonly { source: SkillSource; segments: readonly string[] }[] = [
  { source: 'agents', segments: ['.agents', 'skills'] },
  { source: 'claude', segments: ['.claude', 'skills'] },
  { source: 'github', segments: ['.github', 'skills'] },
  { source: 'codex', segments: ['.codex', 'skills'] }
];
const GLOBAL_SKILLS_SEGMENT = 'skills';
/** 与 Codex 一致：技能目录向下最多找 6 层，每个根最多看 2000 个目录。 */
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_DIRECTORIES = 2000;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '__pycache__']);
/** 技能上方最近的插件清单决定命名空间（`插件名:技能名`），与 Claude Code / Codex / Cursor 插件一致。 */
const PLUGIN_MANIFESTS: readonly string[][] = [
  ['.claude-plugin', 'plugin.json'],
  ['.codex-plugin', 'plugin.json'],
  ['.cursor-plugin', 'plugin.json']
];
/** Files whose change can change the catalog; any other file change inside a skill never does. */
const CATALOG_FILES = new Set([SKILL_ENTRY_FILE, 'plugin.json', 'openai.yaml', 'installed_plugins.json', 'settings.json']);
const REFRESH_DEBOUNCE_MS = 300;

interface SkillRoot {
  source: SkillSource;
  uri: vscode.Uri;
  workspaceFolderUri?: string;
}

export interface SkillCatalogOptions {
  /** 用户主目录；测试注入，默认 os.homedir()。 */
  homeDir?: string;
  /** Codex 主目录；默认 $CODEX_HOME 或 ~/.codex。 */
  codexHome?: string;
}

/**
 * 技能目录扫描能力实现。按来源优先级扫描：
 * - 项目：<workspaceFolder>/{.agents,.claude,.github,.codex}/skills/
 * - 用户：~/.agents/skills、~/.claude/skills、$CODEX_HOME/skills（其 .system/ 单独作为一个根）、~/.copilot/skills，
 *   以及 Claude Code 已安装且未停用的插件（~/.claude/plugins/installed_plugins.json）
 * - 全局：<dataRoot>/skills/
 * 每个根向下递归查找含 SKILL.md 的目录（套件可以嵌套，如 <root>/<套件>/skills/<技能>/SKILL.md），跳过隐藏目录与
 * node_modules，跟随目录软链接并按真实路径去重（`npx skills` 把同一技能链接进多个 Agent 的目录）。
 * SKILL.md 采用 YAML frontmatter（name/description 等）+ markdown 正文，与 Claude Code、Codex、Copilot 一致。
 */
export function createSkillCatalogCapability(
  context: vscode.ExtensionContext,
  options: SkillCatalogOptions = {}
): SkillCatalogCapability & { watch(onChange: () => void): vscode.Disposable } {
  let skills: SkillDefinitionRecord[] = [];
  /** Directories the last scan read: its roots, plus the real directories of linked-in skills. */
  let scannedRoots: SkillRoot[] = [];
  let linkedDirectories: string[] = [];
  let running: Promise<void> | undefined;
  let rerun = false;
  const refreshed = new Set<() => void>();
  const home = options.homeDir ?? os.homedir();
  const claudeHome = path.join(home, '.claude');

  async function roots(): Promise<SkillRoot[]> {
    const codexHome = options.codexHome ?? (process.env.CODEX_HOME?.trim() || path.join(home, '.codex'));
    const folders = vscode.workspace.workspaceFolders ?? [];
    const result: SkillRoot[] = [];
    for (const { source, segments } of PROJECT_SKILL_ROOTS) {
      for (const folder of folders) {
        result.push({ source, uri: vscode.Uri.joinPath(folder.uri, ...segments), workspaceFolderUri: folder.uri.toString() });
      }
    }
    for (const dir of [
      path.join(home, '.agents', 'skills'),
      path.join(claudeHome, 'skills'),
      path.join(codexHome, 'skills'),
      path.join(codexHome, 'skills', '.system'),
      path.join(home, '.copilot', 'skills'),
      ...await installedClaudePluginRoots(claudeHome, folders.map((folder) => folder.uri.fsPath))
    ]) {
      result.push({ source: 'user', uri: vscode.Uri.file(dir) });
    }
    result.push({ source: 'global', uri: vscode.Uri.joinPath(resolveDataRootUri(context), GLOBAL_SKILLS_SEGMENT) });
    return result.sort((left, right) => SKILL_SOURCE_PRIORITY.indexOf(left.source) - SKILL_SOURCE_PRIORITY.indexOf(right.source));
  }

  async function scanAll(): Promise<void> {
    const discovered: SkillDefinitionRecord[] = [];
    const seenEntries = new Set<string>();
    const seenIds = new Set<string>();
    const linked = new Set<string>();
    const scanRoots = await roots();
    for (const root of scanRoots) {
      for (const skill of await scanSkillsRoot(root)) {
        // 同一个 SKILL.md 经软链接出现在多个根里时只保留优先级最高的那份；同一来源里重名的技能也只保留先找到的。
        const entryKey = await realPathKey(skill.path);
        if (seenEntries.has(entryKey) || seenIds.has(skill.id)) continue;
        seenEntries.add(entryKey);
        seenIds.add(skill.id);
        discovered.push(skill);
        const realDir = path.dirname(entryKey);
        if (!isInsideDirectory(realDir, skill.dir)) linked.add(realDir);
      }
    }
    skills = discovered.sort(compareSkillsByPriority);
    scannedRoots = scanRoots;
    linkedDirectories = [...linked].sort();
  }

  function refresh(): Promise<void> {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      do {
        rerun = false;
        await scanAll();
      } while (rerun);
    })().finally(() => { running = undefined; });
    // Every refresh — a watched change, a manual refresh, a skills lookup miss — re-aims the watchers.
    return running.then(() => { for (const listener of refreshed) listener(); });
  }

  /**
   * 目录变化时自动重扫：监听各技能根（尚不存在的项目目录也能被工作区监听捕获）、软链接进来的技能的真实目录，
   * 以及 Claude Code 的插件安装记录；工作区文件夹增减时重扫。任何一次重扫之后都按新的目录集合重建监听，
   * 集合没变就不重建；目录内容没变就不通知。只有 SKILL.md、插件清单、openai.yaml 的变化和目录增删才触发重扫。
   */
  function watch(onChange: () => void): vscode.Disposable {
    let watchers: vscode.Disposable[] = [];
    let watchedKey = '';
    let catalogKey = JSON.stringify(skills);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const canWatch = typeof vscode.workspace.createFileSystemWatcher === 'function' && typeof vscode.RelativePattern === 'function';
    const schedule = () => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void refresh().catch((error) => console.warn('[LimCode] Skill catalog refresh failed.', error));
      }, REFRESH_DEBOUNCE_MS);
    };
    const onEvent = (kind: 'create' | 'change' | 'delete') => (uri: vscode.Uri) => {
      const segments = uri.fsPath.split(/[\\/]/);
      if (segments.some((segment) => SKIPPED_DIRECTORIES.has(segment))) return;
      const base = segments[segments.length - 1] ?? '';
      // A skill or suite folder added or removed; folders rarely carry a file extension.
      if (CATALOG_FILES.has(base) || (kind !== 'change' && path.extname(base) === '')) schedule();
    };
    const rebuild = () => {
      const patterns: [vscode.WorkspaceFolder | vscode.Uri, string][] = [];
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        patterns.push([folder, `{${PROJECT_SKILL_ROOTS.map(({ segments }) => segments.join('/')).join(',')}}/**`]);
      }
      const watchedDirs: string[] = [];
      for (const root of scannedRoots) {
        if (root.workspaceFolderUri || root.uri.scheme !== 'file' || !existsDirectory(root.uri.fsPath)) continue;
        if (watchedDirs.some((dir) => isInsideDirectory(root.uri.fsPath, dir))) continue;
        watchedDirs.push(root.uri.fsPath);
        patterns.push([root.uri, '**']);
      }
      for (const dir of linkedDirectories) {
        if (!watchedDirs.some((watched) => isInsideDirectory(dir, watched))) patterns.push([vscode.Uri.file(dir), '**']);
      }
      if (existsDirectory(path.join(claudeHome, 'plugins'))) patterns.push([vscode.Uri.file(path.join(claudeHome, 'plugins')), 'installed_plugins.json']);
      if (existsDirectory(claudeHome)) patterns.push([vscode.Uri.file(claudeHome), 'settings.json']);
      const key = JSON.stringify(patterns.map(([base, glob]) => [base instanceof vscode.Uri ? base.toString() : base.uri.toString(), glob]));
      if (key === watchedKey) return;
      watchedKey = key;
      for (const watcher of watchers) watcher.dispose();
      watchers = patterns.map(([base, glob]) => {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, glob));
        watcher.onDidCreate(onEvent('create'));
        watcher.onDidChange(onEvent('change'));
        watcher.onDidDelete(onEvent('delete'));
        return watcher;
      });
    };
    const afterRefresh = () => {
      if (disposed) return;
      try {
        if (canWatch) rebuild();
      } catch (error) {
        console.warn('[LimCode] Skill catalog watcher setup failed.', error);
      }
      const next = JSON.stringify(skills);
      if (next === catalogKey) return;
      catalogKey = next;
      onChange();
    };
    refreshed.add(afterRefresh);
    // Hosts without file watching (tests, restricted environments) still refresh on demand.
    afterRefresh();
    const folders = typeof vscode.workspace.onDidChangeWorkspaceFolders === 'function'
      ? vscode.workspace.onDidChangeWorkspaceFolders(schedule)
      : undefined;
    return {
      dispose() {
        disposed = true;
        refreshed.delete(afterRefresh);
        if (timer) clearTimeout(timer);
        folders?.dispose();
        for (const watcher of watchers) watcher.dispose();
        watchers = [];
      }
    };
  }

  return {
    list: () => skills,
    lookup: (name, source) => lookupSkill(skills, name, source),
    async readBody(skill) {
      if (!skills.some((candidate) => candidate.id === skill.id && candidate.path === skill.path)) {
        throw new Error(`未找到技能：${skill.name}`);
      }
      const raw = await readTextFile(vscode.Uri.file(skill.path));
      return skillBodyOf(raw, parseSkillFrontmatter(raw).body);
    },
    refresh,
    watch
  };
}

/**
 * Install directories of the Claude Code plugins installed for this user (or for one of the open
 * workspace folders) and not turned off in ~/.claude/settings.json `enabledPlugins`. The plugin's
 * skills sit below its own plugin.json, which names their namespace.
 */
async function installedClaudePluginRoots(claudeHome: string, workspaceFolders: readonly string[]): Promise<string[]> {
  const installed = asPlainRecord(await readJsonFile(path.join(claudeHome, 'plugins', 'installed_plugins.json')));
  const enabled = asPlainRecord(asPlainRecord(await readJsonFile(path.join(claudeHome, 'settings.json')))?.enabledPlugins) ?? {};
  const plugins = asPlainRecord(installed?.plugins) ?? {};
  const result: string[] = [];
  for (const [pluginKey, value] of Object.entries(plugins).sort(([left], [right]) => left.localeCompare(right))) {
    if (enabled[pluginKey] === false) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      const install = asPlainRecord(entry);
      if (typeof install?.installPath !== 'string' || !path.isAbsolute(install.installPath)) continue;
      const scope = typeof install.scope === 'string' ? install.scope : 'user';
      const projectPath = typeof install.projectPath === 'string' ? install.projectPath : undefined;
      if (scope !== 'user' && !(projectPath && workspaceFolders.some((folder) => isSamePath(folder, projectPath)))) continue;
      if (!result.includes(install.installPath)) result.push(install.installPath);
    }
  }
  return result;
}

async function readJsonFile(fsPath: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(fsPath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isInsideDirectory(candidate: string, directory: string): boolean {
  return isPathInside(directory, candidate);
}

async function scanSkillsRoot(root: SkillRoot): Promise<SkillDefinitionRecord[]> {
  const skills: SkillDefinitionRecord[] = [];
  const visited = new Set<string>();
  const manifests = new Map<string, Promise<string | undefined>>();
  const queue: { uri: vscode.Uri; depth: number }[] = [{ uri: root.uri, depth: 0 }];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_SCAN_DIRECTORIES) {
    const { uri, depth } = queue.shift()!;
    // 目录软链接成环或指回已扫过的目录时，按真实路径只扫一次。
    const key = await realPathKey(uri.fsPath, uri);
    if (visited.has(key)) continue;
    visited.add(key);
    scanned += 1;
    let entries: [string, vscode.FileType][];
    try {
      entries = await readDirectoryEntries(uri);
    } catch {
      continue;
    }
    if (depth > 0 && entries.some(([name, type]) => name === SKILL_ENTRY_FILE && (type & vscode.FileType.File) !== 0)) {
      const skill = await readSkill(root, uri, (dir) => {
        let pending = manifests.get(dir.fsPath);
        if (!pending) manifests.set(dir.fsPath, pending = readPluginNamespace(dir));
        return pending;
      });
      if (skill) skills.push(skill);
      // 技能目录内的 scripts/references 等不再当作技能继续往下找。
      continue;
    }
    if (depth >= MAX_SCAN_DEPTH) continue;
    for (const [name, type] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
      // 软链接的目录类型是 Directory|SymbolicLink，按位判断。
      if ((type & vscode.FileType.Directory) === 0) continue;
      if (name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)) continue;
      queue.push({ uri: vscode.Uri.joinPath(uri, name), depth: depth + 1 });
    }
  }
  return skills;
}

async function readSkill(
  root: SkillRoot,
  dir: vscode.Uri,
  pluginNamespaceOf: (dir: vscode.Uri) => Promise<string | undefined>
): Promise<SkillDefinitionRecord | undefined> {
  const entryUri = vscode.Uri.joinPath(dir, SKILL_ENTRY_FILE);
  let raw: string;
  try {
    raw = await readTextFile(entryUri);
  } catch {
    return undefined;
  }
  const slug = path.basename(dir.fsPath).trim();
  if (!slug) return undefined;
  const { data } = parseSkillFrontmatter(raw);
  const frontmatterName = yamlText(data.name)?.trim();
  const metadata = yamlMapping(data.metadata);
  const description = collapseWhitespace([
    yamlText(data.description) ?? yamlText(metadata?.['short-description']) ?? '',
    yamlText(data.when_to_use) ?? ''
  ].filter(Boolean).join(' '));
  const plugin = await nearestPluginNamespace(root.uri, dir, pluginNamespaceOf);
  const namespace = plugin?.namespace;
  const name = namespace ? `${namespace}:${slug}` : slug;
  const aliases = frontmatterName && frontmatterName !== slug && frontmatterName !== name
    ? [...new Set([frontmatterName, ...(namespace && !frontmatterName.includes(':') ? [`${namespace}:${frontmatterName}`] : [])])]
    : [];
  const hidden = yamlBoolean(data['disable-model-invocation']) === true || !(await allowsImplicitInvocation(dir));
  return {
    id: `skill:${root.source}:${name}`,
    name,
    slug,
    ...(plugin ? { namespace: plugin.namespace, pluginRoot: plugin.root } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    description,
    ...(hidden ? { hiddenFromModel: true as const } : {}),
    source: root.source,
    path: entryUri.fsPath,
    dir: dir.fsPath,
    ...(root.workspaceFolderUri ? { workspaceFolderUri: root.workspaceFolderUri } : {})
  };
}

/** 从技能目录的上一级往上找到扫描根为止，第一个带插件清单的目录给出命名空间，它就是插件根目录。 */
async function nearestPluginNamespace(
  root: vscode.Uri,
  dir: vscode.Uri,
  pluginNamespaceOf: (dir: vscode.Uri) => Promise<string | undefined>
): Promise<{ namespace: string; root: string } | undefined> {
  const rootPath = path.resolve(root.fsPath);
  let current = path.dirname(path.resolve(dir.fsPath));
  while (isPathInside(rootPath, current)) {
    const namespace = await pluginNamespaceOf(vscode.Uri.file(current));
    if (namespace) return { namespace, root: current };
    if (isSamePath(current, rootPath)) break;
    current = path.dirname(current);
  }
  return undefined;
}

async function readPluginNamespace(dir: vscode.Uri): Promise<string | undefined> {
  for (const segments of PLUGIN_MANIFESTS) {
    try {
      const manifest = JSON.parse(await readTextFile(vscode.Uri.joinPath(dir, ...segments))) as { name?: unknown };
      const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
      if (name && !/[\s:]/.test(name)) return name;
    } catch {
      // 没有这种清单，或清单无效：继续看下一种。
    }
  }
  return undefined;
}

/** Codex 的 agents/openai.yaml `policy.allow_implicit_invocation: false` 表示只在被点名时使用。 */
async function allowsImplicitInvocation(dir: vscode.Uri): Promise<boolean> {
  let raw: string;
  try {
    raw = await readTextFile(vscode.Uri.joinPath(dir, 'agents', 'openai.yaml'));
  } catch {
    return true;
  }
  const policy = yamlMapping(parseSkillFrontmatter(`---\n${raw}\n---\n`).data.policy);
  return yamlBoolean(policy?.allow_implicit_invocation) !== false;
}

async function realPathKey(fsPath: string, uri?: vscode.Uri): Promise<string> {
  if (uri && uri.scheme !== 'file') return uri.toString();
  try {
    return await realPath(fsPath);
  } catch {
    return path.resolve(fsPath);
  }
}

function existsDirectory(fsPath: string): boolean {
  try {
    return statSync(fsPath).isDirectory();
  } catch {
    return false;
  }
}

/** The body without surrounding blank space, and the SKILL.md line it starts on. */
function skillBodyOf(raw: string, body: string): { text: string; startLine: number } {
  const leading = body.length - body.trimStart().length;
  const offset = raw.length - body.length + leading;
  return { text: body.trim(), startLine: raw.slice(0, offset).split('\n').length };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Local folders are read with Node directly (as the file tools do for file: URIs): the VS Code FS
 * API can stall while the renderer is away, and a scan must not hold up Turn admission. A symbolic
 * link reports its target's type plus SymbolicLink, as VS Code's disk provider does.
 */
async function readDirectoryEntries(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  if (uri.scheme !== 'file') return vscode.workspace.fs.readDirectory(uri);
  const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
  return Promise.all(entries.map(async (entry): Promise<[string, vscode.FileType]> => {
    if (!entry.isSymbolicLink()) {
      return [entry.name, entry.isDirectory() ? vscode.FileType.Directory : entry.isFile() ? vscode.FileType.File : vscode.FileType.Unknown];
    }
    const target = await fsp.stat(path.join(uri.fsPath, entry.name)).catch(() => undefined);
    const type = target?.isDirectory() ? vscode.FileType.Directory : target?.isFile() ? vscode.FileType.File : vscode.FileType.Unknown;
    return [entry.name, type | vscode.FileType.SymbolicLink];
  }));
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
  if (uri.scheme === 'file') return fsp.readFile(uri.fsPath, 'utf8');
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}
