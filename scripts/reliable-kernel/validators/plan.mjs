import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// plan 出口校验器同样使用 stable check.id -> handler。
// check-plan.mjs 负责工作区合同 exact-set；本文件补 tracked/selector/no-legacy formal checks。
const GROUP_ID = 'plan';
const root = process.cwd();
// Bootstrap is unconditional: an unverified registry must not choose whether it gets checked.
const coherenceProblem = checkContractCoherence();
if (coherenceProblem) {
  console.error(`失败：plan.contract-coherence：${coherenceProblem}`);
  process.exit(1);
}
const registry = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/architecture/reliable-kernel/contracts/gate-registry.json'), 'utf8')
);
const group = (registry.validatorGroups ?? []).find((entry) => entry.id === GROUP_ID);
if (!group) {
  console.error(`gate-registry.json缺少校验器组：${GROUP_ID}`);
  process.exit(2);
}

const warnings = [];

function checkContractCoherence() {
  const run = childProcess.spawnSync(
    process.execPath,
    [path.join(root, 'scripts/reliable-kernel/check-plan.mjs'), '--require-tracked'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  if (run.error) return `计划校验器启动失败：${run.error.message}`;
  if (run.status !== 0) return [run.stdout, run.stderr].filter(Boolean).join('\n').trim() || `check-plan退出码${run.status}`;
  if (run.stdout?.trim()) console.log(run.stdout.trim());
  return null;
}

function checkTransitionDisposition() {
  const ledgerPath = path.join(root, 'docs/architecture/reliable-kernel/contracts/transition-ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const problems = [];
  for (const entry of ledger.entries ?? []) {
    if (entry.deletedAtCommit || entry['deleted-at-commit']) continue;
    const relativePath = entry.selector?.path;
    const symbol = entry.selector?.symbol;
    if (typeof relativePath !== 'string' || relativePath === '' || typeof symbol !== 'string' || symbol === '') {
      problems.push(`${entry.key ?? '未知条目'}未标deletedAtCommit但selector缺少path或symbol`);
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      problems.push(`${entry.key}未标deletedAtCommit但selector.path不存在：${relativePath}`);
      continue;
    }
    const source = fs.readFileSync(absolutePath, 'utf8');
    if (!source.includes(symbol)) problems.push(`${entry.key}.selector.symbol无法命中：${symbol}`);
    if (entry.selector?.member && !source.includes(entry.selector.member)) problems.push(`${entry.key}.selector.member无法命中：${entry.selector.member}`);
  }
  return problems.length ? problems.join('；') : null;
}

function checkNoLegacyCompatibility() {
  const contractsRoot = path.join(root, 'docs/architecture/reliable-kernel/contracts');
  const migration = JSON.parse(fs.readFileSync(path.join(contractsRoot, 'migration.json'), 'utf8'));
  const authority = JSON.parse(fs.readFileSync(path.join(contractsRoot, 'authority.json'), 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(path.join(contractsRoot, 'transition-ledger.json'), 'utf8'));
  const problems = [];
  for (const field of ['legacyRuntimeImport', 'dualWrite', 'fallbackToLegacyRuntime', 'runtimeProtocolNegotiation']) {
    if (migration[field] !== false) problems.push(`migration.${field}必须为false`);
  }
  if (authority.schemaPolicy?.incrementalLegacyMigrationChain !== false) problems.push('authority不得维护legacy migration chain');
  if (ledger.compatibilityAdaptersAllowed !== false) problems.push('transition ledger不得允许compatibility adapter');
  return problems.length ? problems.join('；') : null;
}

/** @type {Map<string, () => string | null>} */
const implemented = new Map([
  ['plan.contract-coherence', () => null],
  ['plan.transition-disposition', checkTransitionDisposition],
  ['plan.no-legacy-compatibility', checkNoLegacyCompatibility]
]);

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

// CD-50：新增源码文件超过1500行只警告，不冒充阻塞 gate。
const SOURCE_FILE = /\.(?:[cm]?js|ts|tsx|vue)$/;
let statusLines = [];
try {
  statusLines = childProcess
    .execFileSync('git', ['status', '--porcelain', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
} catch {
  warnings.push('无法读取Git工作区状态，跳过新增大文件警告');
}
for (const line of statusLines) {
  const marker = line.slice(0, 2);
  if (marker !== '??' && !marker.includes('A')) continue;
  const relative = line.slice(3).replace(/^"|"$/g, '');
  if (!SOURCE_FILE.test(relative)) continue;
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
  const lines = fs.readFileSync(absolute, 'utf8').split('\n').length;
  if (lines > 1500) warnings.push(`CD-50：新增源码文件超过1500行（${lines}行）：${relative}`);
}

for (const warning of warnings) console.warn(`警告：${warning}`);
for (const check of pending) console.error(`PENDING: ${check.id} — ${check.description}（归属阶段 ${check.ownerStage}）`);
for (const failure of failures) console.error(`失败：${failure}`);
if (pending.length || failures.length) {
  console.error(`${GROUP_ID}出口校验未通过：${pending.length}项待实现，${failures.length}项失败。`);
  process.exit(1);
}
console.log(`${GROUP_ID}出口校验通过：${(group.checks ?? []).length}项稳定ID检查全部实现并通过。`);
