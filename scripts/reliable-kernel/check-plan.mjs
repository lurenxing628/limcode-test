import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  CONTRACT_FILES,
  loadContractDocuments,
  selectGateValidators,
  validateContractDocuments
} from './lib/contract-model.mjs';

const root = process.cwd();
const failures = [];
const notes = [];
const requireTracked = process.argv.includes('--require-tracked');

function read(relativePath) {
  // LF line endings: a Windows checkout (core.autocrlf) must match the same multi-line snippets.
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function git(args) {
  return childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function listFiles(directory) {
  const files = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push(path.relative(root, absolute).replaceAll(path.sep, '/'));
    }
  }
  walk(directory);
  return files.sort();
}

function isTestArtifactPath(file) {
  const normalized = file.replaceAll('\\', '/');
  const base = path.posix.basename(normalized);
  return /(^|\/)(?:test|tests|spec|specs|__tests__|fixture|fixtures|benchmark|benchmarks)(?:\/|$)/i.test(normalized)
    || /^(?:test|spec|benchmark)-/i.test(base)
    || /^(?:tests?|specs?)\.(?:[cm]?js|tsx?|jsx?)$/i.test(base)
    || /\.(?:test|spec|benchmark)\.[^/]+$/i.test(base);
}

const LOCAL_GENERATED_BENCHMARK_OUTPUTS = new Set([
  'scripts/reliable-kernel/concurrency-read-after-repeat.json',
  'scripts/reliable-kernel/concurrency-read-after.json',
  'scripts/reliable-kernel/concurrency-read-before.json',
  'scripts/reliable-kernel/concurrency-tuning-after-repeat.json',
  'scripts/reliable-kernel/concurrency-tuning-after.json',
  'scripts/reliable-kernel/concurrency-tuning-before.json',
  'scripts/reliable-kernel/concurrency-tuning-comparison.json',
  'scripts/reliable-kernel/model-independent-hotpaths-after.json',
  'scripts/reliable-kernel/tool-scheduler-model-independent-after.json',
  'scripts/reliable-kernel/tool-scheduler-phase0-before.json',
  'scripts/reliable-kernel/tool-scheduler-phase1-after.json',
  'scripts/reliable-kernel/tool-scheduler-phase2-after.json'
]);

function checkTrackedInputs() {
  let tracked = [];
  try {
    tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  } catch {
    failures.push('无法读取Git跟踪文件清单');
  }
  const misplaced = tracked.filter(isTestArtifactPath).filter(file =>
    !file.startsWith('tests/reliable-kernel/')
    && !file.startsWith('tests/ci-parts/')
    && !/^tests\/[^/]+\.browser\.mjs$/.test(file)
    && !file.startsWith('scripts/reliable-kernel/benchmark-')
  );
  if (misplaced.length) failures.push(`验证源码应放在行为测试目录或基准脚本目录：${misplaced.join(', ')}`);

  if (!requireTracked) {
    notes.push('当前只检查工作区内容；准备合入时再运行 npm run check:plan:tracked');
    return;
  }
  const formalInputs = [
    ...listFiles(path.join(root, 'docs/architecture/reliable-kernel')),
    ...listFiles(path.join(root, 'scripts/reliable-kernel')),
    '.gitignore',
    '.vscodeignore',
    'AGENTS.md',
    'package.json',
    'package-lock.json',
    ...listFiles(path.join(root, 'tests/reliable-kernel')),
    ...listFiles(path.join(root, 'tests/ci-parts')),
    ...listFiles(path.join(root, 'tests')).filter(file => /\.browser\.mjs$/.test(file))
  ].filter((relative) => !LOCAL_GENERATED_BENCHMARK_OUTPUTS.has(relative));
  const trackedFiles = new Set(tracked);
  for (const relative of formalInputs) {
    if (!trackedFiles.has(relative)) failures.push(`正式输入未被版本库跟踪：${relative}`);
  }
  const ledger = documents['transition-ledger.json'];
  const missingDeletionCommits = (ledger?.entries ?? [])
    .filter((entry) => entry.deleteStage === 'G' && !(entry.deletedAtCommit ?? entry['deleted-at-commit']))
    .map((entry) => entry.key);
  if (ledger?.status === 'active' && missingDeletionCommits.length > 0) {
    failures.push(`Phase G旧源码删除尚未绑定干净提交：${missingDeletionCommits.join(', ')}`);
  }
}

function checkPackageScripts() {
  const manifest = JSON.parse(read('package.json'));
  const scripts = manifest.scripts ?? {};
  for (const name of ['check', 'check:contracts:plan', 'check:package:surface', 'check:plan', 'check:plan:tracked', 'check:gate', 'check:local']) {
    if (typeof scripts[name] !== 'string' || scripts[name] === '') failures.push(`package.json缺少脚本${name}`);
  }
  for (const command of ['npm run build', 'npm run typecheck:webview', 'npm run check:contracts:plan']) {
    if (!scripts['check:plan']?.includes(command)) failures.push(`check:plan缺少${command}`);
  }
  if (scripts['check:plan']?.includes('check:package:surface')) failures.push('普通计划检查不应每次枚举完整安装包表面');
  if (!scripts['check:plan:tracked']?.includes('--require-tracked')) failures.push('check:plan:tracked必须启用跟踪文件检查');
  if (!scripts['check:local']?.includes('run-local-tests.mjs')) failures.push('check:local必须运行统一行为测试入口');
}

let documents = {};
try {
  documents = loadContractDocuments(root);
  failures.push(...validateContractDocuments(root, documents));
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
}

checkPackageScripts();
checkTrackedInputs();

if (failures.length) {
  console.error(`可靠内核计划检查失败，共${failures.length}项：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const gates = documents['gate-registry.json'];
const stages = [...new Set(gates.gates.flatMap((gate) => gate.stages))];
const summaries = [...gates.gates]
  .sort((left, right) => left.order - right.order)
  .map((gate) => `${gate.id}=${selectGateValidators(gates, gate.id).join('+')}`);
console.log(`可靠内核计划检查通过：${CONTRACT_FILES.length}份合同，${stages.length}个实施阶段，${gates.gates.length}个正式出口，${gates.validatorGroups.length}个直接校验器。`);
console.log('这只证明计划结构自洽，不代表实现、故障恢复或本机安装已经通过。');
for (const note of notes) console.log(`- ${note}`);
console.log(`- 出口校验器：${summaries.join('；')}`);
