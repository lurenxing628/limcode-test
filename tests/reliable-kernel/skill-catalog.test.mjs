import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const workspaceFolders = [];
// Like VS Code's disk provider: a symbolic link reports its target's type plus SymbolicLink.
// Declared up front: compiled `import * as vscode` copies the module's top-level members once.
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
const vscode = { Uri, FileType, RelativePattern, workspace: { workspaceFolders, fs: {
  readFile: uri => fs.readFile(uri.fsPath),
  async stat(uri) { const s = await fs.stat(uri.fsPath); return { type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs }; },
  async readDirectory(uri) {
    const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
    return Promise.all(entries.map(async (entry) => {
      if (!entry.isSymbolicLink()) return [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File];
      const target = await fs.stat(path.join(uri.fsPath, entry.name)).catch(() => undefined);
      return [entry.name, (target?.isDirectory() ? FileType.Directory : target ? FileType.File : FileType.Unknown) | FileType.SymbolicLink];
    }));
  }
} } };
Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
after(() => { Module._load = originalLoad; });

const dist = file => require(path.join(process.cwd(), 'dist/extension', file));
const { createSkillCatalogCapability } = dist('backend/capabilities/skillCatalog.js');
const { parseSkillFrontmatter } = dist('backend/capabilities/skillFrontmatter.js');
const { lookupSkill, describeSkillLookupFailure, renderLoadedSkill } = dist('backend/world/modules/skill/skillLookup.js');
const { skillCatalogWithinPolicy, requireSkillSourceConfigs } = dist('backend/world/modules/skill/policy.js');
const { composeSkillsToolDescription, SKILL_LISTING_MAX_CHARS } = dist('backend/world/modules/skill/skillDescription.js');
const { skillsTool } = dist('backend/world/modules/tools/definitions/skills/index.js');
const { frozenSkillPolicy } = dist('backend/reliableKernel/frozenAuthority.js');
const { frozenSkillPolicyDocument } = dist('backend/reliableKernel/childExecutionBoundary.js');
const { readWorkspaceTextFile } = dist('backend/capabilities/vscodeFs.js');

