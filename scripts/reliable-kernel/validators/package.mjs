import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import {
  DEFAULT_BASELINE_RELATIVE_PATH,
  validateBaselineFile
} from '../lib/baseline-contract.mjs';
import {
  validatePackagedEmptyRoot,
  validatePackagedPhysicalCutover
} from '../lib/package-artifact-checks.mjs';
import {
  createInstalledSmokeEvidence,
  validateInstalledSmokeCheck
} from '../lib/installed-smoke-evidence.mjs';
import { isPathBelow } from '../lib/path-containment.mjs';
import { readZipArchive } from '../lib/zip-archive.mjs';

// package 出口校验器：stable check.id -> handler。
// 只登记已有真实实现；其余 installed/migration/smoke checks 保持 PENDING。
const GROUP_ID = 'package';
const root = process.cwd();

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const commit = option('commit');
const artifact = option('artifact');
const installedRoot = option('installed-root');
const installedDataRoot = option('installed-data-root');
const smokeWorkspaceRoot = option('smoke-workspace-root');
const smokeReceipt = option('smoke-receipt');
const registry = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/architecture/reliable-kernel/contracts/gate-registry.json'), 'utf8')
);
const group = (registry.validatorGroups ?? []).find((entry) => entry.id === GROUP_ID);
if (!group) {
  console.error(`gate-registry.json缺少校验器组：${GROUP_ID}`);
  process.exit(2);
}
const gate = (registry.gates ?? []).find((entry) => entry.id === group.introducedAt);
const stageLabel = (gate?.stages ?? []).join('-') || '未知';

function requireArtifact() {
  if (!artifact) throw new Error('缺少--artifact本机VSIX路径');
  const absolute = path.resolve(root, artifact);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`安装包不存在或不是普通文件：${artifact}`);
  return absolute;
}

const vsixArchives = new Map();
function readVsixArchive(absolute) {
  if (!vsixArchives.has(absolute)) vsixArchives.set(absolute, readZipArchive(fs.readFileSync(absolute)));
  return vsixArchives.get(absolute);
}

function unzipEntry(absolute, entry, options = {}) {
  const bytes = readVsixArchive(absolute).read(entry, options.maxBuffer ?? 16 * 1024 * 1024);
  if (!bytes) throw new Error(`无法从VSIX读取${entry}：文件不存在`);
  return options.encoding ? bytes.toString(options.encoding) : bytes;
}

