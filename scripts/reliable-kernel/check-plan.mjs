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
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
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

const TRACKED_VERIFICATION_SOURCE_ALLOWLIST = new Set([
  'scripts/reliable-kernel/benchmark-concurrency-tuning.mjs',
  'scripts/reliable-kernel/benchmark-model-independent-hotpaths.mjs',
  'scripts/reliable-kernel/benchmark-phase0-milestones.mjs',
  'scripts/reliable-kernel/benchmark-tool-scheduler.mjs',
  'tests/bottomStickyScrollerScheduler.test.cjs',
  'tests/commandRelaxedPolicy.test.cjs',
  'tests/fileWatcherScope.test.cjs',
  'tests/openAIResponsesWebSocket.test.cjs',
  'tests/openAIResponsesWebSocketSession.test.cjs',
  'tests/reliable-kernel/attachment-catalog-projection.test.mjs',
  'tests/reliable-kernel/attachment-ingest-boundary.test.mjs',
  'tests/reliable-kernel/canonical-base64.test.mjs',
  'tests/reliable-kernel/child-agent-status-controls.test.cjs',
  'tests/reliable-kernel/client-feed-window-rollover.test.mjs',
  'tests/reliable-kernel/conversation-deletion-recovery.test.mjs',
  'tests/reliable-kernel/command-router-interaction.test.mjs',
  'tests/reliable-kernel/compression-progress-ui.test.mjs',
  'tests/reliable-kernel/conversation-runtime-ownership.test.mjs',
  'tests/reliable-kernel/conversation-settings-isolation.test.mjs',
  'tests/reliable-kernel/configuration-authority.test.mjs',
  'tests/reliable-kernel/global-settings-live-save.test.mjs',
  'tests/reliable-kernel/read-file-slice.test.mjs',
  'tests/reliable-kernel/request-compression-settings.test.mjs',
  'tests/reliable-kernel/context-token-estimator.test.mjs',
  'tests/reliable-kernel/conversation-fork-context.test.mjs',
  'tests/reliable-kernel/current-turn-task-projection.test.mjs',
  'tests/reliable-kernel/diagnostic-journal.test.mjs',
  'tests/reliable-kernel/debug-capture-controller.test.mjs',
  'tests/reliable-kernel/debug-capture-files.test.mjs',
  'tests/reliable-kernel/debug-capture-provenance.test.mjs',
  'tests/reliable-kernel/debug-capture-ui.test.mjs',
  'tests/reliable-kernel/edit-tool-invariants.test.cjs',
  'tests/reliable-kernel/frontend-copy-guardrails.test.cjs',
  'tests/reliable-kernel/guidance-queue.test.mjs',
  'tests/reliable-kernel/llm-capability-provider-adapter.test.mjs',
  'tests/reliable-kernel/model-system-prompt-prefix.test.mjs',
  'tests/reliable-kernel/native-compact-media.test.mjs',
  'tests/reliable-kernel/native-astra-integration.test.mjs',
  'tests/reliable-kernel/native-compression-guard.test.mjs',
  'tests/reliable-kernel/native-tool-admission.test.mjs',
  'tests/reliable-kernel/native-provider-capability.test.mjs',
  'tests/reliable-kernel/native-request-orchestration.test.mjs',
  'tests/reliable-kernel/llm-provider-configs-native.test.mjs',
  'tests/reliable-kernel/phase-b-foundation.test.mjs',
  'tests/reliable-kernel/panel-owner-lifecycle.test.mjs',
  'tests/reliable-kernel/plan-interrupt-recovery.test.mjs',
  'tests/reliable-kernel/product-composition.test.mjs',
  'tests/reliable-kernel/proxy-environment.test.mjs',
  'tests/reliable-kernel/provider-semantic-watchdog.test.mjs',
  'tests/reliable-kernel/provider-wire-invariant.test.mjs',
  'tests/reliable-kernel/claude-cross-model-thinking-replay.test.mjs',
  'tests/reliable-kernel/provider-websocket-policy.test.mjs',
  'tests/reliable-kernel/reliable-control-lifecycle.test.mjs',
  'tests/reliable-kernel/reliable-outbox-ui-contract.test.mjs',
  'tests/reliable-kernel/segmented-summary-chunking.test.mjs',
  'tests/reliable-kernel/runtime-context-rendering.test.mjs',
  'tests/reliable-kernel/streaming-output-regressions.test.mjs',
  'tests/reliable-kernel/storage-lock-multiprocess.test.cjs',
  'tests/reliable-kernel/stream-reset-tool-idempotency.test.mjs',
  'tests/reliable-kernel/tool-boundary-regressions.test.mjs',
  'tests/reliable-kernel/vscode-fs-local-read.test.cjs',
  'tests/reliable-kernel/webview-feed-lifecycle.test.mjs',
  'tests/reliable-kernel/waiting-interaction-cancellation.test.mjs',
  'tests/reliable-kernel/interaction-auto-approval.test.mjs',
  'tests/reliable-kernel/platform-runtime-compatibility.test.mjs',
  'tests/reliable-kernel/workspace-runtime-isolation.test.mjs',
  'tests/reliable-kernel/work-environment-transfer-boundary.test.cjs',
  'tests/llmErrorRedaction.test.cjs',
  'tests/localFileResources.test.cjs',
  'tests/processSpoolCleanup.test.cjs',
  'tests/runAgentToolSchema.test.cjs',
  'tests/settingsRevisionConflict.test.cjs',
  'tests/storageLockRace.test.cjs',
  'tests/vscodeStorageJsonDurability.test.cjs',
  'tests/webviewLocalResources.test.cjs',
  'tests/openAIResponsesWebSocketNative.test.cjs',
  'webview/tests/nativeConversationProjection.test.ts',
  'webview/tests/reliableConversationProjection.test.ts',
  'tests/reliable-kernel/reliable-queue-ordering.test.mjs',
  'webview/tests/segmentedTimeline.test.ts'
]);

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
  const trackedTests = tracked.filter(isTestArtifactPath);
  const unexpectedTrackedTests = trackedTests.filter((file) => !TRACKED_VERIFICATION_SOURCE_ALLOWLIST.has(file));
  if (unexpectedTrackedTests.length) {
    failures.push(`仅允许明确审查过的关键测试与基准脚本进入版本库：${unexpectedTrackedTests.join(', ')}`);
  }
  if (!read('.gitignore').split(/\r?\n/).includes('/tests/')) failures.push('.gitignore必须忽略根目录/tests/');

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
    'package-lock.json'
  ].filter((relative) => !LOCAL_GENERATED_BENCHMARK_OUTPUTS.has(relative));
  for (const relative of formalInputs) {
    try {
      git(['ls-files', '--error-unmatch', '--', relative]);
    } catch {
      failures.push(`正式输入未被版本库跟踪：${relative}`);
    }
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
  if (!scripts['check:local']?.includes('run-local-tests.mjs')) failures.push('check:local必须运行本机被忽略的测试入口');
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