async function writeSkill(dir, frontmatter, body = '# Body\n') {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-skill-catalog-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const data = path.join(root, 'data');
  const context = { globalStorageUri: Uri.file(data), globalState: { get() { return undefined; } } };
  return { root, home, workspace, data, context, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('SKILL.md frontmatter follows YAML: block scalars, quotes, comments, nesting', () => {
  const parse = (text) => parseSkillFrontmatter(text).data;
  assert.equal(parse('---\ndescription: |\n  Line one.\n  Line two.\n---\n').description, 'Line one.\nLine two.\n');
  assert.equal(parse('---\ndescription: >-\n  Folded one\n  and two.\n\n  Next.\n---\n').description, 'Folded one and two.\nNext.');
  assert.equal(parse('---\r\nname: crlf\r\ndescription: CRLF\r\n---\r\nBody').description, 'CRLF');
  assert.equal(parse('﻿---\ndescription: "say \\"hi\\""\n---\n').description, 'say "hi"');
  assert.equal(parse("---\ndescription: 'it''s\n  folded'\n---\n").description, "it's folded");
  assert.equal(parse('---\ndescription: Use when: asked "x": always # note\n---\n').description, 'Use when: asked "x": always');
  assert.equal(parse('---\ndescription: a long\n  plain value\n---\n').description, 'a long plain value');
  const nested = parse('---\nname: top\nmetadata:\n  name: nested\n  short-description: short\n---\n');
  assert.equal(nested.name, 'top', 'a nested key never overrides the top-level one');
  assert.deepEqual(nested.metadata, { name: 'nested', 'short-description': 'short' });
  assert.deepEqual(parse('---\nallowed-tools:\n  - Read\n  - "Bash(git *)"\ntags: [a, "b, c"]\n---\n'), { 'allowed-tools': ['Read', 'Bash(git *)'], tags: ['a', 'b, c'] });
  assert.equal(parse('---\ndescription: foo --- bar\n---\n').description, 'foo --- bar');
  assert.deepEqual(parseSkillFrontmatter('---\n---\n# Title\n'), { data: {}, body: '# Title\n' }, 'an empty frontmatter is still stripped');
  assert.deepEqual(parseSkillFrontmatter('No frontmatter\n'), { data: {}, body: 'No frontmatter\n' });
  // The value on the following, indented lines (formatters write long descriptions this way).
  assert.deepEqual(parse('---\nname:\n  next-line\ndescription:\n  "Quoted: on the next line."\n---\n'),
    { name: 'next-line', description: 'Quoted: on the next line.' });
  assert.equal(parse("---\ndescription:\n  'single\n  folded'\n---\n").description, 'single folded');
  // A pathological line stays linear.
  const started = Date.now();
  parse(`---\na${' \t'.repeat(40_000)}b\n---\n`);
  assert.ok(Date.now() - started < 1_000, 'key parsing is linear in the line length');
});

test('the catalog finds skills of every agent tool: nested suites, symlinks, plugin namespaces, hidden skills', async () => {
  const f = await fixture();
  try {
    const project = (...parts) => path.join(f.workspace, ...parts);
    await writeSkill(project('.agents', 'skills', 'deploy'), 'name: deploy\ndescription: >-\n  Deploy the app\n  to staging.');
    // `npx skills` keeps one copy under .agents and links it into other agents' folders.
    await fs.mkdir(project('.claude', 'skills'), { recursive: true });
    await fs.symlink(project('.agents', 'skills', 'deploy'), project('.claude', 'skills', 'deploy'), 'dir');
    // A skill kept elsewhere and linked in.
    await writeSkill(path.join(f.root, 'library', 'linked'), 'name: linked\ndescription: Linked in.');
    await fs.symlink(path.join(f.root, 'library', 'linked'), project('.claude', 'skills', 'linked'), 'dir');
    // A plugin suite checked out (or linked) under a skills root: its manifest names the namespace.
    const suite = project('.claude', 'skills', 'superpowers');
    await fs.mkdir(path.join(suite, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(suite, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superpowers' }));
    await writeSkill(path.join(suite, 'skills', 'brainstorming'), 'name: brainstorming\ndescription: Explore ideas first.', 'Then use superpowers:writing-plans.\n');
    await writeSkill(path.join(suite, 'skills', 'writing-plans'), 'name: writing-plans\ndescription: Write the plan.');
    // A suite folder without a manifest is still searched.
    await writeSkill(project('.claude', 'skills', 'team', 'review'), 'name: review\ndescription: Review code.');
    // A link cycle and ignored folders never hang or leak into the catalog.
    await fs.symlink(project('.claude', 'skills'), project('.claude', 'skills', 'team', 'loop'), 'dir');
    await writeSkill(project('.claude', 'skills', 'node_modules', 'pkg'), 'name: pkg\ndescription: ignored');
    await writeSkill(project('.claude', 'skills', '.hidden', 'secret'), 'name: secret\ndescription: ignored');
    await writeSkill(project('.github', 'skills', 'triage'), 'name: triage\ndescription: Triage issues.\ndisable-model-invocation: true');
    await writeSkill(project('.codex', 'skills', 'codex-only'), 'name: codex-only\ndescription: Codex project skill.');
    await writeSkill(path.join(f.home, '.claude', 'skills', 'personal'), 'name: personal-name\ndescription: My skill.');
    await writeSkill(path.join(f.home, '.codex', 'skills', '.system', 'imagegen'), 'name: imagegen\ndescription: Make images.');
    await writeSkill(path.join(f.home, '.codex', 'skills', 'explicit'), 'name: explicit\ndescription: Only on request.');
    await fs.mkdir(path.join(f.home, '.codex', 'skills', 'explicit', 'agents'), { recursive: true });
    await fs.writeFile(path.join(f.home, '.codex', 'skills', 'explicit', 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
    await writeSkill(path.join(f.home, '.copilot', 'skills', 'copilot-skill'), 'description: No name given.');
    await writeSkill(path.join(f.data, 'skills', 'data-root'), 'name: data-root\ndescription: Data root skill.');
    // A second workspace folder with the same project skill name.
    await writeSkill(path.join(f.root, 'second', '.agents', 'skills', 'deploy'), 'name: deploy\ndescription: Second folder copy.');
    workspaceFolders.splice(0, workspaceFolders.length, { uri: Uri.file(f.workspace) }, { uri: Uri.file(path.join(f.root, 'second')) });

    const catalog = createSkillCatalogCapability(f.context, { homeDir: f.home, codexHome: path.join(f.home, '.codex') });
    await catalog.refresh();
    const byId = Object.fromEntries(catalog.list().map((skill) => [skill.id, skill]));
    assert.deepEqual(catalog.list().map((skill) => skill.id), [
      'skill:agents:deploy',
      'skill:claude:linked',
      'skill:claude:review',
      'skill:claude:superpowers:brainstorming',
      'skill:claude:superpowers:writing-plans',
      'skill:github:triage',
      'skill:codex:codex-only',
      'skill:user:copilot-skill',
      'skill:user:explicit',
      'skill:user:imagegen',
      'skill:user:personal',
      'skill:global:data-root'
    ]);
    assert.equal(byId['skill:agents:deploy'].description, 'Deploy the app to staging.');
    assert.equal(byId['skill:agents:deploy'].path, project('.agents', 'skills', 'deploy', 'SKILL.md'), 'the first workspace folder wins; its link in .claude is the same skill');
    assert.equal(byId['skill:claude:superpowers:brainstorming'].namespace, 'superpowers');
    assert.equal(byId['skill:github:triage'].hiddenFromModel, true);
    assert.equal(byId['skill:user:explicit'].hiddenFromModel, true);
    assert.deepEqual(byId['skill:user:personal'].aliases, ['personal-name']);

    const found = (query, source) => {
      const result = catalog.lookup(query, source);
      return result.status === 'found' ? result.skill.id : result.status;
    };
    assert.equal(found('superpowers:brainstorming'), 'skill:claude:superpowers:brainstorming');
    assert.equal(found('brainstorming'), 'skill:claude:superpowers:brainstorming', 'a bare name finds the namespaced skill');
    assert.equal(found('other-suite:review'), 'skill:claude:review', 'a namespaced reference finds a flat install');
    assert.equal(found('$deploy'), 'skill:agents:deploy');
    assert.equal(found('/linked'), 'skill:claude:linked');
    assert.equal(found('personal-name'), 'skill:user:personal');
    assert.equal(found('.codex:codex-only'), 'skill:codex:codex-only');
    assert.equal(found('DEPLOY'), 'skill:agents:deploy');
    assert.equal(found('triage'), 'skill:github:triage', 'a skill hidden from the listing still loads by name');
    assert.equal(found('nope'), 'missing');
    assert.deepEqual(await catalog.readBody(byId['skill:claude:superpowers:brainstorming']), { text: 'Then use superpowers:writing-plans.', startLine: 5 });
    assert.deepEqual(await catalog.readBody(byId['skill:claude:linked']), { text: '# Body', startLine: 5 });

    const description = composeSkillsToolDescription('BASE', catalog.list());
    assert.match(description, /- name: superpowers:brainstorming\n  source: \.claude\n  description: "Explore ideas first\."/);
    assert.doesNotMatch(description, /triage|explicit/, 'disable-model-invocation skills are not listed');
  } finally {
    workspaceFolders.splice(0, workspaceFolders.length);
    await f.cleanup();
  }
});

test('skill names resolve exactly before loosely, and ambiguity is reported', () => {
  const skill = (id, name, source, extra = {}) => ({ id, name, slug: name.split(':').pop(), source, description: '', path: `/${id}`, dir: `/${id}`, ...extra });
  const skills = [
    skill('skill:claude:pdf', 'pdf', 'claude'),
    // A copy of pdf whose frontmatter still says `name: pdf`.
    skill('skill:claude:my-pdf', 'my-pdf', 'claude', { aliases: ['pdf'] }),
    skill('skill:user:discord:access', 'discord:access', 'user', { namespace: 'discord' }),
    skill('skill:user:telegram:access', 'telegram:access', 'user', { namespace: 'telegram' })
  ];
  assert.equal(lookupSkill(skills, 'pdf').skill.id, 'skill:claude:pdf', 'the directory name wins over another skill\'s frontmatter name');
  assert.equal(lookupSkill(skills, 'telegram:access').skill.id, 'skill:user:telegram:access');
  assert.equal(lookupSkill(skills, 'superpowers:access').status, 'missing', 'another plugin\'s skill of that name is not a match');
  const ambiguous = lookupSkill(skills, 'access');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.name), ['discord:access', 'telegram:access']);
  assert.match(describeSkillLookupFailure('access', ambiguous, skills), /discord:access \(source user\), telegram:access \(source user\)/);
  assert.match(describeSkillLookupFailure('zip', { status: 'missing' }, skills), /未找到技能 "zip"。可用的技能：pdf, my-pdf, discord:access, telegram:access。/);
  assert.match(describeSkillLookupFailure('pdf', { status: 'missing', disabled: skills[0] }, skills), /已关闭/);
  assert.equal(
    renderLoadedSkill({ name: 'pdf', source: '.claude', baseDirectory: '/skills/pdf' }, 'Run ${CLAUDE_SKILL_DIR}/scripts/fill.py'),
    '<skill name="pdf" source=".claude">\nBase directory for this skill: /skills/pdf\n'
      + 'Relative paths in this skill (scripts/, references/, assets/, ...) resolve against this base directory: read them with the read tool by absolute path, and run bundled scripts by absolute path.\n\n'
      + 'Run /skills/pdf/scripts/fill.py\n</skill>'
  );
});

test('a turned-off skill is reported as such rather than resolved to a looser match', () => {
  const skill = (id, name, source, extra = {}) => ({ id, name, slug: name.split(':').pop(), source, description: '', path: `/${id}`, dir: `/${id}`, ...extra });
  const skills = [
    skill('skill:claude:pdf', 'pdf', 'claude'),
    skill('skill:claude:my-pdf', 'my-pdf', 'claude', { aliases: ['pdf'] }),
    skill('skill:user:github:pr-review', 'github:pr-review', 'user', { namespace: 'github' }),
    skill('skill:github:pr-review', 'pr-review', 'github'),
    skill('skill:claude:foo', 'foo', 'claude'),
    skill('skill:global:foo', 'foo', 'global')
  ];
  const catalog = { list: () => skills, lookup: (name, source) => lookupSkill(skills, name, source), async readBody() { return { text: '', startLine: 1 }; }, async refresh() {} };
  const bounded = skillCatalogWithinPolicy(catalog, { sourceConfigs: {
    claude: { enabled: true, disabledSkills: ['skill:claude:pdf', 'skill:claude:foo'] },
    user: { enabled: true, disabledSkills: ['skill:user:github:pr-review'] }
  } });
  assert.equal(bounded.lookup('pdf').disabled?.id, 'skill:claude:pdf', 'not the copy whose frontmatter reuses the name');
  assert.equal(bounded.lookup('github:pr-review').disabled?.id, 'skill:user:github:pr-review', 'a turned-off plugin keeps its namespace');
  assert.equal(bounded.lookup('foo').skill?.id, 'skill:global:foo', 'an equally exact enabled skill of another source is used');
});

test('the skills tool explains failures, reloads the catalog on a miss, and returns the base directory', async () => {
  const skills = [];
  let refreshes = 0;
  const catalog = {
    list: () => skills,
    lookup: (name, source) => lookupSkill(skills, name, source),
    async readBody(skill) { return { text: `body of ${skill.name}`, startLine: 4 }; },
    async refresh() {
      refreshes += 1;
      if (skills.length === 0) skills.push({ id: 'skill:claude:fresh', name: 'fresh', slug: 'fresh', source: 'claude', description: '', path: '/w/.claude/skills/fresh/SKILL.md', dir: '/w/.claude/skills/fresh' });
    }
  };
  const result = await skillsTool.execute({ name: 'fresh' }, { skills: catalog });
  assert.equal(refreshes, 1, 'a skill created a moment ago is found without a manual refresh');
  assert.deepEqual(result, { ok: true, output: {
    name: 'fresh', source: '.claude', baseDirectory: '/w/.claude/skills/fresh', entryPath: '/w/.claude/skills/fresh/SKILL.md', body: 'body of fresh', bodyStartLine: 4
  } });
  const missing = await skillsTool.execute({ name: 'absent' }, { skills: catalog });
  assert.equal(missing.ok, false);
  assert.match(missing.output, /可用的技能：fresh/);
  const bounded = skillCatalogWithinPolicy(catalog, { sourceConfigs: { claude: { enabled: false } } });
  const off = await skillsTool.execute({ name: 'fresh' }, { skills: bounded });
  assert.match(off.output, /已关闭/);
  assert.equal(refreshes, 2, 'a turned-off skill is not a reason to rescan');
  assert.deepEqual(skillsTool.declaration.parameters.properties.source.enum, ['.agents', '.claude', '.github', '.codex', 'user', 'global']);
});

test('the skill listing stays within its budget', () => {
  const skills = (count) => Array.from({ length: count }, (_, index) => ({ name: `skill-${index}`, source: 'user', description: 'x'.repeat(900) }));
  const header = 'BASE\n\nAvailable skills (YAML):\n'.length;
  const some = composeSkillsToolDescription('BASE', skills(200));
  assert.ok(some.length <= header + SKILL_LISTING_MAX_CHARS, `listing is ${some.length} chars`);
  assert.match(some, /- name: skill-0\n  source: user\n  description: "x{200,}…"/, 'early skills keep a shortened description');
  assert.match(some, /- name: skill-199\n  source: user$/, 'later skills are listed by name only');
  const many = composeSkillsToolDescription('BASE', skills(600));
  assert.ok(many.length <= header + SKILL_LISTING_MAX_CHARS + 100, `listing is ${many.length} chars`);
  assert.match(many, /\(\d+ more skills are not listed; load one by name when the user names it\.\)$/);
  assert.equal(composeSkillsToolDescription('BASE', [{ name: 'a', source: 'claude', description: '', hiddenFromModel: true }]), 'BASE\n\nAvailable skills: none.');
});

test('malformed skill settings are rejected instead of re-enabling a skill', () => {
  assert.deepEqual(requireSkillSourceConfigs({ claude: { enabled: true, disabledSkills: ['a', 'a'] }, user: { enabled: false } }, 'x'),
    { claude: { enabled: true, disabledSkills: ['a'] }, user: { enabled: false } });
  assert.throws(() => requireSkillSourceConfigs({ claude: { enabled: true, disabledSkills: 'skill:claude:deploy' } }, 'x'), /disabledSkills must be an array/);
  assert.throws(() => requireSkillSourceConfigs({ elsewhere: { enabled: true } }, 'x'), /not a skill source/);
  assert.throws(() => frozenSkillPolicy({ skillPolicy: { sourceConfigs: { claude: { enabled: 'no' } } } }), /enabled must be a boolean/);
  assert.throws(() => frozenSkillPolicyDocument({ skillPolicy: { id: 'p', sourceConfigs: { claude: { enabled: true, disabledSkills: 'deploy' } } } }), /disabledSkills must be an array/);
});

test('installed Claude Code plugins contribute their skills under the plugin namespace', async () => {
  const f = await fixture();
  try {
    const install = (name) => path.join(f.home, '.claude', 'plugins', 'cache', 'market', name, '1.0.0');
    for (const name of ['superpowers', 'muted']) {
      await fs.mkdir(path.join(install(name), '.claude-plugin'), { recursive: true });
      await fs.writeFile(path.join(install(name), '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
      await writeSkill(path.join(install(name), 'skills', 'brainstorming'), 'name: brainstorming\ndescription: Plugin skill.',
        'See skills/brainstorming/visual.md and ${CLAUDE_PLUGIN_ROOT}/README.md\n');
    }
    await fs.writeFile(path.join(f.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'superpowers@market': [{ scope: 'user', installPath: install('superpowers'), version: '1.0.0' }],
      'muted@market': [{ scope: 'user', installPath: install('muted'), version: '1.0.0' }],
      'elsewhere@market': [{ scope: 'project', projectPath: path.join(f.root, 'other-project'), installPath: install('superpowers') }]
    } }));
    await fs.writeFile(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@market': true, 'muted@market': false } }));
    const catalog = createSkillCatalogCapability(f.context, { homeDir: f.home, codexHome: path.join(f.home, '.codex') });
    await catalog.refresh();
    assert.deepEqual(catalog.list().map((skill) => skill.id), ['skill:user:superpowers:brainstorming'], 'a plugin turned off in settings is left out');
    const [skill] = catalog.list();
    assert.equal(skill.pluginRoot, install('superpowers'));
    const { renderSkillRecord } = dist('backend/world/modules/skill/skillLookup.js');
    const rendered = renderSkillRecord(skill, (await catalog.readBody(skill)).text);
    assert.match(rendered, new RegExp(`Plugin root: ${install('superpowers').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));
    assert.ok(rendered.includes(`${install('superpowers')}/README.md`), '${CLAUDE_PLUGIN_ROOT} is filled in');
  } finally {
    await f.cleanup();
  }
});

test('the catalog watches only what can change it, and re-aims after any refresh', async () => {
  const f = await fixture();
  const created = [];
  const listeners = [];
  vscode.workspace.createFileSystemWatcher = (pattern) => {
    const watcher = { pattern, disposed: false, handlers: {}, dispose() { this.disposed = true; } };
    for (const kind of ['Create', 'Change', 'Delete']) watcher[`onDid${kind}`] = (handler) => { watcher.handlers[kind] = handler; };
    created.push(watcher);
    return watcher;
  };
  vscode.workspace.onDidChangeWorkspaceFolders = (listener) => { listeners.push(listener); return { dispose() {} }; };
  try {
    await writeSkill(path.join(f.home, '.claude', 'skills', 'one'), 'name: one\ndescription: One.');
    const catalog = createSkillCatalogCapability(f.context, { homeDir: f.home, codexHome: path.join(f.home, '.codex') });
    await catalog.refresh();
    let changes = 0;
    const watching = catalog.watch(() => { changes += 1; });
    const live = () => created.filter((watcher) => !watcher.disposed);
    const bases = () => live().map((watcher) => watcher.pattern.base.fsPath ?? watcher.pattern.base.uri?.fsPath);
    assert.ok(bases().includes(path.join(f.home, '.claude', 'skills')));
    assert.equal(bases().includes(path.join(f.home, '.agents', 'skills')), false, 'a root that does not exist is not watched yet');
    const before = created.length;
    const skillsWatcher = live().find((watcher) => watcher.pattern.base.fsPath === path.join(f.home, '.claude', 'skills'));
    skillsWatcher.handlers.Change(Uri.file(path.join(f.home, '.claude', 'skills', 'one', 'scripts', 'out.log')));
    skillsWatcher.handlers.Create(Uri.file(path.join(f.home, '.claude', 'skills', 'one', '__pycache__', 'x')));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(changes, 0, 'a script writing inside a skill is not a catalog change');
    await writeSkill(path.join(f.home, '.agents', 'skills', 'two'), 'name: two\ndescription: Two.');
    await catalog.refresh();
    assert.equal(changes, 1, 'a manual refresh that finds a new skill notifies');
    assert.ok(bases().includes(path.join(f.home, '.agents', 'skills')), 'and starts watching the new root');
    const afterNewRoot = created.length;
    await catalog.refresh();
    assert.equal(created.length, afterNewRoot, 'an unchanged set of directories keeps its watchers');
    assert.ok(afterNewRoot > before);
    skillsWatcher.handlers.Change(Uri.file(path.join(f.home, '.claude', 'skills', 'one', 'SKILL.md')));
    await new Promise((resolve) => setTimeout(resolve, 400));
    watching.dispose();
    assert.equal(live().length, 0, 'disposing stops every watcher');
  } finally {
    delete vscode.workspace.createFileSystemWatcher;
    delete vscode.workspace.onDidChangeWorkspaceFolders;
    await f.cleanup();
  }
});

test('read serves a skill\'s bundled files even when paths outside the project are turned off', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-skill-read-'));
  try {
    const project = path.join(root, 'project');
    const skillDir = path.join(root, 'home', '.claude', 'skills', 'pdf');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'references', 'forms.md'), 'line 1\nline 2\n');
    await fs.writeFile(path.join(root, 'secret.txt'), 'no');
    workspaceFolders.splice(0, workspaceFolders.length, { uri: Uri.file(project) });
    const options = { allowOutsideProjectPaths: false, localReadOnlyRoots: [skillDir] };
    const read = await readWorkspaceTextFile(path.join(skillDir, 'references', 'forms.md'), undefined, undefined, options);
    assert.match(read.content, /1 line 1\n2 line 2/);
    await assert.rejects(readWorkspaceTextFile(path.join(root, 'secret.txt'), undefined, undefined, options), /路径超出当前项目/);
    // A link inside the skill that leads out of it grants nothing.
    await fs.symlink(root, path.join(skillDir, 'up'), 'dir');
    await assert.rejects(readWorkspaceTextFile(path.join(skillDir, 'up', 'secret.txt'), undefined, undefined, options), /路径超出当前项目/);
  } finally {
    workspaceFolders.splice(0, workspaceFolders.length);
    await fs.rm(root, { recursive: true, force: true });
  }
});