function readVsixManifest(absolute) {
  const text = unzipEntry(absolute, 'extension/package.json', { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error('VSIX内package.json不是有效JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('VSIX内package.json必须是JSON对象');
  return manifest;
}

function readVsixMainEntry(absolute) {
  const manifest = readVsixManifest(absolute);
  const main = typeof manifest.main === 'string' ? manifest.main.replace(/^\.\//, '') : '';
  if (!main || path.posix.isAbsolute(main) || main.includes('\\') || main.split('/').includes('..')) {
    throw new Error('VSIX package.json.main缺失或不是安全的包内相对路径');
  }
  return main;
}

function listVsixFiles(absolute) {
  return readVsixArchive(absolute).names
    .map((file) => file.replace(/^extension\//, ''))
    .filter(Boolean)
    .sort();
}

const forbidden = [
  {
    id: '测试',
    match: (file) => {
      const base = path.posix.basename(file);
      return /(^|\/)(?:test|tests|spec|specs|__tests__)\//i.test(file)
        || /^(?:test|spec)-/i.test(base)
        || /^(?:tests?|specs?)\.(?:[cm]?js|tsx?|jsx?)$/i.test(base)
        || /\.(?:test|spec)\.[^/]+$/i.test(base);
    }
  },
  { id: '夹具', match: (file) => /(^|\/)fixtures?\//i.test(file) },
  {
    id: '基准',
    match: (file) => {
      const base = path.posix.basename(file);
      return /(^|\/)benchmarks?\//i.test(file)
        || /^benchmark-/i.test(base)
        || /\.benchmark\.[^/]+$/i.test(base);
    }
  },
  { id: '正式或基准脚本', match: (file) => /^scripts\//.test(file) },
  {
    id: '未批准的根级Markdown',
    match: (file) => !file.includes('/') && file.toLowerCase().endsWith('.md') && file.toLowerCase() !== 'readme.md'
  },
  { id: '内部架构文档', match: (file) => /(^|\/)docs\/architecture\//.test(file) },
  { id: '内部工具报告', match: (file) => /(^|\/)\.ide-tool-test\//.test(file) },
  { id: 'TypeScript或Vue源码', match: (file) => /^(backend|shared|vscode|webview)\/.*\.(?:ts|tsx|vue)$/.test(file) },
  { id: '嵌套VSIX', match: (file) => file.endsWith('.vsix') },
  { id: '运行数据库', match: (file) => /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/.test(file) || /-(?:wal|shm)$/.test(file) },
  { id: '原始日志或环境文件', match: (file) => /(^|\/)(?:\.env(?:\..*)?|.*\.(?:log|trace))$/.test(file) }
];

function checkVsixFileListing() {
  const absolute = requireArtifact();
  const files = listVsixFiles(absolute);
  const problems = [];
  for (const rule of forbidden) {
    const matches = files.filter(rule.match);
    if (matches.length) problems.push(`${rule.id}: ${matches.slice(0, 8).join(', ')}${matches.length > 8 ? ` (+${matches.length - 8})` : ''}`);
  }
  const manifest = readVsixManifest(absolute);
  const required = ['package.json', readVsixMainEntry(absolute)];
  for (const file of required) if (!files.includes(file)) problems.push(`缺少必需文件：${file}`);
  const activationEvents = new Set(Array.isArray(manifest.activationEvents) ? manifest.activationEvents : []);
  const implicitContributionActivation = supportsImplicitContributionActivation(manifest.engines?.vscode);
  if (!implicitContributionActivation) {
    for (const command of manifest.contributes?.commands ?? []) {
      if (typeof command?.command === 'string' && !activationEvents.has(`onCommand:${command.command}`)) {
        problems.push(`命令缺少首次安装激活事件：${command.command}`);
      }
    }
    for (const entries of Object.values(manifest.contributes?.views ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const view of entries) {
        if (typeof view?.id === 'string' && !activationEvents.has(`onView:${view.id}`)) problems.push(`视图缺少首次安装激活事件：${view.id}`);
      }
    }
  }
  if (!files.some((file) => file.toLowerCase() === 'readme.md')) problems.push('缺少README');
  if (!files.some((file) => /^license(?:\.[^/]+)?$/i.test(file))) problems.push('缺少LICENSE');
  if (!files.includes('dist/build-provenance.json')) problems.push('缺少构建来源文件：dist/build-provenance.json');
  if (!files.some((file) => file.startsWith('dist/webview/') && file.endsWith('.html'))) problems.push('缺少编译后的网页视图HTML');
  if (!files.some((file) => file.startsWith('dist/webview/') && file.endsWith('.css'))) problems.push('缺少编译后的网页视图CSS');
  return problems.length ? `${files.length}个文件中发现问题：${problems.join('；')}` : null;
}

function supportsImplicitContributionActivation(engineRange) {
  if (typeof engineRange !== 'string') return false;
  const match = /^\s*\^?(\d+)\.(\d+)(?:\.\d+)?/.exec(engineRange);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 74);
}

function readBuildProvenance(absolute) {
  const text = unzipEntry(absolute, 'extension/dist/build-provenance.json', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  let provenance;
  try {
    provenance = JSON.parse(text);
  } catch {
    throw new Error('dist/build-provenance.json不是有效JSON');
  }
  if (typeof provenance.commitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(provenance.commitSha)) throw new Error('build provenance.commitSha不是40位Git SHA');
  if (typeof provenance.buildId !== 'string' || !provenance.buildId) throw new Error('build provenance.buildId缺失');
  if (typeof provenance.mainEntrySha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(provenance.mainEntrySha256)) throw new Error('build provenance.mainEntrySha256不是64位SHA-256');
  if (typeof provenance.worktreeClean !== 'boolean') throw new Error('build provenance.worktreeClean不是boolean');
  return provenance;
}

function checkBuildProvenanceCommit() {
  const provenance = readBuildProvenance(requireArtifact());
  const problems = [];
  const identity = JSON.parse(unzipEntry(requireArtifact(), 'extension/dist/extension/compile-build-id.json', { encoding: 'utf8' }));
  if (identity.buildId !== provenance.buildId) problems.push('安装包的编译身份与build provenance不一致');
  if (provenance.worktreeClean !== true) problems.push('安装包构建时工作区不是干净状态');
  if (!commit) problems.push('缺少--commit，无法核对当前干净提交');
  else if (provenance.commitSha !== commit) problems.push(`安装包来自提交${provenance.commitSha}，与当前提交${commit}不一致`);
  return problems.length ? problems.join('；') : null;
}

function checkInstalledMainEntryDigest() {
  if (!installedRoot) return '缺少--installed-root，无法核对真实安装目录';
  const absoluteInstalledRoot = path.resolve(root, installedRoot);
  const installedManifestPath = path.join(absoluteInstalledRoot, 'package.json');
  if (!fs.existsSync(installedManifestPath)) return `安装目录缺少package.json：${absoluteInstalledRoot}`;
  let installedManifest;
  try {
    installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, 'utf8'));
  } catch {
    return '安装目录package.json不是有效JSON';
  }
  const vsixManifest = readVsixManifest(requireArtifact());
  for (const key of ['publisher', 'name', 'version']) {
    if (installedManifest[key] !== vsixManifest[key]) return `安装目录${key}与VSIX不一致`;
  }
  const installedMain = typeof installedManifest.main === 'string' ? installedManifest.main.replace(/^\.\//, '') : '';
  const vsixMain = readVsixMainEntry(requireArtifact());
  if (installedMain !== vsixMain) return `安装目录main ${installedMain}与VSIX ${vsixMain}不一致`;
  const installedMainPath = path.resolve(absoluteInstalledRoot, installedMain);
  if (!isPathBelow(absoluteInstalledRoot, installedMainPath) || !fs.existsSync(installedMainPath)) {
    return '安装目录main路径逃逸或缺失';
  }
  const installedDigest = crypto.createHash('sha256').update(fs.readFileSync(installedMainPath)).digest('hex');
  const vsixBytes = unzipEntry(requireArtifact(), `extension/${vsixMain}`, { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  const vsixDigest = crypto.createHash('sha256').update(vsixBytes).digest('hex');
  return installedDigest === vsixDigest ? null : `安装入口摘要${installedDigest}与VSIX入口摘要${vsixDigest}不一致`;
}

function checkVsixMainEntryDigest() {
  const absolute = requireArtifact();
  const provenance = readBuildProvenance(absolute);
  let main;
  try {
    main = readVsixMainEntry(absolute);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  let bytes;
  try {
    bytes = unzipEntry(absolute, `extension/${main}`, { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  return actual === provenance.mainEntrySha256
    ? null
    : `VSIX真实入口${main}摘要${actual}与provenance.mainEntrySha256 ${provenance.mainEntrySha256}不一致`;
}

function readPackageRuntimeClosure(absolute) {
  const text = unzipEntry(absolute, 'extension/dist/package-runtime-closure.json', { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error('dist/package-runtime-closure.json不是有效JSON');
  }
  if (manifest?.kind !== 'limcode-package-runtime-closure' || !Array.isArray(manifest.files) || !Array.isArray(manifest.seeds)) {
    throw new Error('package runtime closure manifest格式无效');
  }
  const files = manifest.files.map((entry) => {
    if (
      !entry || typeof entry.path !== 'string'
      || !/^dist\/extension\/[A-Za-z0-9_./-]+\.js$/.test(entry.path)
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) throw new Error('package runtime closure entry无效');
    return entry;
  });
  if (files.length !== manifest.fileCount || new Set(files.map((entry) => entry.path)).size !== files.length) {
    throw new Error('package runtime closure数量或identity不一致');
  }
  return { ...manifest, files };
}

const legacyRuntimePaths = [
  '/backend/reliability/',
  '/backend/application/BackendApplication.js',
  '/backend/application/WebviewMessageRouter.js',
  '/backend/application/GlobalSettingsBridge.js',
  '/backend/application/ConversationSettingsBridge.js',
  '/backend/application/WebviewClientRegistry.js',
  '/backend/world/modules/agentRun/',
  '/backend/application/conversationFork.js',
  '/backend/capabilities/vscodeStorage/clientStateStore.js',
  '/shared/runLifecycle.js',
  '/shared/agentRunActivity.js'
];

let packagedRuntimeClosureResult;
function checkPackagedRuntimeClosure() {
  if (packagedRuntimeClosureResult === undefined) packagedRuntimeClosureResult = packagedRuntimeClosureProblem();
  return packagedRuntimeClosureResult;
}

function packagedRuntimeClosureProblem() {
  const absolute = requireArtifact();
  const manifest = readPackageRuntimeClosure(absolute);
  const listed = listVsixFiles(absolute);
  const packageJs = listed.filter((file) => file.startsWith('dist/extension/') && file.endsWith('.js'));
  const manifestPaths = manifest.files.map((entry) => entry.path).sort();
  if (JSON.stringify(packageJs) !== JSON.stringify(manifestPaths)) {
    return `VSIX Runtime JS集合(${packageJs.length})与closure manifest(${manifestPaths.length})不一致`;
  }
  const sources = new Map();
  for (const entry of manifest.files) {
    const bytes = unzipEntry(absolute, `extension/${entry.path}`, { encoding: null, maxBuffer: 64 * 1024 * 1024 });
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256) return `${entry.path}摘要与package runtime closure manifest不一致`;
    sources.set(entry.path, bytes.toString('utf8'));
  }
  const graph = computeVsixRequireClosure(manifest.seeds, new Set(listed), sources);
  if (JSON.stringify([...graph].sort()) !== JSON.stringify(manifestPaths)) {
    return `独立重算require图(${graph.size})与manifest(${manifestPaths.length})不一致`;
  }
  for (const file of graph) {
    const normalized = `/${file.replace(/^dist\/extension\//, '')}`;
    const selector = legacyRuntimePaths.find((candidate) => normalized.includes(candidate));
    if (selector) return `最终require图仍可达${normalized}（命中${selector}）`;
  }
  const entryProblems = dirnameEntryProblems(sources, new Set(manifestPaths));
  return entryProblems.length > 0 ? entryProblems.join('；') : null;
}

/**
 * Code started by its path next to the starting file (path.join or path.resolve of __dirname and one
 * literal) instead of require(): worker threads and child processes. No require() graph reaches
 * them, so the package keeps one only as a seed (prune-package-dist.mjs): a packaged file that starts
 * one the VSIX lacks fails only when that code path runs. Registered with the boundary it is started
 * across: 'worker' (workerData and messages are structured clones: also in
 * INTERNAL_STRUCTURED_CLONE_PATHS) or 'process' (argv strings and stdio bytes, no structured clone).
 */
const DIRNAME_ENTRY_BOUNDARIES = new Map([
  ['dist/extension/backend/reliableKernel/databaseWorker.js', 'worker'],
  ['dist/extension/backend/reliableKernel/packedCasWorker.js', 'worker'],
  ['dist/extension/backend/reliableKernel/runtimeSnapshotAuditWorker.js', 'worker'],
  ['dist/extension/backend/reliableKernel/runtimeSnapshotUpgradeWorker.js', 'worker'],
  ['dist/extension/backend/reliableKernel/runtimeDataSetFactsWorker.js', 'worker'],
  ['dist/extension/backend/reliableKernel/runtimeDataRootRelocationWorker.js', 'worker'],
  ['dist/extension/backend/reliableKernel/processWrapper.js', 'process']
]);

/** __dirname uses that start no code, by file: the literal path each resolves (e.g. the extension root for its provenance file). */
const DIRNAME_RESOURCE_USES = new Map([
  ['dist/extension/backend/application/runtimeBuildIdentity.js', new Set(['../../compile-build-id.json'])]
]);

/**
 * Every __dirname use of the packaged Runtime closure: a started entry must be registered
 * (DIRNAME_ENTRY_BOUNDARIES, started the way it is registered), be in the VSIX closure, and a worker
 * be a registered structured-clone boundary; any other use must be a registered resource path. A
 * registration nothing uses any more is reported too.
 */
function dirnameEntryProblems(sources, closure) {
  const problems = [];
  const started = new Set();
  const resources = new Set();
  const literalPath = /\.(?:join|resolve)\)?\(\s*__dirname\s*,\s*(['"])([^'"\n]+)\1\s*\)/y;
  for (const [file, source] of [...sources].sort(([left], [right]) => left.localeCompare(right))) {
    for (const match of source.matchAll(/\b__dirname\b/g)) {
      const callStart = source.lastIndexOf('(', match.index);
      const memberStart = Math.max(source.lastIndexOf('.join', callStart), source.lastIndexOf('.resolve', callStart));
      literalPath.lastIndex = memberStart;
      const call = memberStart >= 0 && match.index - memberStart <= 16 ? literalPath.exec(source) : null;
      if (!call) {
        const line = source.slice(source.lastIndexOf('\n', match.index) + 1, source.indexOf('\n', match.index)).trim().slice(0, 160);
        problems.push(`${file}有未登记的__dirname用法（只认path.join/resolve(__dirname, '单个字面量')）：${line}`);
        continue;
      }
      const literal = call[2];
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), literal));
      if (!/\.[cm]?js$/.test(literal)) {
        if (DIRNAME_RESOURCE_USES.get(file)?.has(literal)) resources.add(`${file}\0${literal}`);
        else problems.push(`${file}有未登记的__dirname资源路径：${literal}`);
        continue;
      }
      const before = source.slice(Math.max(0, memberStart - 240), memberStart);
      const kind = /new\s+[\w$.]*Worker\(\s*[\w$]*$/.test(before) ? 'worker'
        : /\b(?:spawn|fork|execFile|spawnSync|execFileSync)\)?\([^;]*$/.test(before) ? 'process' : 'unknown';
      started.add(target);
      const registered = DIRNAME_ENTRY_BOUNDARIES.get(target);
      if (!registered) problems.push(`${file}按__dirname启动了未登记的入口${target}（${kind}）：登记它的边界并加进prune-package-dist.mjs的seedPaths`);
      else if (registered !== kind) problems.push(`${file}启动${target}的方式（${kind}）与登记的边界（${registered}）不一致`);
      if (!closure.has(target)) problems.push(`${file}按__dirname启动的${target}不在VSIX Runtime闭包里：安装后这条代码路径必然失败，需加进prune-package-dist.mjs的seedPaths`);
      if (registered === 'worker' && !INTERNAL_STRUCTURED_CLONE_PATHS.has(target)) problems.push(`worker入口${target}没有登记为structured-clone边界`);
    }
  }
  for (const target of DIRNAME_ENTRY_BOUNDARIES.keys()) {
    if (!started.has(target)) problems.push(`登记的__dirname入口${target}没有被VSIX里的任何文件启动（撤掉登记，或补上启动它的文件）`);
  }
  for (const [file, literals] of DIRNAME_RESOURCE_USES) {
    for (const literal of literals) if (!resources.has(`${file}\0${literal}`)) problems.push(`登记的__dirname资源路径${file}：${literal}已不在VSIX里`);
  }
  return problems;
}

function checkVsixLegacyEntriesAbsent() {
  const files = listVsixFiles(requireArtifact());
  for (const file of files) {
    if (!file.startsWith('dist/extension/')) continue;
    const normalized = `/${file.replace(/^dist\/extension\//, '')}`;
    const selector = legacyRuntimePaths.find((candidate) => normalized.includes(candidate));
    if (selector) return `VSIX仍包含旧入口${file}（命中${selector}）`;
  }
  return null;
}

function checkSourceSymbolsRemoved() {
  const ledgerPath = path.join(root, 'docs/architecture/reliable-kernel/contracts/transition-ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const failures = [];
  for (const entry of ledger.entries ?? []) {
    if (entry.deleteStage !== 'G') continue;
    const selector = entry.selector;
    if (!selector || typeof selector.path !== 'string' || typeof selector.symbol !== 'string') {
      failures.push(`${entry.key}: selector无效`);
      continue;
    }
    const absolute = path.join(root, selector.path);
    if (!fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, 'utf8');
    const symbolPresent = new RegExp(`\\b${escapeRegExp(selector.symbol)}\\b`).test(source);
    if (!symbolPresent) continue;
    if (typeof selector.member === 'string') {
      const memberPresent = selector.member.includes('.')
        ? source.includes(selector.member)
        : new RegExp(`\\b${escapeRegExp(selector.member)}\\b`).test(source);
      if (!memberPresent) continue;
    }
    failures.push(`${entry.key}:${selector.path}#${selector.symbol}${selector.member ? `.${selector.member}` : ''}`);
  }
  return failures.length > 0
    ? `仍存在${failures.length}个Phase G旧源码selector：${failures.slice(0, 12).join('，')}${failures.length > 12 ? `（另${failures.length - 12}项）` : ''}`
    : null;
}

/** Extension-internal postMessage boundaries: worker threads and their launchers (structured clones between threads of this process). */
const INTERNAL_STRUCTURED_CLONE_PATHS = new Set([
  'dist/extension/backend/reliableKernel/databaseWorker.js',
  'dist/extension/backend/reliableKernel/packedCasWorker.js',
  'dist/extension/backend/reliableKernel/runtimeDatabase.js',
  'dist/extension/backend/reliableKernel/runtimeSnapshotAuditWorker.js',
  'dist/extension/backend/reliableKernel/runtimeSnapshotUpgrade.js',
  'dist/extension/backend/reliableKernel/runtimeSnapshotUpgradeWorker.js',
  'dist/extension/backend/reliableKernel/runtimeDataSetFactsWorker.js',
  'dist/extension/backend/reliableKernel/runtimeDataRootRelocationWorker.js'
]);

function checkBridgePayloadPlain() {
  const absolute = requireArtifact();
  const manifest = readPackageRuntimeClosure(absolute);
  const runtimeSources = new Map(manifest.files.map((entry) => [
    entry.path,
    unzipEntry(absolute, `extension/${entry.path}`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  ]));
  const boundarySpecs = [
    {
      path: 'dist/extension/backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js',
      marker: 'reliable configuration broadcast',
      postPattern: /webview\.postMessage\(plain\)/
    },
    {
      path: 'dist/extension/backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js',
      marker: 'reliable command result',
      postPattern: /webview\.postMessage\(\(0, [A-Za-z0-9_]+\.toStructuredClonePlainData\)\(message,/
    },
    {
      path: 'dist/extension/backend/application/reliableKernel/GlobalSettingsSaveBarrier.js',
      marker: 'global settings flush message',
      postPattern: /client\.postMessage\(\(0, [A-Za-z0-9_]+\.toStructuredClonePlainData\)\(/
    },
    {
      path: 'dist/extension/backend/reliableKernel/webviewFeedBridge.js',
      marker: 'reliable kernel webview message',
      postPattern: /client\.webview\.postMessage\(plain\)/
    },
    {
      path: 'dist/extension/vscode/views/SidebarEntryView.js',
      marker: 'sidebar webview message',
      postPattern: /webview\.postMessage\(\(0, [A-Za-z0-9_]+\.toStructuredClonePlainData\)\(message,/
    }
  ];
  const webviewBoundaryPaths = new Set(boundarySpecs.map((entry) => entry.path));
  const internalStructuredClonePaths = INTERNAL_STRUCTURED_CLONE_PATHS;
  const problems = [];

  for (const spec of boundarySpecs) {
    const source = runtimeSources.get(spec.path);
    if (!source) {
      problems.push(`VSIX Runtime闭包缺少Webview边界：${spec.path}`);
      continue;
    }
    const postCount = [...source.matchAll(/\.postMessage\s*\(/g)].length;
    if (postCount !== 1) problems.push(`${spec.path}应只有一个集中Webview postMessage边界，实际${postCount}个`);
    if (!source.includes('toStructuredClonePlainData') || !source.includes(spec.marker) || !spec.postPattern.test(source)) {
      problems.push(`${spec.path}没有以${spec.marker} sanitizer结果调用postMessage`);
    }
  }

  for (const [file, source] of runtimeSources) {
    if (!/\.postMessage\s*\(/.test(source)) continue;
    if (webviewBoundaryPaths.has(file) || internalStructuredClonePaths.has(file)) continue;
    problems.push(`发现未登记的Extension postMessage边界：${file}`);
  }

  const plainDataProblem = exercisePackagedPlainData(absolute);
  if (plainDataProblem) problems.push(plainDataProblem);

  const files = listVsixFiles(absolute);
  const webviewScripts = files.filter((file) => file.startsWith('dist/webview/assets/') && file.endsWith('.js'));
  const hostBundles = [];
  let hasBridgeSanitizer = false;
  for (const file of webviewScripts) {
    const source = unzipEntry(absolute, `extension/${file}`, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (source.includes('bridge message')) hasBridgeSanitizer = true;
    if (source.includes('acquireVsCodeApi')) hostBundles.push({ file, source });
  }
  if (!hasBridgeSanitizer) problems.push('Webview bundle缺少bridge message plain-data sanitizer');
  if (hostBundles.length === 0) problems.push('Webview bundle缺少VS Code Host API边界');
  for (const { file, source } of hostBundles) {
    const markerIndex = source.indexOf('VS Code host message');
    const neighborhood = markerIndex < 0 ? '' : source.slice(Math.max(0, markerIndex - 240), markerIndex + 80);
    if (markerIndex < 0 || !neighborhood.includes('.postMessage(')) {
      problems.push(`${file}的acquireVsCodeApi postMessage未经过VS Code host message sanitizer`);
    }
  }

  return problems.length > 0 ? problems.join('；') : null;
}

function exercisePackagedPlainData(absolute) {
  const source = unzipEntry(absolute, 'extension/dist/extension/shared/plainData.js', {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  const moduleExports = {};
  const context = vm.createContext({
    exports: moduleExports,
    module: { exports: moduleExports }
  }, {
    name: 'limcode-packaged-plain-data-check',
    codeGeneration: { strings: false, wasm: false }
  });
  try {
    vm.runInContext(source, context, {
      filename: 'extension/dist/extension/shared/plainData.js',
      timeout: 1000
    });
    return vm.runInContext(`(() => {
      const copy = exports.toStructuredClonePlainData;
      if (typeof copy !== 'function') return 'VSIX plainData未导出toStructuredClonePlainData';
      const proxy = new Proxy({
        text: 'ok', nested: { count: 2 }, optional: undefined, list: [true, undefined]
      }, {});
      const plain = copy(proxy, 'package oracle');
      if (Object.getPrototypeOf(plain) !== Object.prototype) return 'Proxy没有复制为普通Object';
      if (Object.getPrototypeOf(plain.nested) !== Object.prototype) return '嵌套值没有复制为普通Object';
      if (JSON.stringify(plain) !== '{"text":"ok","nested":{"count":2},"list":[true,null]}') {
        return 'plain-data递归复制结果不符合合同';
      }
      const cycle = {};
      cycle.self = cycle;
      const forbidden = [
        new Map(), new Set(), new Date(), /x/, new (class Example {})(),
        1n, Symbol('x'), () => undefined, { number: Infinity }, cycle
      ];
      for (const value of forbidden) {
        let rejected = false;
        try { copy(value, 'forbidden package oracle'); } catch { rejected = true; }
        if (!rejected) return 'plain-data sanitizer接受了合同禁止值';
      }
      return null;
    })()`, context, { timeout: 1000 });
  } catch (error) {
    return `无法执行VSIX plain-data sanitizer：${error instanceof Error ? error.message : String(error)}`;
  }
}

function checkBaselinesNonPlaceholder() {
  const result = validateBaselineFile({
    root,
    baselinePath: option('baseline') ?? DEFAULT_BASELINE_RELATIVE_PATH,
    expectedCommit: commit ?? undefined
  });
  if (result.problems.length > 0) return result.problems.join('；');
  const summary = result.summary;
  console.log(
    `PASS: package.baselines-non-placeholder — ${result.baselinePath}，`
      + `commit=${summary.commitSha}，build=${summary.buildDurationMs}ms，`
      + `package=${summary.packageDurationMs}ms，vsix=${summary.vsixBytes} bytes。`
  );
  return null;
}

let packagedPhysicalCutoverResult;
function checkPhysicalCutover() {
  packagedPhysicalCutoverResult ??= validatePackagedPhysicalCutover({ artifactPath: requireArtifact(), root });
  if (packagedPhysicalCutoverResult.output) console.log(packagedPhysicalCutoverResult.output);
  return packagedPhysicalCutoverResult.problem;
}

let packagedEmptyRootResult;
function checkEmptyRoot() {
  packagedEmptyRootResult ??= validatePackagedEmptyRoot({ artifactPath: requireArtifact(), root });
  if (packagedEmptyRootResult.output) console.log(packagedEmptyRootResult.output);
  return packagedEmptyRootResult.problem;
}

let installedSmokeEvidence;
function requireInstalledSmokeEvidence() {
  if (!smokeReceipt) throw new Error('缺少--smoke-receipt installed smoke回执');
  if (!installedRoot) throw new Error('缺少--installed-root真实安装目录');
  if (!installedDataRoot) throw new Error('缺少--installed-data-root真实数据根');
  if (!smokeWorkspaceRoot) throw new Error('缺少--smoke-workspace-root临时Workspace');
  installedSmokeEvidence ??= createInstalledSmokeEvidence({
    receiptPath: smokeReceipt,
    artifactPath: requireArtifact(),
    installedRoot,
    dataRoot: installedDataRoot,
    workspaceRoot: smokeWorkspaceRoot
  });
  return installedSmokeEvidence;
}

function checkInstalledSmoke(checkId) {
  const problem = validateInstalledSmokeCheck(requireInstalledSmokeEvidence(), checkId);
  if (problem) return problem;
  if (checkId === 'package.smoke.recovery-verification') return checkOutcomeUnknownRecoveryOracle();
  return null;
}

let outcomeUnknownRecoveryOracle;
function checkOutcomeUnknownRecoveryOracle() {
  if (outcomeUnknownRecoveryOracle !== undefined) return outcomeUnknownRecoveryOracle;
  const run = childProcess.spawnSync(
    process.execPath,
    ['scripts/reliable-kernel/run-phase-d-check.mjs', '--check=candidate.recovery.effect-intent-hanging'],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const output = [run.stdout, run.stderr].filter(Boolean).join('\n').trim();
  outcomeUnknownRecoveryOracle = run.error || run.status !== 0 || !/PASS: candidate\.recovery\.effect-intent-hanging/.test(run.stdout ?? '')
    ? `outcome_unknown recovery oracle失败：${run.error?.message ?? (output || `退出码${run.status}`)}`
    : null;
  return outcomeUnknownRecoveryOracle;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function computeVsixRequireClosure(seeds, listed, sources) {
  const graph = new Set();
  const stack = seeds.map((seed) => `dist/extension/${seed}`);
  while (stack.length > 0) {
    const file = stack.pop();
    if (graph.has(file)) continue;
    if (!listed.has(file)) throw new Error(`require图入口或依赖不在VSIX：${file}`);
    graph.add(file);
    if (!file.endsWith('.js')) continue;
    const source = sources.get(file);
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const base = path.posix.resolve(path.posix.dirname(`/${file}`), specifier).slice(1);
      const candidates = path.posix.extname(base)
        ? [base]
        : [base, `${base}.js`, `${base}.json`, `${base}/index.js`];
      const target = candidates.find((candidate) => listed.has(candidate));
      if (!target) throw new Error(`VSIX relative require无法解析：${specifier} from ${file}`);
      stack.push(target);
    }
  }
  return new Set([...graph].filter((file) => file.endsWith('.js')));
}

/** @type {Map<string, () => string | null>} */
const implemented = new Map([
  ['package.legacy-runtime-archived', checkPhysicalCutover],
  ['package.legacy-entry-unreachable', checkPackagedRuntimeClosure],
  ['package.surface-forbidden-files', checkVsixFileListing],
  ['package.configuration-manifest', checkPhysicalCutover],
  ['package.provenance-clean-commit', checkBuildProvenanceCommit],
  ['package.provenance-vsix-main-entry-digest', checkVsixMainEntryDigest],
  ...(installedRoot ? [['package.installed-main-entry-digest', checkInstalledMainEntryDigest]] : []),
  ['package.empty-root', checkEmptyRoot],
  ['package.runtime-epoch', checkEmptyRoot],
  ['package.source-symbols-removed', checkSourceSymbolsRemoved],
  ['package.dist-import-unreachable', checkPackagedRuntimeClosure],
  ['package.vsix-legacy-entry-absent', checkVsixLegacyEntriesAbsent],
  ['package.bridge-payload-plain', checkBridgePayloadPlain],
  ['package.baselines-non-placeholder', checkBaselinesNonPlaceholder],
  ...(smokeReceipt ? [
    'package.smoke.open-extension',
    'package.smoke.send-message',
    'package.smoke.read-only-tool',
    'package.smoke.file-proposal-approve-apply',
    'package.smoke.command-run-and-wait',
    'package.smoke.subagent-start-and-cancel',
    'package.smoke.turn-interrupt',
    'package.smoke.extension-host-restart',
    'package.smoke.recovery-verification'
  ].map((checkId) => [checkId, () => checkInstalledSmoke(checkId)]) : [])
]);

process.on('exit', () => installedSmokeEvidence?.close());

const failures = [];
const pending = [];
for (const check of group.checks ?? []) {
  const handler = implemented.get(check.id);
  if (!handler) {
    pending.push(check);
    continue;
  }
  try {
    const problem = handler();
    if (problem) failures.push(`${check.id}（${check.description}）：${problem}`);
  } catch (error) {
    failures.push(`${check.id}（${check.description}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const check of pending) console.error(`PENDING: ${check.id} — ${check.description}（归属阶段 ${check.ownerStage ?? stageLabel}）`);
for (const failure of failures) console.error(`失败：${failure}`);
if (pending.length || failures.length) {
  console.error(`${GROUP_ID}出口校验未通过：${pending.length}项待实现，${failures.length}项失败。`);
  process.exit(1);
}
console.log(`${GROUP_ID}出口校验通过：${(group.checks ?? []).length}项稳定ID检查全部实现并通过。`);
