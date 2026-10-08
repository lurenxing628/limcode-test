import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const BASELINE_KIND = 'reliable-kernel-phase-a-local-baseline';
export const BASELINE_CONTRACT_REVISION = '2026-07-31-r4';
export const DEFAULT_BASELINE_RELATIVE_PATH = 'tests/reliable-kernel/baselines/local.json';
export const LOCAL_TEST_ROOT = 'tests/reliable-kernel';

const SHA256 = /^[0-9a-f]{64}$/i;
const GIT_COMMIT = /^[0-9a-f]{40}$/i;
const PLACEHOLDER = /(?:^|[^a-z])(?:tbd|todo|placeholder|fixme)(?:$|[^a-z])/i;
const REQUIRED_PERFORMANCE_COMMANDS = new Map([
  ['contractsPlan', ['npm', 'run', 'check:contracts:plan']],
  ['build', ['npm', 'run', 'build']],
  ['webviewTypecheck', ['npm', 'run', 'typecheck:webview']]
]);
const REQUIRED_PACKAGE_COMMANDS = new Map([
  ['fileListing', ['npx', '--no-install', 'vsce', 'ls']],
  ['artifactBuild', ['npx', '--no-install', 'vsce', 'package']]
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJsonBuffer(buffer, label, problems) {
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (!isPlainObject(value)) problems.push(`${label}必须是JSON对象`);
    return value;
  } catch (error) {
    problems.push(`${label}不是有效JSON：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function git(root, args) {
  return childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function relativeFromRoot(root, locator) {
  const absolute = path.isAbsolute(locator) ? path.normalize(locator) : path.resolve(root, locator);
  return {
    absolute,
    relative: path.relative(root, absolute).replaceAll(path.sep, '/')
  };
}

function checkIgnoredUntrackedRegularFile(root, locator, label, problems) {
  const { absolute, relative } = relativeFromRoot(root, locator);
  const testsRoot = path.resolve(root, LOCAL_TEST_ROOT);
  if (!isInside(testsRoot, absolute) || absolute === testsRoot) {
    problems.push(`${label}必须位于Git ignored的${LOCAL_TEST_ROOT}/下：${relative}`);
    return { absolute, relative };
  }

  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    problems.push(`${label}不存在或不可读取：${relative}（${error instanceof Error ? error.message : String(error)}）`);
    return { absolute, relative };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) problems.push(`${label}必须是普通文件且不能是符号链接：${relative}`);

  const ignored = childProcess.spawnSync('git', ['check-ignore', '-q', '--', relative], { cwd: root });
  if (ignored.error || ignored.status !== 0) problems.push(`${label}必须被.gitignore明确忽略：${relative}`);
  const tracked = childProcess.spawnSync('git', ['ls-files', '--error-unmatch', '--', relative], {
    cwd: root,
    stdio: 'ignore'
  });
  if (!tracked.error && tracked.status === 0) problems.push(`${label}不得被Git跟踪：${relative}`);
  return { absolute, relative };
}

function inspectPlaceholders(value, label, problems) {
  if (value === null) {
    problems.push(`${label}不得为null占位值`);
    return;
  }
  if (typeof value === 'string') {
    if (value.trim() === '') problems.push(`${label}不得为空字符串`);
    else if (PLACEHOLDER.test(value.trim())) problems.push(`${label}包含占位值：${value}`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) problems.push(`${label}必须是有限数值`);
    return;
  }
  if (typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    if (value.length === 0) problems.push(`${label}不得为空数组`);
    value.forEach((entry, index) => inspectPlaceholders(entry, `${label}[${index}]`, problems));
    return;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) problems.push(`${label}不得为空对象`);
    for (const [key, entry] of entries) inspectPlaceholders(entry, `${label}.${key}`, problems);
    return;
  }
  problems.push(`${label}包含不可序列化或不支持的值`);
}

function requireObject(value, label, problems) {
  if (!isPlainObject(value)) {
    problems.push(`${label}必须是对象`);
    return null;
  }
  return value;
}

function requirePositiveNumber(value, label, problems) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    problems.push(`${label}必须是大于0的实测数值`);
    return false;
  }
  return true;
}

function requireNonNegativeInteger(value, label, problems) {
  if (!Number.isInteger(value) || value < 0) {
    problems.push(`${label}必须是大于等于0的整数`);
    return false;
  }
  return true;
}

function equalStringArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function validateMeasuredCommand(value, label, expectedPrefix, problems) {
  const command = requireObject(value, label, problems);
  if (!command) return;
  if (!Array.isArray(command.command) || !command.command.every((entry) => typeof entry === 'string' && entry !== '')) {
    problems.push(`${label}.command必须是非空字符串数组`);
  } else if (!equalStringArray(command.command.slice(0, expectedPrefix.length), expectedPrefix)) {
    problems.push(`${label}.command必须以${expectedPrefix.join(' ')}开头`);
  }
  requirePositiveNumber(command.durationMs, `${label}.durationMs`, problems);
  if (command.exitCode !== 0) problems.push(`${label}.exitCode必须为真实成功值0`);
  for (const stream of ['stdout', 'stderr']) {
    requireNonNegativeInteger(command[`${stream}Bytes`], `${label}.${stream}Bytes`, problems);
  }
}

function parseIsoTimestamp(value, label, problems) {
  if (typeof value !== 'string') {
    problems.push(`${label}必须是ISO时间字符串`);
    return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    problems.push(`${label}必须是规范ISO时间字符串`);
    return null;
  }
  return milliseconds;
}

function readArchiveEntry(artifactPath, entryPath, label, problems) {
  const result = childProcess.spawnSync('unzip', ['-p', artifactPath, entryPath], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const diagnostic = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
    problems.push(`${label}无法从VSIX读取${entryPath}：${result.error?.message ?? (diagnostic || `退出码${result.status}`)}`);
    return null;
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

function inspectArtifact(root, baseline, problems) {
  const packaging = baseline.packaging;
  const artifact = packaging?.artifact;
  if (!isPlainObject(artifact) || typeof artifact.path !== 'string') return;
  const located = checkIgnoredUntrackedRegularFile(root, artifact.path, 'baseline VSIX制品', problems);
  if (!fs.existsSync(located.absolute)) return;

  const bytes = fs.readFileSync(located.absolute);
  if (artifact.bytes !== bytes.length) problems.push(`packaging.artifact.bytes与VSIX实测大小不符：记录${artifact.bytes}，实际${bytes.length}`);
  const digest = sha256(bytes);
  if (artifact.sha256 !== digest) problems.push(`packaging.artifact.sha256与VSIX实测摘要不符：记录${artifact.sha256}，实际${digest}`);

  const listing = childProcess.spawnSync('unzip', ['-Z1', located.absolute], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (listing.error || listing.status !== 0) {
    problems.push(`无法枚举baseline VSIX：${listing.error?.message ?? (listing.stderr?.trim() || `退出码${listing.status}`)}`);
    return;
  }
  const entries = listing.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (packaging.archiveEntryCount !== entries.length) {
    problems.push(`packaging.archiveEntryCount与VSIX实测条目数不符：记录${packaging.archiveEntryCount}，实际${entries.length}`);
  }

  const manifestRecord = packaging.packageManifest;
  const manifestEntry = manifestRecord?.entryPath;
  if (typeof manifestEntry !== 'string' || !entries.includes(manifestEntry)) {
    problems.push(`VSIX缺少记录的package manifest：${manifestEntry ?? '未记录'}`);
    return;
  }
  const manifestBuffer = readArchiveEntry(located.absolute, manifestEntry, 'package manifest', problems);
  if (!manifestBuffer) return;
  const manifest = readJsonBuffer(manifestBuffer, 'VSIX package manifest', problems);
  if (!manifest) return;
  for (const field of ['name', 'version', 'main']) {
    if (manifestRecord?.[field] !== manifest[field]) {
      problems.push(`packaging.packageManifest.${field}与VSIX manifest不符`);
    }
  }

  const normalizedMain = typeof manifest.main === 'string' ? manifest.main.replace(/^\.\//, '') : '';
  const expectedMainArchivePath = normalizedMain ? `extension/${normalizedMain}` : '';
  const mainRecord = packaging.mainEntry;
  if (mainRecord?.path !== normalizedMain) problems.push('packaging.mainEntry.path与VSIX manifest.main不符');
  if (mainRecord?.entryPath !== expectedMainArchivePath) problems.push('packaging.mainEntry.entryPath与VSIX manifest.main不符');
  if (!entries.includes(expectedMainArchivePath)) {
    problems.push(`VSIX缺少main entry：${expectedMainArchivePath || 'manifest.main无效'}`);
  } else {
    const mainBuffer = readArchiveEntry(located.absolute, expectedMainArchivePath, 'main entry', problems);
    if (mainBuffer) {
      if (mainRecord?.bytes !== mainBuffer.length) problems.push('packaging.mainEntry.bytes与VSIX内main entry大小不符');
      if (mainRecord?.sha256 !== sha256(mainBuffer)) problems.push('packaging.mainEntry.sha256与VSIX内main entry摘要不符');
    }
  }

  const provenanceRecord = packaging.buildProvenance;
  const provenanceEntry = provenanceRecord?.entryPath;
  if (typeof provenanceEntry !== 'string' || !entries.includes(provenanceEntry)) {
    problems.push(`VSIX缺少记录的build provenance：${provenanceEntry ?? '未记录'}`);
    return;
  }
  const provenanceBuffer = readArchiveEntry(located.absolute, provenanceEntry, 'build provenance', problems);
  if (!provenanceBuffer) return;
  const provenance = readJsonBuffer(provenanceBuffer, 'VSIX build provenance', problems);
  if (!provenance) return;
  for (const field of ['commitSha', 'mainEntrySha256', 'worktreeClean']) {
    if (provenanceRecord?.[field] !== provenance[field]) {
      problems.push(`packaging.buildProvenance.${field}与VSIX内provenance不符`);
    }
  }
  if (provenance.commitSha !== baseline.commitSha) problems.push('VSIX provenance.commitSha与baseline commitSha不符');
  if (provenance.mainEntrySha256 !== mainRecord?.sha256) problems.push('VSIX provenance.mainEntrySha256与main entry实测摘要不符');
  if (provenance.worktreeClean !== baseline.worktree?.clean) problems.push('VSIX provenance.worktreeClean与baseline工作区状态不符');
}

export function validateBaselineDocument(baseline, options) {
  const root = path.resolve(options.root);
  const expectedCommit = options.expectedCommit;
  const currentPlatform = options.currentPlatform ?? process.platform;
  const currentArch = options.currentArch ?? process.arch;
  const nowMs = options.nowMs ?? Date.now();
  const problems = [];

  if (!isPlainObject(baseline)) return { problems: ['baseline必须是JSON对象'], summary: null };
  inspectPlaceholders(baseline, 'baseline', problems);

  if (baseline.baselineKind !== BASELINE_KIND) problems.push(`baselineKind必须为${BASELINE_KIND}`);
  if (baseline.contractRevision !== BASELINE_CONTRACT_REVISION) {
    problems.push(`contractRevision必须为${BASELINE_CONTRACT_REVISION}`);
  }
  if (!GIT_COMMIT.test(baseline.commitSha ?? '')) problems.push('commitSha必须是40位Git提交SHA');
  if (typeof expectedCommit === 'string' && baseline.commitSha !== expectedCommit) {
    problems.push(`commitSha不是当前校验提交：记录${baseline.commitSha ?? '缺失'}，期望${expectedCommit}`);
  }

  const startedAt = parseIsoTimestamp(baseline.measurementStartedAt, 'measurementStartedAt', problems);
  const measuredAt = parseIsoTimestamp(baseline.measuredAt, 'measuredAt', problems);
  requirePositiveNumber(baseline.measurementDurationMs, 'measurementDurationMs', problems);
  if (startedAt !== null && measuredAt !== null) {
    if (measuredAt < startedAt) problems.push('measuredAt不得早于measurementStartedAt');
    if (measuredAt > nowMs + 5 * 60 * 1000) problems.push('measuredAt不得位于未来');
    const wallDuration = measuredAt - startedAt;
    if (typeof baseline.measurementDurationMs === 'number' && Math.abs(wallDuration - baseline.measurementDurationMs) > 5_000) {
      problems.push('measurementDurationMs与起止时间相差超过5秒');
    }
  }

  const worktree = requireObject(baseline.worktree, 'worktree', problems);
  if (worktree) {
    if (typeof worktree.clean !== 'boolean') problems.push('worktree.clean必须是布尔值');
    if (requireNonNegativeInteger(worktree.statusEntryCount, 'worktree.statusEntryCount', problems)
      && typeof worktree.clean === 'boolean'
      && worktree.clean !== (worktree.statusEntryCount === 0)) {
      problems.push('worktree.clean与statusEntryCount不一致');
    }
  }

  const host = requireObject(baseline.host, 'host', problems);
  if (host) {
    if (host.platform !== currentPlatform) problems.push(`host.platform不是当前真实平台：记录${host.platform}，实际${currentPlatform}`);
    if (host.arch !== currentArch) problems.push(`host.arch不是当前真实架构：记录${host.arch}，实际${currentArch}`);
    if (host.osRelease !== os.release()) problems.push(`host.osRelease不是当前系统版本：记录${host.osRelease}，实际${os.release()}`);
    if (typeof host.cpuModel !== 'string' || host.cpuModel.trim() === '') problems.push('host.cpuModel必须是实测字符串');
    if (!Number.isInteger(host.logicalCpuCount) || host.logicalCpuCount <= 0) problems.push('host.logicalCpuCount必须是正整数');
    if (!Number.isInteger(host.totalMemoryBytes) || host.totalMemoryBytes <= 0) problems.push('host.totalMemoryBytes必须是正整数');
  }

  const toolchain = requireObject(baseline.toolchain, 'toolchain', problems);
  if (toolchain) {
    if (toolchain.nodeVersion !== process.version) {
      problems.push(`toolchain.nodeVersion不是当前Node版本：记录${toolchain.nodeVersion}，实际${process.version}`);
    }
    for (const field of ['npmVersion', 'vsceVersion']) {
      if (typeof toolchain[field] !== 'string' || toolchain[field].trim() === '') problems.push(`toolchain.${field}必须是实测版本`);
    }
  }

  let targets = null;
  try {
    targets = JSON.parse(fs.readFileSync(path.join(root, 'docs/architecture/reliable-kernel/contracts/targets.json'), 'utf8'));
  } catch (error) {
    problems.push(`无法读取targets.json：${error instanceof Error ? error.message : String(error)}`);
  }
  const target = requireObject(baseline.target, 'target', problems);
  const expectedTarget = targets?.localTarget;
  if (target && isPlainObject(expectedTarget)) {
    for (const field of ['id', 'platform', 'arch']) {
      if (target[field] !== expectedTarget[field]) problems.push(`target.${field}与targets.json不符`);
    }
    const matches = currentPlatform === expectedTarget.platform && currentArch === expectedTarget.arch;
    if (target.matchesCurrentHost !== matches) problems.push(`target.matchesCurrentHost必须为实算值${matches}`);
  }

  const performance = requireObject(baseline.performance, 'performance', problems);
  if (performance) {
    for (const [id, expectedCommand] of REQUIRED_PERFORMANCE_COMMANDS) {
      validateMeasuredCommand(performance[id], `performance.${id}`, expectedCommand, problems);
    }
  }

  const packaging = requireObject(baseline.packaging, 'packaging', problems);
  if (packaging) {
    for (const [id, expectedCommand] of REQUIRED_PACKAGE_COMMANDS) {
      validateMeasuredCommand(packaging[id], `packaging.${id}`, expectedCommand, problems);
    }
    requirePositiveNumber(packaging.fileListing?.fileCount, 'packaging.fileListing.fileCount', problems);
    if (!Number.isInteger(packaging.archiveEntryCount) || packaging.archiveEntryCount <= 0) {
      problems.push('packaging.archiveEntryCount必须是正整数实测值');
    }
    const artifact = requireObject(packaging.artifact, 'packaging.artifact', problems);
    if (artifact) {
      if (typeof artifact.path !== 'string' || artifact.path === '' || path.isAbsolute(artifact.path)) {
        problems.push('packaging.artifact.path必须是本机相对路径');
      }
      if (!Number.isInteger(artifact.bytes) || artifact.bytes <= 0) problems.push('packaging.artifact.bytes必须是正整数实测值');
      if (!SHA256.test(artifact.sha256 ?? '')) problems.push('packaging.artifact.sha256必须是64位SHA-256');
    }
    const manifest = requireObject(packaging.packageManifest, 'packaging.packageManifest', problems);
    if (manifest) {
      for (const field of ['entryPath', 'name', 'version', 'main']) {
        if (typeof manifest[field] !== 'string' || manifest[field] === '') problems.push(`packaging.packageManifest.${field}必须是实测字符串`);
      }
    }
    const mainEntry = requireObject(packaging.mainEntry, 'packaging.mainEntry', problems);
    if (mainEntry) {
      for (const field of ['path', 'entryPath']) {
        if (typeof mainEntry[field] !== 'string' || mainEntry[field] === '') problems.push(`packaging.mainEntry.${field}必须是实测字符串`);
      }
      if (!Number.isInteger(mainEntry.bytes) || mainEntry.bytes <= 0) problems.push('packaging.mainEntry.bytes必须是正整数实测值');
      if (!SHA256.test(mainEntry.sha256 ?? '')) problems.push('packaging.mainEntry.sha256必须是64位SHA-256');
    }
    const provenance = requireObject(packaging.buildProvenance, 'packaging.buildProvenance', problems);
    if (provenance) {
      if (typeof provenance.entryPath !== 'string' || provenance.entryPath === '') problems.push('packaging.buildProvenance.entryPath必须是实测字符串');
      if (!GIT_COMMIT.test(provenance.commitSha ?? '')) problems.push('packaging.buildProvenance.commitSha必须是40位Git SHA');
      if (!SHA256.test(provenance.mainEntrySha256 ?? '')) problems.push('packaging.buildProvenance.mainEntrySha256必须是64位SHA-256');
      if (typeof provenance.worktreeClean !== 'boolean') problems.push('packaging.buildProvenance.worktreeClean必须是布尔值');
    }
    if (options.inspectArtifact !== false) inspectArtifact(root, baseline, problems);
  }

  const summary = host && target && packaging?.artifact
    ? {
        platform: host.platform,
        arch: host.arch,
        targetId: target.id,
        matchesCurrentHost: target.matchesCurrentHost,
        measuredAt: baseline.measuredAt,
        commitSha: baseline.commitSha,
        buildDurationMs: performance?.build?.durationMs,
        packageDurationMs: packaging.artifactBuild?.durationMs,
        vsixBytes: packaging.artifact.bytes,
        vsixSha256: packaging.artifact.sha256
      }
    : null;
  return { problems, summary };
}

export function validateBaselineFile(options) {
  const root = path.resolve(options.root);
  const baselineLocator = options.baselinePath ?? DEFAULT_BASELINE_RELATIVE_PATH;
  const problems = [];
  const located = checkIgnoredUntrackedRegularFile(root, baselineLocator, 'baseline JSON', problems);
  if (!fs.existsSync(located.absolute)) return { problems, summary: null, baseline: null, baselinePath: located.relative };

  let baseline = null;
  let parsed = false;
  try {
    baseline = JSON.parse(fs.readFileSync(located.absolute, 'utf8'));
    parsed = true;
  } catch (error) {
    problems.push(`baseline JSON解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed) return { problems, summary: null, baseline, baselinePath: located.relative };

  const validation = validateBaselineDocument(baseline, {
    ...options,
    root
  });
  problems.push(...validation.problems);
  return {
    problems,
    summary: validation.summary,
    baseline,
    baselinePath: located.relative
  };
}

export function currentCommit(root) {
  return git(root, ['rev-parse', '--verify', 'HEAD']);
}

export function digest(value) {
  return sha256(value);
}
