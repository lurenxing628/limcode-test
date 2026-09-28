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

const TRACKED_VERIFICATION_SOURCE_ALLOWLIST = new Set([
  'tests/webview-session-thinking.browser.mjs',
  'tests/webview-agent-status-panel.browser.mjs',
  'scripts/reliable-kernel/benchmark-concurrency-tuning.mjs',
  'scripts/reliable-kernel/benchmark-model-independent-hotpaths.mjs',
  'scripts/reliable-kernel/benchmark-native-output-growth.mjs',
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
  'tests/reliable-kernel/child-compression-memory.test.mjs',
  'tests/reliable-kernel/native-child-handles.test.mjs',
  'tests/reliable-kernel/child-handle-boundary.test.mjs',
  'tests/reliable-kernel/child-execution-boundary.test.mjs',
  'tests/reliable-kernel/child-skill-preload.test.mjs',
  'tests/reliable-kernel/child-task-facts-snapshot.test.cjs',
  'tests/reliable-kernel/conversation-child-task-projection.test.mjs',
  'tests/reliable-kernel/child-task-runtime.test.mjs',
  'tests/reliable-kernel/child-task-tools.test.mjs',
  'tests/reliable-kernel/native-collaboration-boundary.test.mjs',
  'tests/reliable-kernel/collaboration-runtime.test.mjs',
  'tests/reliable-kernel/collaboration-messages.test.mjs',
  'tests/reliable-kernel/agent-collaboration-settings-ui.test.mjs',
  'tests/reliable-kernel/fork-request-wiring.test.mjs',
  'tests/reliable-kernel/webview-ssr-server.mjs',
  'tests/reliable-kernel/collaboration-board.test.mjs',
  'tests/reliable-kernel/collaboration-capacity.test.mjs',
  'tests/reliable-kernel/collaboration-tool-boundary.test.mjs',
  'tests/reliable-kernel/cross-conversation-contract.test.mjs',
  'tests/reliable-kernel/mcp-source-policy.test.mjs',
  'tests/reliable-kernel/collaboration-card-labels.test.mjs',
  'tests/reliable-kernel/collaboration-history-page.test.mjs',
  'tests/reliable-kernel/collaboration-timeline-ssr.test.mjs',
  'tests/reliable-kernel/main-panel-feed-routing.test.mjs',
  'tests/reliable-kernel/sidebar-cross-host-abort.test.mjs',
  'tests/reliable-kernel/skill-catalog.test.mjs',
  'tests/reliable-kernel/child-answer-cards.test.mjs',
  'tests/reliable-kernel/steering-status-dismissal.test.mjs',
  'tests/reliable-kernel/data-root-prompt-defaults.test.mjs',
  'tests/reliable-kernel/model-request-native-usage-worker.test.mjs',
  'tests/reliable-kernel/native-budget-checkpoints.test.mjs',
  'tests/reliable-kernel/native-context-closure.test.mjs',
  'tests/reliable-kernel/native-chain-recovery.test.mjs',
  'tests/reliable-kernel/native-reconcile-revision-reads.test.mjs',
  'tests/reliable-kernel/native-response-metrics.test.mjs',
  'tests/reliable-kernel/model-request-client-summary.test.mjs',
  'tests/reliable-kernel/model-reply-metrics-handoff.test.mjs',
  'tests/reliable-kernel/runtime-delivery-running-turn.test.mjs',
  'tests/reliable-kernel/collaboration-wake.test.mjs',
  'tests/reliable-kernel/child-final-answer.test.mjs',
  'tests/reliable-kernel/native-usage-observation.test.mjs',
  'tests/reliable-kernel/task-live-feed.test.mjs',
  'tests/reliable-kernel/cross-conversation-tools.test.mjs',
  'tests/reliable-kernel/native-collaboration-handles.test.mjs',
  'tests/reliable-kernel/collaboration-schema-epoch.test.mjs',
  'tests/reliable-kernel/collaboration-lifecycle.test.mjs',
  'tests/reliable-kernel/collaboration-reconcile-race.test.mjs',
  'tests/reliable-kernel/compression-rebuild-entry.test.mjs',
  'tests/reliable-kernel/client-feed-window-rollover.test.mjs',
  'tests/reliable-kernel/conversation-deletion-recovery.test.mjs',
  'tests/reliable-kernel/conversation-history-scope-count.test.mjs',
  'tests/reliable-kernel/conversation-history-paging-stability.test.mjs',
  'tests/reliable-kernel/sidebar-history-cursor.test.mjs',
  'tests/reliable-kernel/sidebar-history-local-actions.test.mjs',
  'tests/reliable-kernel/command-router-interaction.test.mjs',
  'tests/reliable-kernel/compression-progress-ui.test.mjs',
  'tests/reliable-kernel/conversation-runtime-ownership.test.mjs',
  'tests/reliable-kernel/conversation-host-eligibility.test.mjs',
  'tests/reliable-kernel/user-stop-dead-host.test.mjs',
  'tests/reliable-kernel/conversation-delete-stop.test.mjs',
  'tests/reliable-kernel/conversation-delete-stop-review.test.mjs',
  'tests/reliable-kernel/conversation-host-eligibility-review.test.mjs',
  'tests/reliable-kernel/plan-and-entry-eligibility.test.mjs',
  'tests/reliable-kernel/eligibility-placement-handback.test.mjs',
  'tests/reliable-kernel/eligibility-delivery-ownership.test.mjs',
  'tests/reliable-kernel/delivery-abandon-ownership.test.mjs',
  'tests/reliable-kernel/eligibility-blind-review.test.mjs',
  'tests/reliable-kernel/dead-host-effects-spawn.test.mjs',
  'tests/reliable-kernel/conversation-settings-isolation.test.mjs',
  'tests/reliable-kernel/configuration-authority.test.mjs',
  'tests/reliable-kernel/global-settings-live-save.test.mjs',
  'tests/reliable-kernel/read-file-slice.test.mjs',
  'tests/reliable-kernel/skill-tool-result-projection.test.mjs',
  'tests/reliable-kernel/skill-reattachment-compression.test.mjs',
  'tests/reliable-kernel/request-compression-settings.test.mjs',
  'tests/reliable-kernel/model-capabilities.test.mjs',
  'tests/reliable-kernel/compression-provider-contracts.test.mjs',
  'tests/reliable-kernel/compression-reduction-gate.test.mjs',
  'tests/reliable-kernel/context-token-estimator.test.mjs',
  'tests/reliable-kernel/conversation-fork-context.test.mjs',
  'tests/reliable-kernel/conversation-fork-lifecycle.test.mjs',
  'tests/reliable-kernel/current-turn-task-projection.test.mjs',
  'tests/reliable-kernel/diagnostic-journal.test.mjs',
  'tests/reliable-kernel/runtime-diagnostic-metrics.test.mjs',
  'tests/reliable-kernel/runtime-diagnostic-sqlite-locks.test.mjs',
  'tests/reliable-kernel/runtime-statement-cache.test.mjs',
  'tests/reliable-kernel/historical-copy-savepoint.test.mjs',
  'tests/reliable-kernel/runtime-commit-result.test.mjs',
  'tests/reliable-kernel/sqlite-database-file-guard.test.mjs',
  'tests/reliable-kernel/debug-capture-controller.test.mjs',
  'tests/reliable-kernel/debug-capture-files.test.mjs',
  'tests/reliable-kernel/debug-capture-provenance.test.mjs',
  'tests/reliable-kernel/debug-capture-ui.test.mjs',
  'tests/reliable-kernel/edit-tool-invariants.test.cjs',
  'tests/reliable-kernel/frontend-copy-guardrails.test.cjs',
  'tests/reliable-kernel/reliable-message-activity-row.test.mjs',
  'tests/reliable-kernel/function-call-preview-handoff.test.mjs',
  'tests/reliable-kernel/guidance-queue.test.mjs',
  'tests/reliable-kernel/llm-capability-provider-adapter.test.mjs',
  'tests/reliable-kernel/model-system-prompt-prefix.test.mjs',
  'tests/reliable-kernel/native-compact-media.test.mjs',
  'tests/reliable-kernel/native-astra-integration.test.mjs',
  'tests/reliable-kernel/native-compression-guard.test.mjs',
  'tests/reliable-kernel/native-tool-admission.test.mjs',
  'tests/reliable-kernel/native-provider-capability.test.mjs',
  'tests/reliable-kernel/gpt6-family-adaptation.test.mjs',
  'tests/reliable-kernel/openai-responses-ws-explicit-cache.test.mjs',
  'tests/reliable-kernel/native-request-orchestration.test.mjs',
  'tests/reliable-kernel/llm-provider-configs-native.test.mjs',
  'tests/reliable-kernel/phase-b-foundation.test.mjs',
  'tests/reliable-kernel/panel-owner-lifecycle.test.mjs',
  'tests/reliable-kernel/path-shape-boundaries.test.mjs',
  'tests/reliable-kernel/plan-interrupt-recovery.test.mjs',
  'tests/reliable-kernel/product-composition.test.mjs',
  'tests/reliable-kernel/proxy-environment.test.mjs',
  'tests/reliable-kernel/provider-semantic-watchdog.test.mjs',
  'tests/reliable-kernel/llm-finish-reason.test.mjs',
  'tests/reliable-kernel/openai-request-shaping.test.mjs',
  'tests/reliable-kernel/claude-thinking-adaptation.test.mjs',
  'tests/reliable-kernel/claude-thinking-binding-persistence.test.mjs',
  'tests/reliable-kernel/provider-parameter-adaptation.test.mjs',
  'tests/reliable-kernel/openai-compatible-dialect.test.mjs',
  'tests/reliable-kernel/openai-compatible-thinking-probe.test.mjs',
  'tests/reliable-kernel/provider-wire-invariant.test.mjs',
  'tests/reliable-kernel/claude-cross-model-thinking-replay.test.mjs',
  'tests/reliable-kernel/provider-history-wire.test.mjs',
  'tests/reliable-kernel/claude-turn-scoped-reminders.test.mjs',
  'tests/reliable-kernel/claude-turn-scoped-reminders-runtime.test.mjs',
  'tests/reliable-kernel/claude-turn-scoped-reminder-edges.test.mjs',
  'tests/reliable-kernel/claude-native-compaction-shaping.test.mjs',
  'tests/reliable-kernel/claude-tail-cache-breakpoint.test.mjs',
  'tests/reliable-kernel/openai-responses-tail-cache-breakpoint.test.mjs',
  'tests/reliable-kernel/gemini-provider-adaptation.test.mjs',
  'tests/reliable-kernel/gemini-thought-signature-runtime.test.mjs',
  'tests/reliable-kernel/provider-vendor-check.test.mjs',
  'tests/reliable-kernel/unified-provider-regressions.test.mjs',
  'tests/reliable-kernel/provider-websocket-policy.test.mjs',
  'tests/reliable-kernel/session-thinking-runtime.test.mjs',
  'tests/reliable-kernel/session-thinking-control.test.mjs',
  'tests/reliable-kernel/session-thinking-simple.test.mjs',
  'tests/reliable-kernel/session-thinking-store.test.cjs',
  'tests/reliable-kernel/session-thinking-ui-fixture.cjs',
  'tests/reliable-kernel/session-thinking.test.mjs',
  'tests/reliable-kernel/settings-flush-convergence.test.mjs',
  'tests/reliable-kernel/settings-save-barrier-detach.test.mjs',
  'tests/reliable-kernel/scroll-anchor.test.mjs',
  'tests/reliable-kernel/sidebar-collapse-intent.test.mjs',
  'tests/reliable-kernel/reliable-control-lifecycle.test.mjs',
  'tests/reliable-kernel/reliable-outbox-ui-contract.test.mjs',
  'tests/reliable-kernel/segmented-summary-chunking.test.mjs',
  'tests/reliable-kernel/segmented-rebuild-admission.test.mjs',
  'tests/reliable-kernel/compression-rebuild-preview.test.mjs',
  'tests/reliable-kernel/compression-rebuild-dialog.test.mjs',
  'tests/reliable-kernel/runtime-context-rendering.test.mjs',
  'tests/reliable-kernel/streaming-output-regressions.test.mjs',
  'tests/reliable-kernel/storage-lock-multiprocess.test.cjs',
  'tests/reliable-kernel/stream-reset-tool-idempotency.test.mjs',
  'tests/reliable-kernel/tool-boundary-regressions.test.mjs',
  'tests/reliable-kernel/vscode-fs-local-read.test.cjs',
  'tests/reliable-kernel/webview-feed-lifecycle.test.mjs',
  'tests/reliable-kernel/waiting-interaction-cancellation.test.mjs',
  'tests/reliable-kernel/stop-waiting-turn.test.mjs',
  'tests/reliable-kernel/interaction-auto-approval.test.mjs',
  'tests/reliable-kernel/platform-runtime-compatibility.test.mjs',
  'tests/reliable-kernel/runtime-epoch-upgrade-preservation.test.mjs',
  'tests/reliable-kernel/runtime-claim-windows-rename.test.cjs',
  'tests/reliable-kernel/workspace-runtime-isolation.test.mjs',
  'tests/reliable-kernel/runtime-datasets.test.mjs',
  'tests/reliable-kernel/runtime-dataset-history-storage.test.mjs',
  'tests/reliable-kernel/runtime-content-usage.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-state.test.mjs',
  'tests/reliable-kernel/runtime-backup-cleanup.test.mjs',
  'tests/reliable-kernel/runtime-backup-cleanup-foreign.test.mjs',
  'tests/reliable-kernel/runtime-backup-cleanup-review.test.mjs',
  'tests/reliable-kernel/runtime-backup-cleanup-blind.test.mjs',
  'tests/reliable-kernel/runtime-backup-cleanup-child.mjs',
  'tests/reliable-kernel/backup-cleanup-commands.test.cjs',
  'tests/reliable-kernel/runtime-foreign-history.test.mjs',
  'tests/reliable-kernel/foreign-history-commands.test.cjs',
  'tests/reliable-kernel/runtime-foreign-history-review.test.mjs',
  'tests/reliable-kernel/runtime-foreign-history-merge.test.mjs',
  'tests/reliable-kernel/runtime-merge-deleted-conversations.test.mjs',
  'tests/reliable-kernel/runtime-foreign-history-blind.test.mjs',
  'tests/reliable-kernel/foreign-archive-only-relocation.test.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation.test.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation-review.test.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation-crash.test.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation-crash-child.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation-undo-crash.test.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation-undo-crash-child.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation-review2.test.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation-review3.test.mjs',
  'tests/reliable-kernel/relocated-work-settlement.test.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation-blind.test.mjs',
  'tests/reliable-kernel/relocated-work-opening.test.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation-hold-child.mjs',
  'tests/reliable-kernel/configuration-missing-settings-directory.test.mjs',
  'tests/reliable-kernel/runtime-data-root-relocation-fixture.mjs',
  'tests/reliable-kernel/data-root-relocation-commands.test.cjs',
  'tests/reliable-kernel/data-root-relocation-real-coordination.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-child.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-e2e.test.mjs',
  'tests/reliable-kernel/runtime-dataset-bulk-copy.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-full-runtime.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-crash-child.mjs',
  'tests/reliable-kernel/fixtures/runtime-merge-fixture.mjs',
  'tests/reliable-kernel/runtime-maintenance-transaction.test.mjs',
  'tests/reliable-kernel/runtime-database-durability-snapshots.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-streamed.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-estimate.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-streamed-review.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-blind-review.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-streamed-crash.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-streamed-memory.test.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-streamed-child.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-streamed-memory-child.mjs',
  'tests/reliable-kernel/runtime-dataset-merge-disk-full-child.mjs',
  'tests/reliable-kernel/runtime-exclusive-maintenance.test.mjs',
  'tests/reliable-kernel/runtime-exclusive-maintenance-windows.test.mjs',
  'tests/reliable-kernel/runtime-write-freeze.test.mjs',
  'tests/reliable-kernel/large-historical-merge.test.mjs',
  'tests/reliable-kernel/runtime-exclusive-maintenance-window.mjs',
  'tests/reliable-kernel/large-historical-merge-e2e.test.mjs',
  'tests/reliable-kernel/large-historical-merge-window.mjs',
  'tests/reliable-kernel/work-environment-selection.test.cjs',
  'tests/reliable-kernel/active-turn-work-environment-projection.test.mjs',
  'tests/reliable-kernel/runtime-dataset-commands.test.cjs',
  'tests/reliable-kernel/work-environment-transfer-boundary.test.cjs',
  'tests/reliable-kernel/run-local-tests-cleanup.test.mjs',
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
  'webview/tests/reliableCollaborationTimeline.test.ts',
  'webview/tests/reliableConversationProjection.test.ts',
  'tests/reliable-kernel/reliable-queue-ordering.test.mjs',
  'webview/tests/segmentedTimeline.test.ts',
  'webview/tests/forkRequestLifecycle.test.ts',
  'webview/tests/summaryRebuildPreview.test.ts',
  'webview/tests/compressionTokenChange.test.ts',
  'webview/tests/chatDraftPrefill.test.ts',
  'webview/tests/composerDraftPersistence.test.ts',
  'webview/tests/steeringReceipts.test.ts',
  'webview/tests/terminationNotice.test.ts'
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

// Tracked test files that `run-local-tests.mjs --ci` does not run, each with the package script that
// does (checked to name it). Every other tracked test must be in its CI_TEST_FILES.
const TRACKED_TESTS_OUTSIDE_CI = new Map([
  // Drive a real browser against the built webview; the CI list runs in Node only.
  ['tests/webview-session-thinking.browser.mjs', 'test:browser'],
  ['tests/webview-agent-status-panel.browser.mjs', 'test:browser']
]);

function isRunnableTestPath(file) {
  return /\.test\.(?:cjs|mjs|js|ts)$/.test(file) || /\.browser\.mjs$/.test(file);
}

/** A tracked test that no run covers is dead weight that looks like coverage; see TRACKED_TESTS_OUTSIDE_CI. */
function checkCiTestCoverage(tracked) {
  let ciFiles;
  try {
    ciFiles = childProcess.execFileSync(process.execPath, ['scripts/reliable-kernel/run-local-tests.mjs', '--ci', '--list'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).split(/\r?\n/).filter(Boolean);
  } catch (error) {
    failures.push(`无法读取CI测试清单（run-local-tests.mjs --ci --list）：${String(error?.stderr || error?.message || error).trim()}`);
    return;
  }
  const inCi = new Set(ciFiles);
  const duplicates = ciFiles.filter((file, index) => ciFiles.indexOf(file) !== index);
  if (duplicates.length) failures.push(`CI测试清单有重复项：${[...new Set(duplicates)].join(', ')}`);
  const uncovered = tracked.filter(isRunnableTestPath).filter((file) => !inCi.has(file) && !TRACKED_TESTS_OUTSIDE_CI.has(file));
  if (uncovered.length) {
    failures.push('受版本管理的测试既不在CI清单（run-local-tests.mjs的CI_TEST_FILES）里，'
      + `也不在check-plan.mjs的TRACKED_TESTS_OUTSIDE_CI排除名单里：${uncovered.join(', ')}`);
  }
  const trackedFiles = new Set(tracked);
  const scripts = JSON.parse(read('package.json')).scripts ?? {};
  for (const [file, script] of TRACKED_TESTS_OUTSIDE_CI) {
    if (inCi.has(file)) failures.push(`${file}已在CI清单里，应从TRACKED_TESTS_OUTSIDE_CI移除`);
    else if (!trackedFiles.has(file)) failures.push(`TRACKED_TESTS_OUTSIDE_CI里的${file}不在版本库里，应移除`);
    else if (!scripts[script]?.includes(file)) failures.push(`TRACKED_TESTS_OUTSIDE_CI说${file}由npm run ${script}运行，但这个脚本没有运行它`);
  }
  if (requireTracked) {
    // The runner fails on a listed file that is missing, which a checkout without it is.
    const untracked = ciFiles.filter((file) => !trackedFiles.has(file));
    if (untracked.length) failures.push(`CI清单里的测试未被版本库跟踪：${untracked.join(', ')}`);
  }
}

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
  if (tracked.length) checkCiTestCoverage(tracked);

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
