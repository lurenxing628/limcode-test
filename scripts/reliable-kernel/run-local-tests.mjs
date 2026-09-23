import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';

const root = process.cwd();
const WEBVIEW_TEST_FILES = Object.freeze([
  'webview/tests/reliableConversationProjection.test.ts',
  'webview/tests/segmentedTimeline.test.ts',
  'webview/tests/nativeConversationProjection.test.ts',
  'webview/tests/forkRequestLifecycle.test.ts',
  'webview/tests/reliableCollaborationTimeline.test.ts'
]);
const CI_TEST_FILES = Object.freeze([
  'tests/bottomStickyScrollerScheduler.test.cjs',
  'tests/commandRelaxedPolicy.test.cjs',
  'tests/fileWatcherScope.test.cjs',
  'tests/llmErrorRedaction.test.cjs',
  'tests/localFileResources.test.cjs',
  'tests/openAIResponsesWebSocket.test.cjs',
  'tests/openAIResponsesWebSocketSession.test.cjs',
  'tests/openAIResponsesWebSocketNative.test.cjs',
  'tests/processSpoolCleanup.test.cjs',
  'tests/reliable-kernel/attachment-catalog-projection.test.mjs',
  'tests/reliable-kernel/attachment-ingest-boundary.test.mjs',
  'tests/reliable-kernel/canonical-base64.test.mjs',
  'tests/reliable-kernel/command-router-interaction.test.mjs',
  'tests/reliable-kernel/conversation-runtime-ownership.test.mjs',
  'tests/reliable-kernel/panel-owner-lifecycle.test.mjs',
  'tests/reliable-kernel/conversation-settings-isolation.test.mjs',
  'tests/reliable-kernel/child-agent-status-controls.test.cjs',
  'tests/reliable-kernel/child-compression-memory.test.mjs',
  'tests/reliable-kernel/native-child-handles.test.mjs',
  'tests/reliable-kernel/child-handle-boundary.test.mjs',
  'tests/reliable-kernel/child-execution-boundary.test.mjs',
  'tests/reliable-kernel/child-task-facts-snapshot.test.cjs',
  'tests/reliable-kernel/conversation-child-task-projection.test.mjs',
  'tests/reliable-kernel/child-task-runtime.test.mjs',
  'tests/reliable-kernel/child-task-tools.test.mjs',
  'tests/reliable-kernel/native-collaboration-boundary.test.mjs',
  'tests/reliable-kernel/collaboration-runtime.test.mjs',
  'tests/reliable-kernel/collaboration-messages.test.mjs',
  'tests/reliable-kernel/agent-collaboration-settings-ui.test.mjs',
  'tests/reliable-kernel/fork-request-wiring.test.mjs',
  'tests/reliable-kernel/collaboration-board.test.mjs',
  'tests/reliable-kernel/collaboration-capacity.test.mjs',
  'tests/reliable-kernel/collaboration-tool-boundary.test.mjs',
  'tests/reliable-kernel/cross-conversation-contract.test.mjs',
  'tests/reliable-kernel/mcp-source-policy.test.mjs',
  'tests/reliable-kernel/collaboration-card-labels.test.mjs',
  'tests/reliable-kernel/cross-conversation-tools.test.mjs',
  'tests/reliable-kernel/native-collaboration-handles.test.mjs',
  'tests/reliable-kernel/collaboration-schema-epoch.test.mjs',
  'tests/reliable-kernel/collaboration-lifecycle.test.mjs',
  'tests/reliable-kernel/compression-rebuild-entry.test.mjs',
  'tests/reliable-kernel/client-feed-window-rollover.test.mjs',
  'tests/reliable-kernel/conversation-deletion-recovery.test.mjs',
  'tests/reliable-kernel/conversation-fork-context.test.mjs',
  'tests/reliable-kernel/conversation-fork-lifecycle.test.mjs',
  'tests/reliable-kernel/current-turn-task-projection.test.mjs',
  'tests/reliable-kernel/frontend-copy-guardrails.test.cjs',
  'tests/reliable-kernel/guidance-queue.test.mjs',
  'tests/reliable-kernel/compression-progress-ui.test.mjs',
  'tests/reliable-kernel/configuration-authority.test.mjs',
  'tests/reliable-kernel/session-thinking-control.test.mjs',
  'tests/reliable-kernel/session-thinking-simple.test.mjs',
  'tests/reliable-kernel/session-thinking-runtime.test.mjs',
  'tests/reliable-kernel/session-thinking-store.test.cjs',
  'tests/reliable-kernel/session-thinking.test.mjs',
  'tests/reliable-kernel/settings-flush-convergence.test.mjs',
  'tests/reliable-kernel/settings-save-barrier-detach.test.mjs',
  'tests/reliable-kernel/sidebar-collapse-intent.test.mjs',
  'tests/reliable-kernel/scroll-anchor.test.mjs',
  'tests/reliable-kernel/global-settings-live-save.test.mjs',
  'tests/reliable-kernel/read-file-slice.test.mjs',
  'tests/reliable-kernel/request-compression-settings.test.mjs',
  'tests/reliable-kernel/model-capabilities.test.mjs',
  'tests/reliable-kernel/compression-provider-contracts.test.mjs',
  'tests/reliable-kernel/compression-reduction-gate.test.mjs',
  'tests/reliable-kernel/diagnostic-journal.test.mjs',
  'tests/reliable-kernel/debug-capture-controller.test.mjs',
  'tests/reliable-kernel/debug-capture-provenance.test.mjs',
  'tests/reliable-kernel/debug-capture-files.test.mjs',
  'tests/reliable-kernel/debug-capture-ui.test.mjs',
  'tests/reliable-kernel/edit-tool-invariants.test.cjs',
  'tests/reliable-kernel/llm-capability-provider-adapter.test.mjs',
  'tests/reliable-kernel/llm-provider-configs-native.test.mjs',
  'tests/reliable-kernel/tool-boundary-regressions.test.mjs',
  'tests/reliable-kernel/model-system-prompt-prefix.test.mjs',
  'tests/reliable-kernel/native-astra-integration.test.mjs',
  'tests/reliable-kernel/native-compression-guard.test.mjs',
  'tests/reliable-kernel/native-tool-admission.test.mjs',
  'tests/reliable-kernel/native-provider-capability.test.mjs',
  'tests/reliable-kernel/gpt6-family-adaptation.test.mjs',
  'tests/reliable-kernel/openai-responses-ws-explicit-cache.test.mjs',
  'tests/reliable-kernel/native-request-orchestration.test.mjs',
  'tests/reliable-kernel/native-compact-media.test.mjs',
  'tests/reliable-kernel/phase-b-foundation.test.mjs',
  'tests/reliable-kernel/plan-interrupt-recovery.test.mjs',
  'tests/reliable-kernel/product-composition.test.mjs',
  'tests/reliable-kernel/provider-semantic-watchdog.test.mjs',
  'tests/reliable-kernel/llm-finish-reason.test.mjs',
  'tests/reliable-kernel/openai-request-shaping.test.mjs',
  'tests/reliable-kernel/claude-thinking-adaptation.test.mjs',
  'tests/reliable-kernel/provider-parameter-adaptation.test.mjs',
  'tests/reliable-kernel/provider-wire-invariant.test.mjs',
  'tests/reliable-kernel/claude-cross-model-thinking-replay.test.mjs',
  'tests/reliable-kernel/provider-history-wire.test.mjs',
  'tests/reliable-kernel/claude-turn-scoped-reminders.test.mjs',
  'tests/reliable-kernel/claude-turn-scoped-reminders-runtime.test.mjs',
  'tests/reliable-kernel/claude-turn-scoped-reminder-edges.test.mjs',
  'tests/reliable-kernel/claude-native-compaction-shaping.test.mjs',
  'tests/reliable-kernel/gemini-provider-adaptation.test.mjs',
  'tests/reliable-kernel/gemini-thought-signature-runtime.test.mjs',
  'tests/reliable-kernel/provider-websocket-policy.test.mjs',
  'tests/reliable-kernel/reliable-control-lifecycle.test.mjs',
  'tests/reliable-kernel/reliable-outbox-ui-contract.test.mjs',
  'tests/reliable-kernel/segmented-summary-chunking.test.mjs',
  'tests/reliable-kernel/segmented-rebuild-admission.test.mjs',
  'tests/reliable-kernel/streaming-output-regressions.test.mjs',
  'tests/reliable-kernel/storage-lock-multiprocess.test.cjs',
  'tests/reliable-kernel/stream-reset-tool-idempotency.test.mjs',
  'tests/reliable-kernel/vscode-fs-local-read.test.cjs',
  'tests/reliable-kernel/webview-feed-lifecycle.test.mjs',
  'tests/reliable-kernel/waiting-interaction-cancellation.test.mjs',
  'tests/reliable-kernel/interaction-auto-approval.test.mjs',
  'tests/reliable-kernel/platform-runtime-compatibility.test.mjs',
  'tests/reliable-kernel/runtime-claim-windows-rename.test.cjs',
  'tests/reliable-kernel/workspace-runtime-isolation.test.mjs',
  'tests/reliable-kernel/runtime-datasets.test.mjs',
  'tests/reliable-kernel/runtime-dataset-history-storage.test.mjs',
  'tests/reliable-kernel/work-environment-selection.test.cjs',
  'tests/reliable-kernel/active-turn-work-environment-projection.test.mjs',
  'tests/reliable-kernel/runtime-dataset-commands.test.cjs',
  'tests/reliable-kernel/work-environment-transfer-boundary.test.cjs',
  'tests/runAgentToolSchema.test.cjs',
  'tests/settingsRevisionConflict.test.cjs',
  'tests/storageLockRace.test.cjs',
  'tests/vscodeStorageJsonDurability.test.cjs',
  'tests/webviewLocalResources.test.cjs',
  ...WEBVIEW_TEST_FILES
]);
// Scan only current kernel tests and explicitly reviewed frontend projections; retired world/file
// tests must not pull deleted modules back into the compiled closure.
const testsRoot = path.join(root, 'tests', 'reliable-kernel');
const files = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (/\.test\.(?:cjs|mjs|js)$/.test(entry.name)) files.push(path.relative(root, absolute));
  }
}
if (process.argv.includes('--ci')) {
  for (const file of CI_TEST_FILES) {
    if (!fs.existsSync(path.join(root, file))) {
      console.error(`CI关键测试不存在：${file}`);
      process.exit(1);
    }
    files.push(file);
  }
} else {
  walk(testsRoot);
  files.push(...WEBVIEW_TEST_FILES);
}
files.sort();
if (files.length === 0) {
  console.error('在tests/reliable-kernel/**/*.test.{cjs,mjs,js}下没有找到当前可靠内核本机测试。');
  process.exit(1);
}
if (process.argv.includes('--list')) {
  for (const file of files) console.log(file);
  process.exit(0);
}
console.log(
  process.argv.includes('--ci')
    ? `按稳定顺序运行${files.length}个已纳入版本库的CI关键测试文件。`
    : `按稳定顺序运行${files.length}个当前可靠内核本机测试文件。`
);
// Guard against a hung run, not a budget for the suite: the serial suite alone now takes about
// 13-14 minutes on a developer machine, so a 10-minute cap failed every complete run.
const TEST_TIMEOUT_MS = 30 * 60 * 1000;
// Several gate tests intentionally read/write shared evidence files. Node's default per-file
// parallelism makes those durable fixtures race each other, so the advertised stable order must be
// real rather than merely sorting the argv list.
const webviewTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-webview-tests-'));
// Vite sets NODE_ENV while bundling; do not leak its production environment into Node/SSR tests.
const testEnvironment = { ...process.env };
let result;
try {
  // Use the application's existing resolver/transpiler: Node's strip-only loader cannot resolve
  // Vite aliases, extensionless shared imports, or the protocol's TypeScript enums.
  const { build, loadConfigFromFile } = await import('vite');
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'test' }, path.join(root, 'vite.config.ts'));
  if (!loaded) throw new Error('Unable to load webview build configuration');
  await build({
    ...loaded.config,
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: true,
      outDir: webviewTestRoot,
      rollupOptions: {
        input: WEBVIEW_TEST_FILES.map(file => path.join(root, file)),
        output: { entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' }
      }
    }
  });
  const runnableFiles = files.map(file => file.endsWith('.ts')
    ? path.join(webviewTestRoot, `${path.basename(file, '.ts')}.mjs`)
    : file);
  result = childProcess.spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...runnableFiles],
    { cwd: root, env: testEnvironment, stdio: 'inherit', timeout: TEST_TIMEOUT_MS }
  );
} finally {
  fs.rmSync(webviewTestRoot, { recursive: true, force: true });
}
if (result.error) {
  if (result.error.code === 'ETIMEDOUT') {
    console.error(`本机测试超过${Math.round(TEST_TIMEOUT_MS / 60000)}分钟上限，已强制终止。`);
    process.exit(1);
  }
  throw result.error;
}
process.exit(result.status ?? 1);
