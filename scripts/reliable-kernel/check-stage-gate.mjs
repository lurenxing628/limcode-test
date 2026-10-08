import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  loadContractDocuments,
  selectGateValidators
} from './lib/contract-model.mjs';

const root = process.cwd();
const stage = option('stage');
const artifact = option('artifact');
const jsonOutput = process.argv.includes('--json');
const blockers = [];
const results = [];

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function git(args) {
  return childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function add(source, reason) {
  blockers.push({ source, reason });
}

function trackedRegularFile(relativePath) {
  try {
    const mode = /^(\d{6})\s/.exec(git(['ls-files', '--stage', '--', relativePath]))?.[1];
    const stat = fs.lstatSync(path.join(root, relativePath));
    return ['100644', '100755'].includes(mode) && stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function validateArtifact(locator) {
  if (!locator) throw new Error('缺少--artifact安装包路径');
  if (/^[a-z][a-z0-9+.-]*:/i.test(locator)) throw new Error('安装包只接受本机文件路径');
  const absolute = path.resolve(root, locator);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('安装包必须是普通文件且不能是符号链接');
  return absolute;
}

function finish(status, commitSha = null, validators = []) {
  const payload = {
    stage,
    commitSha,
    validators,
    results,
    passed: blockers.length === 0,
    blockers
  };
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.passed) {
    console.log(`${stage}阶段检查通过：${validators.length}个直接校验器。`);
  } else {
    console.error(`${stage ?? '未知'}阶段检查未通过，共${blockers.length}项：`);
    for (const blocker of blockers) console.error(`- ${blocker.source}: ${blocker.reason}`);
  }
  process.exit(status);
}

if (!stage) {
  console.error('用法：npm run check:gate -- --stage=foundation|candidate|installed [--artifact=本机VSIX路径] [--json]');
  process.exit(2);
}

let documents;
let gate;
let validators = [];
try {
  documents = loadContractDocuments(root);
  gate = documents['gate-registry.json'].gates.find((entry) => entry.id === stage);
} catch (error) {
  console.error(`无法读取出口注册表：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (!gate) {
  console.error(`未知阶段：${stage}`);
  console.error('用法：npm run check:gate -- --stage=foundation|candidate|installed [--artifact=本机VSIX路径] [--json]');
  process.exit(2);
}
try {
  validators = selectGateValidators(documents['gate-registry.json'], stage);
  if (!validators.includes('plan')) add('plan', '出口必须包含计划校验器');
} catch (error) {
  add('plan', error instanceof Error ? error.message : String(error));
}

let artifactPath = null;
if (gate?.artifact === 'required') {
  try {
    artifactPath = validateArtifact(artifact);
  } catch (error) {
    add('artifact', error instanceof Error ? error.message : String(error));
  }
} else if (artifact) {
  add('artifact', `${stage}不接受安装包；只有installed出口需要`);
}

let commitSha = null;
try {
  commitSha = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain'])) add('worktree', '正式阶段检查只能在干净工作区运行');
} catch (error) {
  add('git', error instanceof Error ? error.message : String(error));
}

for (const groupId of validators) {
  const definition = documents?.['gate-registry.json']?.validatorGroups?.find((entry) => entry.id === groupId);
  if (!definition || !trackedRegularFile(definition.path)) {
    add(groupId, `校验器尚未实现或未被版本库跟踪：${definition?.path ?? '未登记'}`);
  }
}

// Plan validation runs once and before any compilation or runtime checks.
if (blockers.length === 0) runValidator('plan');

if (blockers.length === 0 && validators.includes('foundation')) {
  const compile = childProcess.spawnSync('npm', ['run', 'compile'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (compile.error || compile.status !== 0) {
    const diagnostic = [compile.stdout, compile.stderr].filter(Boolean).join('\n').trim();
    add('build', compile.error?.message ?? (diagnostic || `退出码${compile.status}`));
  }
}

function runValidator(groupId) {
  const definition = documents['gate-registry.json'].validatorGroups.find((entry) => entry.id === groupId);
  const validatorPath = groupId === 'plan' ? 'scripts/reliable-kernel/validators/plan.mjs' : definition.path;
  const args = [path.join(root, validatorPath), `--stage=${stage}`, `--commit=${commitSha}`];
  if (artifactPath) args.push(`--artifact=${artifactPath}`);
  const run = childProcess.spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: groupId === 'package' ? 600000 : 180000,
    maxBuffer: 8 * 1024 * 1024
  });
  const diagnostic = [run.stdout, run.stderr].filter(Boolean).join('\n').trim();
  results.push({ validator: groupId, status: run.status ?? 1, diagnostic });
  if (run.error || run.status !== 0) add(groupId, run.error?.message ?? (diagnostic || `退出码${run.status}`));
}

if (blockers.length === 0) {
  for (const groupId of validators.filter((id) => id !== 'plan')) runValidator(groupId);
}

finish(blockers.length === 0 ? 0 : 1, commitSha, validators);
