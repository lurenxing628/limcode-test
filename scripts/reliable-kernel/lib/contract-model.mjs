import fs from 'node:fs';
import path from 'node:path';

/** Source text with LF line endings, so a Windows checkout (core.autocrlf) matches the same multi-line snippets. */
function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

export const CONTRACT_FILES = [
  'authority.json',
  'client-feed.json',
  'context.json',
  'file.json',
  'gate-registry.json',
  'identity.json',
  'migration.json',
  'subagent.json',
  'targets.json',
  'tool.json',
  'transition-ledger.json'
];

const CONTRACT_REVISION = '2026-07-31-r4';
const CLIENT_FEED_CONTRACT_REVISION = '2026-09-27-r1';
const SUBAGENT_CONTRACT_REVISION = '2026-09-25-r7';
// Contracts revised after the base revision; every other contract file stays at CONTRACT_REVISION.
const FILE_CONTRACT_REVISIONS = new Map([
  ['client-feed.json', CLIENT_FEED_CONTRACT_REVISION],
  ['subagent.json', SUBAGENT_CONTRACT_REVISION]
]);
const STAGES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const ROOT_BINDING_FIELDS = [
  'paths',
  'dataSetId',
  'rootInstanceId',
  'rootGeneration',
  'pointerRevision',
  'runtimeKernelEpoch'
];
const RECOVERY_IDS = [
  'recovery.effect-intent-hanging',
  'recovery.file-change-unresolved',
  'recovery.answer-inbox-invariant',
  'recovery.delivery-pending',
  'recovery.foreground-answer-wait-expired',
  'recovery.interrupted-subtree-incomplete'
];
const RECOVERY_OWNER = new Map([
  ['recovery.effect-intent-hanging', 'D'],
  ['recovery.file-change-unresolved', 'D'],
  ['recovery.answer-inbox-invariant', 'F'],
  ['recovery.delivery-pending', 'F'],
  ['recovery.foreground-answer-wait-expired', 'F'],
  ['recovery.interrupted-subtree-incomplete', 'F']
]);
const F_RECOVERY_IDS = RECOVERY_IDS.filter((id) => RECOVERY_OWNER.get(id) === 'F');

const PLAN_FILES = [
  'docs/architecture/reliable-kernel/BACKGROUND.md',
  'docs/architecture/reliable-kernel/README.md',
  'docs/architecture/reliable-kernel/INDEX.md',
  'docs/architecture/reliable-kernel/PLAN-CLOSURE-HANDOFF.md',
  'docs/architecture/reliable-kernel/00-program-charter.md',
  'docs/architecture/reliable-kernel/01-invariants-and-authority.md',
  'docs/architecture/reliable-kernel/02-workflow-and-gates.md',
  'docs/architecture/reliable-kernel/phases/phase-a-baseline-and-boundary.md',
  'docs/architecture/reliable-kernel/phases/phase-b-sqlite-cas-foundation.md',
  'docs/architecture/reliable-kernel/phases/phase-c-turn-control-plane.md',
  'docs/architecture/reliable-kernel/phases/phase-d-effects-tools-files-processes.md',
  'docs/architecture/reliable-kernel/phases/phase-e-context-provider.md',
  'docs/architecture/reliable-kernel/phases/phase-f-subagent-client.md',
  'docs/architecture/reliable-kernel/phases/phase-g-hard-cut-release.md',
  'docs/architecture/reliable-kernel/appendices/implementation-stage-index.md',
  'docs/architecture/reliable-kernel/appendices/performance-and-packaging-gates.md',
  'docs/architecture/reliable-kernel/appendices/terminology.md'
];

const REQUIRED_RUNTIME_DOMAINS = [
  'ContentObject',
  'Conversation',
  'ProjectContext',
  'ConversationProjectLink',
  'ConversationReuseLink',
  'ConversationBranchLink',
  'ConversationOriginLink',
  'AgentConversationLink',
  'Turn',
  'TurnIntent',
  'TurnIntentRevision',
  'TurnExecutionPresetRevision',
  'TurnIntentAuthorityRevision',
  'TurnIntentExecutorLink',
  'PendingTurnInput',
  'ExecutionLease',
  'AuthoritySnapshot',
  'TurnTermination',
  'TurnExecutorLink',
  'CommandReceipt',
  'Message',
  'MessageRevision',
  'MessageCurrentRevisionLink',
  'MessagePartOfConversation',
  'MessageTurnLink',
  'Attachment',
  'AttachmentLink',
  'ConversationAttachmentHandleLink',
  'AttachmentObservationLink',
  'InteractionRequest',
  'InteractionOwnerLink',
  'InteractionToolCallLink',
  'InteractionResponse',
  'ToolCall',
  'ToolCallSourceLink',
  'ToolCallPolicySnapshot',
  'ToolCallEvent',
  'ToolExecution',
  'Operation',
  'Attempt',
  'OutcomePause',
  'OperationResolution',
  'EffectIntent',
  'EffectReceipt',
  'ToolOutcome',
  'ToolModelResult',
  'ToolResultArtifact',
  'FileChangeSet',
  'FileChangeSetMember',
  'FileChangeDecision',
  'FileMutationReceipt',
  'FileMutationReceiptMember',
  'Process',
  'ProcessOriginLink',
  'ProcessCompletionSourceLink',
  'ProcessOutputChunk',
  'ProcessReceipt',
  'ProcessCompletionDispatch',
  'ChildInterruptionProcessCleanup',
  'ContextSegment',
  'ContextSegmentSource',
  'ContextSequenceNode',
  'ContextSequenceRoot',
  'ConversationContextHeadLink',
  'ConversationContextHandleState',
  'ContextRootHandleCatalog',
  'ModelContextProjection',
  'ModelRequest',
  'ModelRequestMessageLink',
  'CompressionBlock',
  'CompressionBlockSource',
  'CompressionBlockObservationLink',
  'ModelStreamCheckpoint',
  'ModelStreamFence',
  'TurnFinalOutputFence',
  'ChildExecution',
  'ChildExecutionParentLink',
  'ChildExecutionTurnLink',
  'ChildExecutionIntentLink',
  'ChildExecutionActiveTurnLink',
  'ChildInterruptionRequest',
  'ChildInterruptionLineageLink',
  'ChildInterruptionTurnLink',
  'ChildInterruptionIntentLink',
  'AnswerBridge',
  'AnswerSubmission',
  'AnswerPayload',
  'RuntimeInboxItem',
  'RuntimeInboxPayloadLink',
  'RuntimeDelivery',
  'RuntimeDeliveryIntentLink',
  'RuntimeDeliveryInputLink',
  'RuntimeDeliveryWake',
  'CollaborationMessage',
  'CollaborationMessageSourceLink',
  'CollaborationMessageTargetLink',
  'CollaborationMessagePayloadLink',
  'CollaborationMessageReplyLink',
  'CollaborationBudget',
  'CollaborationRequest',
  'CollaborationRequestTurnLink',
  'CollaborationBoardChannel',
  'CollaborationBoardChannelScopeLink',
  'CollaborationBoardPost',
  'CollaborationBoardPostChannelLink',
  'CollaborationBoardPostSourceLink',
  'CollaborationBoardReplyLink',
  'CollaborationBoardSubscriptionLink',
  'CollaborationBoardCommandReceipt',
  'RuntimeDeliveryTimelineLink',
  'CollaborationSendTimelineLink',
  'TimelineImportProvenance',
  'RuntimeDeliveryAnswerPresentation'
];

const CONFIGURATION_DOMAINS = [
  'Agent',
  'Workflow',
  'PlanReviewPolicy',
  'PlanReviewPolicyScopeLink',
  'ToolPolicy',
  'ToolPolicyScopeLink',
  'SkillPolicy',
  'SkillPolicyScopeLink',
  'SystemPrompt',
  'SystemPromptScopeLink',
  'ModelProfile',
  'ModelProfileScopeLink',
  'GlobalSettings',
  'LlmProviderConfig',
  'LlmCompressionConfig',
  'McpServerConfig',
  'WorkEnvironment',
  'WorkEnvironmentPolicy',
  'WorkEnvironmentPolicyScopeLink',
  'RuntimeContext',
  'RuntimeContextScopeLink',
  'CheckpointPolicy',
  'CheckpointPolicyScopeLink'
];

const CAPABILITY_DISPOSITIONS = [
  'conversation-fork',
  'mcp-settings-connections',
  'mcp-tool-call',
  'attachments',
  'ask-user',
  'task-list',
  'compression-management',
  'skills',
  'rules',
  'workspace-checkpoint'
];

const SMOKE_IDS = [
  'smoke.open-extension',
  'smoke.send-message',
  'smoke.read-only-tool',
  'smoke.file-proposal-approve-apply',
  'smoke.command-run-and-wait',
  'smoke.subagent-start-and-cancel',
  'smoke.turn-interrupt',
  'smoke.extension-host-restart',
  'smoke.recovery-verification'
];

const GATE_CHECK_IDS = {
  plan: [
    'plan.contract-coherence',
    'plan.transition-disposition',
    'plan.no-legacy-compatibility'
  ],
  foundation: [
    'foundation.sqlite-driver-load',
    'foundation.single-db-worker',
    'foundation.schema-repositories',
    'foundation.cas-publish-before-reference',
    'foundation.root-binding-fence',
    'foundation.no-legacy-fallback',
    'foundation.empty-root-current-epoch',
    'foundation.baselines-non-placeholder'
  ],
  candidate: [
    'candidate.turn-sole-execution-identity',
    'candidate.tool-model-result-exactly-once',
    'candidate.file-proposal-result-separated',
    'candidate.effect-receipt-reconcile',
    'candidate.context-storage-growth',
    'candidate.context-compression-node-bound',
    'candidate.provider-continuation-disabled-full-request',
    'candidate.conversation-fork-links',
    'candidate.compression-immutable-replacement',
    'candidate.attachment-cas-ingest',
    'candidate.mcp-effect-recovery',
    'candidate.process-wrapper-recovery',
    'candidate.process-output-bounds',
    'candidate.subagent-answer-restart-delivery',
    'candidate.subagent-cancel-subtree',
    'candidate.client-snapshot-bounds',
    'candidate.client-change-batch-bounds',
    'candidate.client-queue-bounds',
    'candidate.client-snapshot-feed-barrier',
    'candidate.old-writer-not-routed',
    'candidate.recovery.effect-intent-hanging',
    'candidate.recovery.file-change-unresolved',
    'candidate.recovery.answer-inbox-invariant',
    'candidate.recovery.pending-delivery',
    'candidate.recovery.foreground-wait-expired',
    'candidate.recovery.interrupted-subtree-incomplete',
    'candidate.parent-handling-matrix'
  ],
  package: [
    'package.legacy-runtime-archived',
    'package.legacy-entry-unreachable',
    'package.provenance-clean-commit',
    'package.provenance-vsix-main-entry-digest',
    'package.installed-main-entry-digest',
    'package.surface-forbidden-files',
    'package.configuration-manifest',
    'package.empty-root',
    'package.runtime-epoch',
    'package.source-symbols-removed',
    'package.dist-import-unreachable',
    'package.vsix-legacy-entry-absent',
    'package.bridge-payload-plain',
    'package.baselines-non-placeholder',
    ...SMOKE_IDS.map((id) => `package.${id}`)
  ]
};

const EXTERNAL_MIGRATION_IDS = [
  'external.global-skills',
  'external.global-agents-rule',
  'external.global-claude-rule',
  'external.workspace',
  'external.unknown-data-root-files',
  'control.data-root-backups',
  'control.data-reset-pending',
  'control.root-binding-pointer'
];

export function loadContractDocuments(root) {
  const directory = path.join(root, 'docs/architecture/reliable-kernel/contracts');
  return Object.fromEntries(CONTRACT_FILES.map((file) => [
    file,
    JSON.parse(readText(path.join(directory, file)))
  ]));
}

export function validateContractDocuments(root, documents) {
  const failures = [];
  validatePlanFiles(root, failures);
  validateCommon(documents, failures);
  validateGateRegistry(documents['gate-registry.json'], failures);
  validateValidatorProtocol(root, documents['gate-registry.json'], failures);
  validateMigration(root, documents['migration.json'], failures);
  validateAuthority(documents['authority.json'], documents['migration.json'], failures);
  validateForeignHistory(root, documents['authority.json'], failures);
  validateDeletedConversations(root, failures);
  validateIdentity(documents['identity.json'], failures);
  validateTool(documents['tool.json'], failures);
  validateFile(documents['file.json'], failures);
  validateContext(documents['context.json'], failures);
  validateSubagent(documents['subagent.json'], failures);
  validateClient(root, documents['client-feed.json'], failures);
  validateTargets(documents['targets.json'], documents['gate-registry.json'], failures);
  validateTransitionLedger(root, documents['transition-ledger.json'], failures);
  validateCrossContract(documents, failures);
  validateHumanPlanMarkers(root, failures);
  return failures;
}

export function selectGateValidators(registry, stage) {
  const gate = (registry.gates ?? []).find((entry) => entry.id === stage);
  if (!gate) throw new Error(`未知出口：${stage}`);
  const orderByGate = new Map((registry.gates ?? []).map((entry) => [entry.id, entry.order]));
  return (registry.validatorGroups ?? [])
    .filter((group) => orderByGate.get(group.introducedAt) <= gate.order)
    .map((group) => group.id);
}

export function exactSetProblems(label, expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const failures = [];
  for (const value of expectedSet) if (!actualSet.has(value)) failures.push(`${label}缺少${value}`);
  for (const value of actualSet) if (!expectedSet.has(value)) failures.push(`${label}出现未登记值${value}`);
  if (actual.length !== actualSet.size) failures.push(`${label}存在重复值`);
  return failures;
}

function validatePlanFiles(root, failures) {
  for (const relativePath of PLAN_FILES) {
    if (!fs.existsSync(path.join(root, relativePath))) failures.push(`缺少计划文件：${relativePath}`);
  }
  const phaseDirectory = path.join(root, 'docs/architecture/reliable-kernel/phases');
  if (!fs.existsSync(phaseDirectory)) return;
  for (const name of fs.readdirSync(phaseDirectory)) {
    if (/^phase-\d/.test(name)) failures.push(`旧的数字阶段文件仍然存在：${name}`);
  }
}

function validateCommon(documents, failures) {
  for (const file of CONTRACT_FILES) {
    const document = documents[file];
    const kind = file.replace(/\.json$/, '');
    if (!plainObject(document)) {
      failures.push(`${file}不是JSON对象`);
      continue;
    }
    if (document.contractKind !== kind) failures.push(`${file}.contractKind必须是${kind}`);
    const expectedRevision = FILE_CONTRACT_REVISIONS.get(file) ?? CONTRACT_REVISION;
    if (document.contractRevision !== expectedRevision) failures.push(`${file}.contractRevision必须为${expectedRevision}`);
    if (!['planned', 'active'].includes(document.status)) failures.push(`${file}.status必须是planned或active`);
    if ('$schema' in document) failures.push(`${file}不应通过另一份JSON Schema绕开直接校验`);
  }
}

function validateGateRegistry(registry, failures) {
  const gates = objectArray(registry?.gates, 'gate-registry.gates', failures);
  const validators = objectArray(registry?.validatorGroups, 'gate-registry.validatorGroups', failures);
  failures.push(...exactSetProblems('正式出口', ['foundation', 'candidate', 'installed'], gates.map((entry) => entry.id)));
  failures.push(...exactSetProblems('直接校验器', ['plan', 'foundation', 'candidate', 'package'], validators.map((entry) => entry.id)));

  const sorted = [...gates].sort((left, right) => left.order - right.order);
  sorted.forEach((gate, index) => {
    if (gate.order !== index + 1) failures.push(`${gate.id}.order必须是${index + 1}`);
    const expectedArtifact = gate.id === 'installed' ? 'required' : 'not-allowed';
    if (gate.artifact !== expectedArtifact) failures.push(`${gate.id}.artifact必须是${expectedArtifact}`);
    nonEmptyStringArray(gate.stages, `${gate.id}.stages`, failures);
  });

  const gateIds = new Set(gates.map((entry) => entry.id));
  const allCheckIds = [];
  for (const validator of validators) {
    if (!gateIds.has(validator.introducedAt)) failures.push(`${validator.id}.introducedAt不是有效出口`);
    nonEmptyString(validator.path, `${validator.id}.path`, failures);
    const checks = objectArray(validator.checks, `${validator.id}.checks`, failures);
    failures.push(...exactSetProblems(`${validator.id}稳定检查ID`, GATE_CHECK_IDS[validator.id] ?? [], checks.map((entry) => entry.id)));
    for (const entry of checks) {
      nonEmptyString(entry.id, `${validator.id}.check.id`, failures);
      nonEmptyString(entry.description, `${entry.id}.description`, failures);
      if (!STAGES.includes(entry.ownerStage)) failures.push(`${entry.id}.ownerStage无效`);
      if (entry.contractRef !== undefined) nonEmptyString(entry.contractRef, `${entry.id}.contractRef`, failures);
      allCheckIds.push(entry.id);
    }
  }
  uniqueStrings(allCheckIds, '全局gate check ID', failures);
  const packageValidator = validators.find((entry) => entry.id === 'package');
  if (packageValidator?.introducedAt !== 'installed') {
    failures.push('package校验器只能从installed出口开始');
  }
  const cleanCommitCheck = packageValidator?.checks?.find((entry) => entry.id === 'package.provenance-clean-commit');
  if (!String(cleanCommitCheck?.description ?? '').includes('worktreeClean=true')) failures.push('package clean-commit check必须验证构建时worktreeClean=true');
  if (registry?.checkIdentity !== 'stable-id-not-description') failures.push('gate check身份必须使用稳定ID而不是description');
  if (registry?.handlerProtocol !== 'Map<checkId,handler>') failures.push('gate handler协议必须使用Map<checkId,handler>');
  if (registry?.runner?.result !== 'exit-code-and-plain-diagnostics') failures.push('出口校验器必须用退出码和普通诊断文本报告结果');
  if (registry?.capabilityCutover?.gate !== 'installed') failures.push('正式能力切换必须发生在installed出口');
  if (registry?.capabilityCutover?.fallback !== false) failures.push('能力切换不得回退旧运行时');

  const recoveryRefs = validators
    .find((entry) => entry.id === 'candidate')?.checks
    ?.filter((entry) => entry.id.startsWith('candidate.recovery.'))
    .map((entry) => entry.contractRef) ?? [];
  failures.push(...exactSetProblems('candidate recovery contractRef', RECOVERY_IDS, recoveryRefs));
}

function validateValidatorProtocol(root, registry, failures) {
  for (const group of registry?.validatorGroups ?? []) {
    const validatorPath = group.path;
    const absolute = typeof validatorPath === 'string' ? path.join(root, validatorPath) : '';
    if (!absolute || !fs.existsSync(absolute)) {
      failures.push(`${group.id}校验器文件不存在：${validatorPath ?? '未登记'}`);
      continue;
    }
    const source = readText(absolute);
    if (!source.includes('new Map(') || !source.includes('.get(check.id)')) failures.push(`${group.id}校验器必须使用Map<checkId,handler>`);
    if (source.includes('matches(check)') || source.includes('.find(([matches])')) failures.push(`${group.id}校验器不得按description谓词匹配handler`);
    if (group.id !== 'plan' && !source.includes('PENDING:')) failures.push(`${group.id}校验器必须诚实输出PENDING`);
  }
  const packageSource = readText(path.join(root, 'scripts/reliable-kernel/validators/package.mjs'));
  for (const marker of [
    "unzipEntry(absolute, 'extension/package.json'",
    'readVsixMainEntry(absolute)',
    "crypto.createHash('sha256')",
    'provenance.mainEntrySha256',
    'provenance.worktreeClean !== true'
  ]) {
    if (!packageSource.includes(marker)) failures.push(`package provenance handler缺少制品真实性步骤：${marker}`);
  }
  if (packageSource.includes("fs.readFileSync(path.join(root, 'package.json')")) failures.push('package validator不得用工作区package.json代替VSIX内manifest');
  const generatorSource = readText(path.join(root, 'scripts/reliable-kernel/write-build-provenance.mjs'));
  if (!generatorSource.includes('manifest.main') || !generatorSource.includes("crypto.createHash('sha256')")) failures.push('build provenance generator必须读取package.json.main并计算SHA-256');
  for (const marker of ["'status'", "'--porcelain'", "'--untracked-files=all'", 'worktreeClean']) {
    if (!generatorSource.includes(marker)) failures.push(`build provenance generator缺少构建时工作区洁净检查：${marker}`);
  }
}

function validateMigration(root, migration, failures) {
  if (migration?.strategy !== 'archive-reset-hard-cut') failures.push('运行时迁移必须使用归档、重置、硬切换');
  for (const field of ['legacyRuntimeImport', 'dualWrite', 'fallbackToLegacyRuntime', 'runtimeProtocolNegotiation']) {
    if (migration?.[field] !== false) failures.push(`migration.${field}必须为false`);
  }
  const upgrade = migration?.boundedEpochUpgrade;
  failures.push(...exactSetProblems('精确升级前驱', [3, 4, 5], upgrade?.fromEpochs ?? []));
  if (migration?.currentRuntimeEpoch !== 6
    || upgrade?.toEpoch !== 6
    || upgrade?.sourcePolicy !== 'exact-published-table-index-trigger-manifest-and-binding-fingerprint'
    || upgrade?.backupPolicy !== 'sqlite-backup-api-plus-root-binding-and-epoch-manifest'
    || upgrade?.recoveryPolicy !== 'durable-journal-forward-only'
    || upgrade?.retiredEpoch3To4Recovery !== 'exact-pending-or-journal-before-current-upgrade'
    || upgrade?.publishedEpoch3Or4To5Recovery !== 'exact-original-epoch-to-5-journal-and-binding-before-epoch-to-6-upgrade'
    || upgrade?.epoch6CatalogReferencePolicy !== 'epoch-6-whole-data-set-admission-fence-for-compact-catalog-reference-recipes; new-writes-only-inline-recipes-keep-their-bytes; no-domain-row-or-history-body-rewrite-in-upgrade; old-epoch-5-readers-refuse-open; live-or-unknown-old-hosts-block-upgrade'
    || upgrade?.epoch6FrozenToolsReferencePolicy !== 'epoch-6-whole-data-set-admission-fence-for-frozen-tools-reference-recipes; new-writes-only-inline-recipes-keep-their-bytes; no-domain-row-or-history-body-rewrite-in-upgrade; old-epoch-5-readers-refuse-open; live-or-unknown-old-hosts-block-upgrade'
    || upgrade?.epoch6PackedCasPolicy !== 'epoch-6-whole-data-set-admission-fence-for-packed-small-cas; new-writes-only-loose-cas-keeps-its-bytes; no-history-body-rewrite-or-startup-packing; old-epoch-5-readers-refuse-open; live-or-unknown-old-hosts-block-upgrade'
    || upgrade?.epoch6HandleStatePolicy !== 'all-published-sources; conversation-current-pointer-and-immutable-scoped-root-catalog-domains; one-pending-current-head-root-null-cas-revision-zero-reset-row-per-existing-conversation-only; preserve-all-existing-rows-and-cas; no-history-or-catalog-rebuild-in-upgrade-transaction'
    || upgrade?.legacyChildContinuationPolicy !== 'epoch-3-and-exact-epoch-4-missing-link-only'
    || upgrade?.epoch4MissingLinkPredecessor !== 'exact-single-missing-runtime-delivery-intent-link'
    || upgrade?.unknownDriftPolicy !== 'fail-before-data-change'
    || upgrade?.compatibilityFallback !== false
    || migration?.schemaUpgradePolicy?.olderEpoch !== 'published-3-4-and-5-exact-offline-upgrade-others-fail-closed'
    || migration?.schemaUpgradePolicy?.currentEpoch !== 'exact-manifest-and-physical-fingerprint-only'
    || migration?.schemaUpgradePolicy?.partialAdditiveUpgrade !== false
    || migration?.schemaUpgradePolicy?.unknownDrift !== 'fail-closed') {
    failures.push('Runtime epoch 6 只接受已发布 3/4/5 精确备份升级；新写法只用于新写入，旧 reader/Host 受 epoch 6 全库栅栏隔离；未知漂移必须拒绝');
  }
  failures.push(...exactSetProblems('epoch升级保留对象',
    ['runtime-rows', 'cas', 'sqlite-backup', 'runtime-archive', 'configuration', 'workspace'],
    migration?.schemaUpgradePolicy?.preserve ?? []));
  failures.push(...exactSetProblems('旧历史自动升级触发点',
    ['selected-root-startup', 'other-roots-after-startup', 'history-open'], upgrade?.automaticTriggers ?? []));
  if (upgrade?.requiresUserConfirmation !== false
    || upgrade?.targetHostPolicy !== 'target-offline-current-other-data-set-may-run'
    || upgrade?.sourceFailurePolicy !== 'report-per-source-and-continue-other-sources'
    || upgrade?.selectionPolicy !== 'preserve-selection-merge-only-via-historical-merge'
    || upgrade?.historicalExecutionPolicy !== 'no-host-registration-or-task-recovery') {
    failures.push('旧历史必须自动备份升级，仅要求目标离线；逐库报告失败，不切换当前库或执行旧任务');
  }
  const merge = migration?.historicalMerge;
  const expectedMerge = {
    "sources": [
      "all-noncurrent-local-data-sets-including-legacy-kept-and-switched",
      "foreign-history-roots-registered-pending-and-verified-under-their-claim",
      "relocation-left-behind-sources-registered-pending"
    ],
    "target": "selected-current-epoch-data-set-open-in-requesting-host",
    "initialSelection": "no-selection-file-only-candidates-passing-read-only-preflight-epoch-3-4-5-6-exact-schema-and-physical-fingerprint-published-3-4-5-also-quick-check-and-no-recorded-failure; pending-recovery-window-left-to-its-gate; fixed-root-with-complete-binding-else-latest-modified-scope; none-passing-or-unreadable-container-requires-explicit-choice-with-reasons; existing-selection-never-switched",
    "trigger": "background-after-selected-runtime-ready-and-historical-upgrades; one-source-at-a-time; selection-under-admission-reads-only-ledger-requests-and-file-states-uncached-fingerprints-judged-outside; hosts-prepare-without-claims-and-commit-one-at-a-time-under-admission-and-source-maintenance; later-host-rechecks-source-files-then-rereads-ledger-and-skips-source-already-merged-unreported; before-deferring-a-changed-source-or-an-unexpected-error-ledger-reread-source-merged-into-same-target-after-batch-picked-it-skipped-silently-explicit-request-told-already-merged",
    "requiresUserConfirmation": false,
    "explicitRequestConfirmation": "modal-states-online-limit-bounded-cancellable-wait-for-busy-windows-one-reload-of-others-and-hard-limit-from-code-constants; states-interrupted-tasks-ended-queued-unsent-messages-cancelled-and-conversations-deleted-here-after-merge-never-merged-back; then-online-merge-in-requesting-window-no-reload; outcome-always-told-already-merged-nothing-new-or-why-nothing-was-done",
    "writePath": "one-ordinary-runtime-database-write-transaction-per-source; repository-insert-steps-codec-validated-under-worker-insert-invariants; other-hosts-keep-running-and-see-an-external-commit; that-transaction-alone-commits-with-synchronous-full-then-normal-again-also-after-failure-synced-before-the-merged-record; large-session-source-is-one-streamed-maintenance-transaction-of-a-private-offline-instance-appended-in-chunks-of-250-source-rows-in-merge-domain-and-rowid-order-with-the-same-row-rules-and-each-chunks-presence-assertions; its-aggregates-asserted-at-commit-no-changes-read-back; committed-with-synchronous-full-then-wal-checkpoint-truncate-before-the-merged-record; cancel-or-disk-full-rolls-back-only-the-current-source; left-out-closure-in-a-temp-table-of-the-source-copy-single-table-rules-read-in-rowid-segments-of-64-read-chunks-all-member-rules-by-candidates-from-left-out-members-dropped-by-a-full-index-probe-or-rowid-segments-yielding-after-every-segment-and-step; a-conflict-found-in-the-session-stops-it-at-that-chunk-refused-as-at-least-that-many",
    "historicalCopyDomains": [
      "ModelRequest",
      "Operation",
      "Attempt",
      "ModelStreamFence",
      "ModelStreamCheckpoint",
      "RuntimeDeliveryTimelineLink",
      "CollaborationSendTimelineLink",
      "TimelineImportProvenance",
      "RuntimeDeliveryAnswerPresentation"
    ],
    "historicalCopyPolicy": "model-request-copy-terminal-with-terminal-state; its-operation-copy-completed-cancelled-or-failed; its-attempt-copy-transient-failed-completed-cancelled-or-failed; stream-fence-and-checkpoint-only-with-parent-model-request-copied-historically-in-the-same-transaction; not-started-request-and-its-pending-operation-and-attempt-inserted-as-the-runtime-creates-them",
    "sizeLimit": "online-transaction-at-most-4000-source-rows-and-12MiB-measured-worst-about-1.3s-below-busy-timeout; in-memory-transaction-limit-60000-source-rows-above-it-deferred-awaiting-exclusive-large-session-unrecorded-before-any-plan-coordination-backup-or-finalization-unless-its-audit-found-work-no-merge-can-close-and-nothing-of-it-is-left-out-then-refused-and-recorded-whatever-its-size; in-between-exclusive-maintenance-coordinated-outside-locks-after-checks-cas-and-target-backup-locks-wrap-only-source-recheck-and-transaction-keyed-by-source-content-fingerprint-else-deferred; automatic-batch-judges-sources-above-the-online-limit-last-deferred-awaiting-exclusive-too-when-one-awaits-the-large-session-and-it-has-room-by-the-estimates-figures-for-every-source-it-would-take-disk-by-disk-else-coordinated-each-explicit-request-coordinated-alone; streamed-transaction-hard-limit-20000000-source-rows-above-it-recorded-too-large-before-any-plan-coordination-backup-or-finalization",
    "exclusivity": "snapshot-audit-plan-cas-and-target-backup-without-claims; snapshot-counts-only-if-source-file-state-unchanged-across-copy-else-retaken-at-most-3-times; finalization-and-commit-under-configuration-admission-and-source-maintenance-rechecking-hosts-offline-identity-pointer-and-exact-file-state; exclusive-fallback-takes-admission-and-target-maintenance-around-that-commit; source-offline-by-host-liveness-and-legacy-runtime-owner-claim; large-session-prepared-online-by-the-engine-in-one-window-then-exclusive-phase-under-admission-and-target-maintenance-where-the-requester-closes-its-runtime-and-the-engine-merges-source-after-source-then-the-requester-reloads-after-the-locks-are-released-a-preparation-that-does-not-run-or-was-stopped-part-way-released-back-to-the-engine; large-session-space-checked-before-the-prompt-or-confirmation-by-the-estimates-figures-with-the-target-backup-and-copied-content-before-the-coordination-and-with-statfs-right-before-the-exclusive-phase-by-the-preparations-figures-target-disk-target-bytes-margin-included-temporary-disk-temporary-bytes-plus-64MiB-only-on-a-disk-of-its-own-sqlite-temporary-disk-likewise-one-check-per-disk; large-session-preparation-one-window-per-source-preparing-record-heartbeat-10s-taken-over-after-60s-or-once-its-process-is-gone-by-pid-and-start-identity-heartbeat-written-back-under-the-admission-only-while-the-record-is-still-its-own-a-disk-full-writing-it-defers-the-source-and-stops-the-preparation; large-session-exclusive-phase-only-under-admission-and-target-maintenance-with-hosts-offline-each-source-under-its-maintenance-rechecked-unchanged-and-copied-again; large-session-estimate-before-consent-read-only-no-finalization-backup-cas-transfer-ledger-record-preparation-claim-or-published-3-4-5-upgrade-audit-cache-or-one-private-copy-per-source-foreign-roots-only-under-their-claim-taken-outside-the-admission-their-objects-counted-as-copied-content-fingerprint-as-the-preparation-gives-it-preparation-and-exclusive-times-apart-from-sizes-at-conservative-rates-exclusive-time-scaled-by-the-last-measured-session-within-0.5x-to-4x-range-0.4x-to-2.5x; large-session-preparation-only-after-consent-cancelled-preparation-offers-nothing-releases-its-claims-and-unused-target-backup; large-session-estimate-called-outside-every-lock-the-adapter-refuses-it-inside-the-configuration-admission; large-session-space-model-source-databases-plus-1.5x-the-largest-plus-target-index-pages-measured-in-a-worker-on-the-preparations-backup-else-0.65x-the-target-files-plus-0.65x-the-other-sources-plus-64MiB; large-session-sqlite-temporary-files-0.25x-the-largest-source-in-sqlites-temporary-directory-and-its-private-copy-in-the-temporary-directory; large-session-each-chunk-followed-by-statfs-under-64MiB-left-rolled-back-early-need-projected-from-the-wal-written; sqlite-full-enospc-and-edquot-all-disk-full-in-chinese-without-the-system-text-later-sources-not-run-or-not-prepared-naming-a-full-temporary-directory-and-its-need-when-the-error-names-no-file-and-the-targets-disk-has-room; a-preparation-failing-as-a-whole-says-data-unchanged-only-when-it-closed-no-sources-work",
    "sourcePolicy": "exact-published-3-4-5-backup-and-in-place-upgrade-first-then-current-epoch-fingerprint-and-integrity-from-offline-snapshot",
    "foreignSourcePolicy": "pending-source-recorded-in-the-current-configuration-root-ledger-with-location-name-and-seen-identity-automatic-convergence-or-explicit-request; its-claim-foreign-claims-id-under-the-current-configuration-root-held-from-preparation-to-commit-taken-before-admission-the-claim-of-verification-reading-and-backup-cleanup; located-paths-only-recorded-only-an-identity-fence; strictly-located-again-and-rechecked-under-its-claim-before-commit-pointer-root-binding-epoch-manifest-hosts-gone-and-exact-file-state-since-verification-else-deferred-nothing-committing; never-written-no-claim-ledger-source-backup-finalization-upgrade-wal-or-shm-inside-it-snapshot-and-audit-on-private-copies; a-published-epoch-3-4-or-5-root-merged-from-private-copies-upgraded-by-the-exact-migrator-converted-bodies-read-from-the-overlay-first; records-requests-and-fingerprints-under-the-current-configuration-root-keyed-by-foreign-id-with-source-identity-its-committing-record-never-makes-it-unverifiable; cas-objects-copied-never-linked-read-through-no-follow-descriptors-digest-verified-after-free-space-for-missing-objects-plus-64MiB-else-deferred-disk-full; unfinished-work-excludes-owned-conversations-with-counts-and-reasons-never-finalized-in-place-read-only-view-kept; same-identity-as-a-local-data-set-or-one-any-local-data-set-the-current-or-another-continues-blocked-as-its-old-copy-left-to-backup-cleanup-by-coverage-named-readably-never-by-internal-id; any-local-data-set-unreadable-deferred-its-old-copy-not-ruled-out; interrupted-commit-converges-from-ledger-and-target-without-its-claim-root-or-request-expired-or-removed-requests-included-backup-cleanup-keeps-the-root-until-then; a-merge-that-left-conversations-out-records-the-count-list-and-notice-say-backup-cleanup-keeps-that-copy-times-shown-in-local-time; two-foreign-copies-of-one-identity-first-merges-later-nothing-new-or-conflict-left-out-conversations-by-the-union-of-that-identitys-records; same-size-routing-online-exclusive-or-large-session-by-a-readable-name",
    "busySourcePolicy": "defer-source",
    "terminalUnknownProcessPolicy": "preserve-outcome_unknown-with-matching-terminal-receipt-and-completed-at-only-without-pending-operations-deliveries-or-output-debt; no-fake-exit-no-redispatch; migration-keeps-stricter-process-policy",
    "validationRevisionPolicy": "dated-derived-rule-revision-invalidates-only-affected-refusals-and-audit-caches-not-content-digests-commits-or-tombstones",
    "unfinishedWorkPolicy": "refusal-probes-conflicts-size-and-cas-checked-on-unfinalized-snapshot-first; local-source-under-maintenance-after-durable-consent-and-source-backup-opened-SETTLING_ONLY-without-execution; reuse-existing-stop-and-abandon-transitions-reason-historical-merge-settled-at-most-three-rounds-then-durabilityCheckpoint-and-close; remaining-owned-work-excludes-conversations-unattributed-settlement-failure-defers-source; foreign-source-never-finalized-in-place; existing-terminal-transition-fallback-retained-for-callers-without-settlement-adapter; turn-and-intent-closed-counts-read-back-from-source-never-planned-counts",
    "backupPolicy": "sqlite-backup-api-of-open-target-once-per-batch-before-first-change-only-when-rows-to-insert; named-utc-millisecond-time-then-process-sequence; unused-by-any-transaction-removed-at-batch-end; used-then-newest-3-by-creation-kept-per-control-root-plus-this-batch-and-newest-before-it-a-large-session-preparations-backup-with-a-live-registration-neither-pruned-nor-counted; failed-backup-leaves-no-files; target-and-source-backups-first-check-free-space-for-database-plus-wal-plus-64MiB-on-their-disk-else-deferred-disk-full-with-needed-MB-before-writing-notified-once-per-cause; large-session-target-backed-up-online-once-while-preparing-removed-when-released-unused-no-backup-in-the-exclusive-phase; large-session-target-backup-registered-before-its-first-byte-with-the-preparation-heartbeat-stale-once-its-process-is-gone-by-pid-and-start-identity-or-after-24h-an-unused-one-removed-with-its-registration-by-the-next-pruning-of-preparations-at-every-batch-end-preparation-start-and-end-a-used-one-kept-and-only-its-registration-removed-one-that-cannot-be-removed-keeps-its-registration-marked-unused-again-when-its-session-merged-nothing-a-failed-preparation-removes-its-own; closing-the-private-instance-or-removing-a-private-copy-failing-only-logged-the-outcome-and-a-used-backup-stay",
    "casPolicy": "published-before-row-commit; verified-read-only-before-finalization; source-digest-verified-before-link-or-copy; missing-irregular-or-mismatched-source-object-fails-source; existing-target-object-damaged-or-irregular-blocks; verified-file-identities-kept-per-configuration-root-in-a-limcode-named-sqlite-cache-one-connection-per-process-unchanged-identity-not-hashed-again-any-change-hashed-in-full-unconfirmed-dropped-after-90-days; a-damaged-cache-file-rebuilt-an-unusable-one-keeps-at-most-10000-identities-in-memory-a-failed-batch-write-counts-its-entries-unrecorded-and-a-preparation-that-could-not-record-them-all-defers-its-source",
    "rowPolicy": "every-source-row-decoded-by-codec; identical-rows-reused; content-identity-domains-keep-target-and-insert-only-if-still-absent-inside-the-transaction-else-compare; renumbered-columns-allocated-inside-the-transaction-after-its-maximum-in-source-order; other-differences-exclude-the-owning-conversations-and-dependency-closure-before-target-change-content-derived-or-unowned-differences-refuse-source; any-failure-inside-the-transaction-rolls-back-the-whole-source; ordinary-and-streamed-preflight-check-every-touched-model-aggregate-bidirectionally-on-kept-source-union-target-worker-snapshot-including-added-attempts-and-missing-request-owners-with-bounded-temp-id-storage; writer-final-check-retained; typed-RUNTIME_DATA_INVARIANT-or-sqlite-constraint-refusals-block-and-record-both-merge-paths-infrastructure-errors-deferred; online-target-local-or-external-commit-since-planning-defers-refusal-without-recording",
    "remergePolicy": "ledger-keeps-per-target-conversation-ids-each-merge-inserted-also-for-commits-converged-after-a-crash; every-later-merge-explicit-requested-or-converged-leaves-out-recorded-conversations-absent-from-target-with-their-subagent-descendants-in-source; left-out-closure-by-foreign-keys-ownership-rules-and-rows-only-they-use-no-inserted-row-references-a-left-out-row; content-identity-rows-insert-only-if-absent-as-ever; cross-conversation-collaboration-history-kept-as-deletion-keeps-it; left-out-count-per-deleted-conversation-in-result-notice-and-log",
    "deletedConversationPolicy": "the-deletion-command-records-every-deleted-conversation-id-of-the-whole-subagent-tree-before-the-deletion-commits-one-file-per-deletion-deleted-conversations-identity-time-random8-json-under-the-configuration-root-ledger-temporary-file-fsync-rename-directory-fsync; unwritable-record-still-deletes-and-tells-the-user-those-may-come-back-when-an-older-copy-is-merged; every-merge-online-exclusive-large-session-with-its-preparation-foreign-and-data-root-migration-leaves-out-recorded-conversations-absent-from-the-target-as-remerge-does; read-for-the-target-and-every-identity-it-continues-aliases-identity-json-written-by-a-relocation-that-expands-chains-mergedInto-of-those-targets-counts-too; also-for-the-source-and-every-identity-it-continues-a-local-ones-under-its-configuration-root-a-foreign-ones-under-the-current-an-earlier-copy-of-the-source-still-holding-what-was-deleted-from-it; a-failed-deletion-command-withdraws-its-record-while-its-conversation-is-still-there; strictly-parsed-unreadable-or-unknown-record-defers-the-merge-never-read-as-none; every-local-data-set-the-current-and-the-others-owns-the-identities-it-continues-a-copy-of-one-is-an-old-copy-of-that-data-set-refused-with-the-reason-naming-it-a-local-source-reads-closures-of-its-continued-identities-too-unreadable-continuations-defer; closures-of-an-earlier-incarnation-under-the-same-candidate-id-kept-per-source-identity-refusals-included; a-migration-that-left-conversations-out-keeps-that-old-data-set-from-old-directory-deletion; deletions-made-before-these-records-existed-can-come-back-on-merge-and-the-foreign-merge-confirmation-says-so",
    "identityDomains": {
      "ContentObject": [
        "created_at"
      ],
      "ProjectContext": [
        "name",
        "created_at",
        "updated_at"
      ],
      "Attachment": [
        "created_at"
      ],
      "AttachmentObservationLink": [
        "content_object_id",
        "created_at"
      ]
    },
    "renumberedColumns": {
      "CollaborationMessage": [
        "message_seq"
      ]
    },
    "integrity": "source-foreign-key-quick-check-before; every-source-id-asserted-present-inside-the-transaction",
    "recordPolicy": "configuration-root-ledger-survives-target-deletion; committing-with-bounded-commit-evidence-every-inserted-conversation-plus-first-and-last-50-rows-of-every-other-domain-outside-content-identity-shrunk-per-end-down-to-one-to-keep-within-2000-rows-conversations-all-kept-even-beyond-it-with-the-transactions-inserted-and-reused-row-counts-counts-as-unmerged; commit-marker-internal-command-receipt-keyed-by-commit-id-in-the-same-transaction-alone-decides-present-merged-with-the-evidences-row-counts-recording-its-conversations-present-in-the-target-absent-record-dropped-migration-without-marker-by-rows-outside-content-identity; committing-carries-replaced-record-restored-unchanged-with-its-judgment-time-on-proven-rollback-or-absent-after-crash; ledger-reread-under-claims-before-commit; nothing-to-insert-recorded-merged-without-backup; outcomes-keyed-by-source-content-digest-cached-by-exact-file-state; audit-facts-rows-bytes-content-objects-and-unfinished-work-cached-by-exact-file-state-and-identity-foreign-roots-by-their-id-under-this-configuration-root-never-a-merge-fact-a-waiting-or-small-source-judged-from-them-without-a-copy; measured-session-time-of-merged-sources-against-the-size-model-cached-per-configuration-root-for-estimates-only; failed-only-for-source-own-deterministic-problems-rows-the-target-refuses-in-a-large-session-blocked-other-errors-deferred-unrecorded; awaiting-large-session-unrecorded; too-large-above-streamed-hard-limit-records-rows-and-judging-limit-not-failure-not-retried-automatically-while-limit-and-source-unchanged-a-record-at-another-limit-judged-again; explicit-request-only-the-requesting-call; pending-registration-without-expiry-until-merged-or-residual-old-requests-read-without-expiry; closed-work-ids-counts-and-backup-kept-in-ledger-until-exactly-one-outcome-says-so-merged-or-already-merged-takes-it-under-admission-refused-says-it-in-its-reason; stop-after-closing-work-deferred; after-commit-record-write-lock-release-or-exclusive-cleanup-failure-only-logged-outcome-stays-merged; later-failed-attempt-keeps-last-merge; legacy-user-kept-markers-do-not-block-convergence; request-kept-while-a-committed-merges-record-is-unwritten; committing-into-this-target-converged-first-whether-kept-or-requested; committing-into-another-target-never-overwritten-converged-by-its-marker-in-a-private-copy-of-that-target-under-its-maintenance-claim-restored-once-it-is-gone-deferred-while-in-use-or-unreadable; damaged-record-pauses-automatic-merges-until-requested-unknown-state-deferred-never-rewritten; older-selection-revisions-and-kept-markers-do-not-require-an-undecided-prompt; unfinished-work-of-skipped-conversations-neither-refuses-nor-is-finalized; one-merge-batch-per-process-at-a-time-fingerprint-copies-under-the-data-sets-maintenance-claim; partial-records-preserve-excluded-conversation-id-title-code-count-through-committing-and-lastMerged-actual-inserted-conversations-alone-enter-mergedInto; partial-and-residual-sources-never-deletable",
    "noticePolicy": "causes-accumulate-per-configuration-root; only-reevaluated-sources-drop-causes; explicit-request-outcome-always-shown; details-in-log-and-data-set-management; notices-and-log-state-interrupted-tasks-ended-queued-unsent-messages-cancelled-and-conversations-left-out; unreadable-source-shown-unreadable-never-as-changed; data-set-management-reads-other-data-sets-under-their-admission-and-maintenance-or-from-cache; deletion-refuses-unless-merged-into-current-with-matching-cached-file-state-and-identity-or-explicit-current-coverage-never-partial-or-residual; large-session-sources-deferred-awaiting-exclusive-unrecorded-and-never-told-as-deferred-with-a-pending-session-other-sources-above-the-online-limit-go-along-one-coordination-one-reload; automatic-batches-do-not-coordinate-exclusive-maintenance-or-start-countdowns-large-sources-remain-pending-until-explicit-merge-all; short-disk-space-never-prompts-states-the-missing-amount-once-per-cause-short-at-the-engines-start-told-after-the-reload-as-not-run; data-set-management-lists-large-session-with-count-and-rows-the-batch-measured-less-the-sources-an-estimate-settled-duration-only-once-estimated-and-labels-its-sources-large-waiting-with-rows-manual-start-cooldown-read-first-then-cancellable-read-only-estimate-then-modal-confirmation-with-rows-and-both-durations-then-cancellable-preparation-refused-while-the-window-is-frozen; sources-the-estimate-or-the-preparation-settled-told-as-a-batch-a-click-hears-nothing-yet-while-its-sources-go-on-to-the-session; requester-progress-notification-at-most-every-500ms-counting-source-rows-handled-with-the-engines-remaining-time-the-preparations-estimates-until-rows-streamed-1s-then-the-rate-of-streaming-alone-plus-the-fixed-part-per-source-still-to-start-cancellable-rolling-back-only-the-running-source; waiting-windows-shell-redrawn-per-source-and-5-percent-step-with-the-expected-end; outcome-kept-in-workspace-state-told-after-the-reload-within-10-minutes-per-source-conversations-in-details-named-by-the-candidate-lists-project-names-else-the-kind-of-history-with-the-same-dedup; coordination-not-done-no-reload-reason-told-once-per-cause-when-automatic",
    "sourceRetention": "conversation-content-unchanged; published-3-4-5-backed-up-and-upgraded-in-place; backup-before-finalization",
    "selectionPolicy": "never-switch",
    "historicalExecutionPolicy": "no-merged-conversation-resumes-in-any-host; source-host-registered-only-to-finalize",
    "convergencePolicy": "configuration-root-pending-records-have-no-expiry; convergence-registers-local-and-foreign-discovered-sources-and-relocation-left-behind-without-body-scan; residual-records-keep-location-reason-and-excluded-conversations; reset-backups-registered-residual-under-admission-and-reconciled-by-directory-enumeration-on-startup; residual-retry-explicitly-moves-the-source-back-to-pending; read-only-residual-list-and-open-folder-never-delete",
    "backgroundPolicy": "one-source-at-a-time; automatic-source-start-requires-requester-runtime-idle; foreign-automatic-source-120000ms-abort-budget-from-before-claim-acquisition; held-foreign-claim-refused-without-waiting-for-automatic-calls; cancellation-forwarded-to-private-copy-audit-and-body-read; release-claim-and-clear-timer-in-finally; timeout-deferred-and-kept-pending; explicit-request-not-subject-to-background-budget",
    "settlementConsentPolicy": "source-identity-and-counts-durable-before-source-backup-and-settlement; counts-turns-queued-intents-pending-deliveries-including-process-completions-and-undelivered-answers-child-executions-and-unreceipted-effects; displayed-counts-and-unknown-effect-outcome-explained; reuse-only-same-candidate-dataSetId-rootInstanceId-and-counts-not-increased; new-source-or-increased-counts-requires-confirmation; currently-confirmed-per-source-not-yet-a-batch-wide-confirmation"
  };
  if (!plainObject(merge) || JSON.stringify(Object.fromEntries(Object.entries(merge).filter(([key]) => key !== 'conversationOwnership'))) !== JSON.stringify(expectedMerge)) {
    failures.push('旧历史库只能在当前库打开后在线合并：来源离线，重活不持锁，全部检查通过才先备份再按现有终态收尾，每来源一个经 Repository 与 codec 的写事务，超过在线上限才在锁外协调独占兜底、超过内存单事务上限等大库会话的流式维护事务、超过流式硬上限记为太大，冲突按对话归属剔除、无归属或内容身份冲突拒绝整份，合并进来的对话不会被自动继续');
  }
  const ownershipSource = readText(path.join(root, 'backend/reliableKernel/runtimeMergeConversationOwnership.ts'));
  try {
    const literal = ownershipSource.match(/RUNTIME_MERGE_CONVERSATION_OWNERSHIP[^=]*= (\{[\s\S]*?\n\});/)[1];
    const ownership = JSON.parse(literal.replace(/([\{,]\s*)([A-Za-z][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/'([^']*)'/g, (_, value) => JSON.stringify(value)).replace(/,\s*([}\]])/g, '$1'));
    if (JSON.stringify(merge.conversationOwnership) !== JSON.stringify(ownership)) failures.push('对话归属路径必须与实现一致');
    const keys = ['Core', 'Execution', 'Context', 'Collaboration', 'CollaborationBoard', 'Timeline'].flatMap((name) =>
      [...readText(path.join(root, `backend/reliableKernel/schema/domains${name}.ts`)).matchAll(/key:\s*'([^']+)'/g)].map((match) => match[1]));
    failures.push(...exactSetProblems('对话归属领域覆盖', keys, Object.keys(ownership)));
  } catch (error) { failures.push(`对话归属合同无法解析：${error.message}`); }
  const expectedHistoricalRepair = {
    "entry": "history-and-storage-management-explicit-inspect-then-confirm-never-merge-fallback",
    "scope": "only-current-epoch-local-offline-data-set-exact-binding-and-schema-no-pending-recovery-or-committing-merge-no-shared-inode-or-links; selected-library-coordinated-exclusive-maintenance-closes-requester-runtime-before-inspection-and-reloads-afterward-without-selection-change",
    "inspection": "private-snapshot-worker-read-only-full-content-and-protected-history-digests-bounded-samples-no-backup-no-runtime-no-dispatch",
    "repair": "only-complete-terminal-orphan-model-operations-and-attempts-without-retained-effect-or-pause-dependency; only-exited-process-backed-by-matching-unknown-receipt-restored-to-unknown; any-unsafe-record-refuses-whole-repair",
    "durability": "backup-api-verified-digest-fsynced-database-and-directories-prepared-journal-before-fixed-maintenance-worker-full-transaction; content-fence-and-protected-row-digest-and-integrity-checked-in-transaction; unique-plan-bound-command-receipt-proves-commit-before-completed-journal",
    "recovery": "same-plan-reentry-and-readonly-inspection-prove-commit-from-receipt-not-journal; keep-backup-before-mutation-and-after-crash; no-automatic-backup-pruning-no-source-task-execution-no-merge-ledger-deletion"
  };
  if (JSON.stringify(migration.historicalRepair) !== JSON.stringify(expectedHistoricalRepair)) {
    failures.push('历史残留修复必须是显式、离线、精确范围、先备份后以专属回执证明提交的独立操作，不能做成合库静默兜底');
  }
  const repositoriesSource = readText(path.join(root, 'backend/reliableKernel/repositories.ts'));
  const historicalCopyDomains = /HISTORICAL_COPY_DOMAINS: readonly string\[\] = \[([^\]]*)\]/.exec(repositoriesSource)?.[1]
    ?.split(',').map((item) => item.trim().replace(/^'|'$/g, '')).filter(Boolean) ?? [];
  if (JSON.stringify(historicalCopyDomains) !== JSON.stringify(expectedMerge.historicalCopyDomains)) {
    failures.push('历史复制插入领域必须与 migration.json#historicalMerge.historicalCopyDomains 完全一致');
  }
  const selectionSource = readText(path.join(root, 'backend/reliableKernel/vscodeRootAuthority.ts'));
  if (!selectionSource.includes("if (previous) throw new VscodeRuntimeDataSetError('当前历史库已经固定")) failures.push('当前历史库选择只允许首次发布');
  const mergeSource = readText(path.join(root, 'backend/reliableKernel/runtimeDataSetMerge.ts'));
  const convergenceSource = readText(path.join(root, 'backend/reliableKernel/runtimeHistoryConvergence.ts'));
  const settlementSource = readText(path.join(root, 'backend/application/reliableKernel/historicalMergeSettlement.ts'));
  if (!mergeSource.includes('options.isRuntimeIdle && !await options.isRuntimeIdle()')
    || !mergeSource.includes('runtime-data-set-merge-background-timeout') || !mergeSource.includes('120_000)')
    || !mergeSource.includes('await hold.release();')
    || !convergenceSource.includes('(source.deliveries ?? 0) >= (input.deliveries ?? 0)')
    || !convergenceSource.includes('(source.children ?? 0) >= (input.children ?? 0)')
    || !convergenceSource.includes('(source.effects ?? 0) >= (input.effects ?? 0)')
    || !settlementSource.includes('ReliableKernelApplication.open(authority, SETTLING_ONLY)')
    || !settlementSource.includes('await application.database.durabilityCheckpoint();')) {
    failures.push('后台合并须检查空闲与外来来源预算；收尾同意计数须包含投递、子 Agent 和已派发效果，离线收尾须禁止执行并持久化');
  }
  const mergeConstant = (pattern) => pattern.exec(mergeSource)?.slice(1).map((value) => Number(value.replaceAll('_', ''))) ?? [];
  const [onlineRows, onlineMiB] = mergeConstant(/RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS = Object\.freeze\(\{ maxRows: ([\d_]+), maxBytes: ([\d_]+) \* 1024 \* 1024 \}\)/);
  const [transactionRows] = mergeConstant(/RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS = ([\d_]+);/);
  const [streamedRows] = mergeConstant(/RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS = ([\d_]+);/);
  const [chunkRows] = mergeConstant(/const READ_CHUNK = ([\d_]+);/);
  const [evidenceRows] = mergeConstant(/RUNTIME_DATA_SET_MERGE_COMMIT_EVIDENCE_ROWS = ([\d_]+);/);
  const [evidencePerEnd] = mergeConstant(/const EVIDENCE_PER_END = ([\d_]+);/);
  const streamedSource = readText(path.join(root, 'backend/reliableKernel/runtimeDataSetStreamedMerge.ts'));
  const ledgerSource = readText(path.join(root, 'backend/reliableKernel/runtimeDataSetMergeLedger.ts'));
  const [heartbeatMs] = /const PREPARATION_HEARTBEAT_MS = ([\d_]+);/.exec(streamedSource)?.slice(1).map((value) => Number(value.replaceAll('_', ''))) ?? [];
  const [staleMs] = /RUNTIME_DATA_SET_MERGE_PREPARATION_STALE_MS = ([\d_]+);/.exec(ledgerSource)?.slice(1).map((value) => Number(value.replaceAll('_', ''))) ?? [];
  const streamedChunk = /RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS: number = engine\.READ_CHUNK;/.test(streamedSource);
  const [backupRetention] = mergeConstant(/RUNTIME_DATA_SET_MERGE_BACKUP_RETENTION = ([\d_]+);/);
  const [backupMarginMiB] = mergeConstant(/BACKUP_FREE_SPACE_MARGIN_BYTES = ([\d_]+) \* 1024 \* 1024;/);
  if (!expectedMerge.sizeLimit.startsWith(`online-transaction-at-most-${onlineRows}-source-rows-and-${onlineMiB}MiB-`)
    || !expectedMerge.sizeLimit.includes(`; in-memory-transaction-limit-${transactionRows}-source-rows-`)
    || !expectedMerge.sizeLimit.includes(`; streamed-transaction-hard-limit-${streamedRows}-source-rows-`)
    || !streamedChunk || !expectedMerge.writePath.includes(`-appended-in-chunks-of-${chunkRows}-source-rows-`)
    || !expectedMerge.recordPolicy.includes(`-plus-first-and-last-${evidencePerEnd}-rows-`)
    || !expectedMerge.recordPolicy.includes(`-to-keep-within-${evidenceRows}-rows-`)
    || !expectedMerge.exclusivity.includes(`-preparing-record-heartbeat-${heartbeatMs / 1000}s-taken-over-after-${staleMs / 1000}s-`)
    || !expectedMerge.recordPolicy.includes('; pending-registration-without-expiry-')
    || !expectedMerge.backupPolicy.includes(`; used-then-newest-${backupRetention}-by-creation-`)
    || !expectedMerge.backupPolicy.includes(`-database-plus-wal-plus-${backupMarginMiB}MiB-`)) {
    failures.push('migration.json#historicalMerge 的在线上限、内存单事务上限、流式硬上限、流式每块行数、提交证据上限与首末条数、准备记录心跳与接手时限、无期限待合并登记、备份保留份数与备份前剩余空间余量必须与代码常量一致');
  }
  const casTransferSource = readText(path.join(root, 'backend/reliableKernel/runtimeCasTransfer.ts'));
  if (!expectedMerge.foreignSourcePolicy.includes(`-free-space-for-missing-objects-plus-${backupMarginMiB}MiB-`)
    || !/if \(options\.sourceObjects && !options\.verifyOnly\) \{\s+await assertRoomForObjects\(/.test(mergeSource)
    || !mergeSource.includes('if (await transfer.needsCopy(object)) missing += object.byte_length;')
    || !casTransferSource.includes('if (await this.targetPackedLength(object) !== undefined) return false;')
    || !casTransferSource.includes('lstatSync(looseCasObjectLocation(this.targetCas, object).absolutePath, { throwIfNoEntry: false }) === undefined')
    || !mergeSource.includes('await casTransferPackedStorageBytes(sourceCas)')
    || !mergeSource.includes('const needed = Number(missing) + packedBytes + BACKUP_FREE_SPACE_MARGIN_BYTES;')) {
    failures.push('migration.json#historicalMerge.foreignSourcePolicy 的外来正文复制前空间余量必须与代码常量一致，且复制前先按缺失对象总量加余量查空间');
  }
  const [unmeasuredLow, unmeasuredHigh] = /RUNTIME_DATA_SET_LARGE_MERGE_UNMEASURED_RANGE = Object\.freeze\(\{ low: ([\d.]+), high: ([\d.]+) \}\)/
    .exec(streamedSource)?.slice(1).map(Number) ?? [];
  const [measuredLow, measuredHigh] = /RUNTIME_DATA_SET_LARGE_MERGE_MEASURED_RATE_BOUNDS = Object\.freeze\(\{ low: ([\d.]+), high: ([\d.]+) \}\)/
    .exec(streamedSource)?.slice(1).map(Number) ?? [];
  const casCacheSource = readText(path.join(root, 'backend/reliableKernel/runtimeCasVerificationCache.ts'));
  const casCacheFile = /const CACHE_FILE = '([^']+)';/.exec(casCacheSource)?.[1] ?? '';
  const [casCacheDays] = /const MAX_AGE_MS = ([\d_]+) \* 24 \* 60 \* 60 \* 1000;/.exec(casCacheSource)?.slice(1).map((value) => Number(value.replaceAll('_', ''))) ?? [];
  const guardSource = readText(path.join(root, 'backend/capabilities/filesystem/sqliteDatabaseFileGuard.ts'));
  const limcodeDatabaseName = /const LIMCODE_DATABASE_FILE_NAME = \/(.+)\/;/.exec(guardSource)?.[1];
  const ownDatabaseName = limcodeDatabaseName !== undefined && ['', '-wal', '-shm'].every((suffix) => new RegExp(limcodeDatabaseName).test(`${casCacheFile}${suffix}`));
  if (!expectedMerge.exclusivity.includes(`-within-${measuredLow}x-to-${measuredHigh}x-range-${unmeasuredLow}x-to-${unmeasuredHigh}x;`)
    || !expectedMerge.casPolicy.includes(`-unconfirmed-dropped-after-${casCacheDays}-days`)
    || !ownDatabaseName) {
    failures.push('migration.json#historicalMerge 的只读估计范围、实测速率的换算上下限与正文核验缓存的保留天数必须与代码常量一致；正文核验缓存必须用 LimCode 自己的数据库名（进程内文件工具不会打开它）');
  }
  const spaceSource = readText(path.join(root, 'backend/reliableKernel/runtimeDataSetLargeMergeSpace.ts'));
  const [walPeak] = /export const LARGE_MERGE_WAL_PEAK_FACTOR = ([\d.]+);/.exec(spaceSource)?.slice(1).map(Number) ?? [];
  const [indexShare] = /export const LARGE_MERGE_TARGET_INDEX_SHARE = ([\d.]+);/.exec(spaceSource)?.slice(1).map(Number) ?? [];
  const [skipChunks] = /const SKIP_SEGMENT_CHUNKS = ([\d_]+);/.exec(streamedSource)?.slice(1).map((value) => Number(value.replaceAll('_', ''))) ?? [];
  const [backupStaleHours] = /RUNTIME_LARGE_MERGE_TARGET_BACKUP_STALE_MS = ([\d_]+) \* 60 \* 60 \* 1000;/.exec(ledgerSource)?.slice(1).map((value) => Number(value.replaceAll('_', ''))) ?? [];
  const [memoryEntries] = /const MEMORY_ENTRIES = ([\d_]+);/.exec(casCacheSource)?.slice(1).map((value) => Number(value.replaceAll('_', ''))) ?? [];
  const [sqliteShare] = /export const LARGE_MERGE_SQLITE_TEMPORARY_SHARE = ([\d.]+);/.exec(spaceSource)?.slice(1).map(Number) ?? [];
  const [rateStreamMs] = /const SESSION_RATE_MIN_STREAM_MS = ([\d_]+);/.exec(streamedSource)?.slice(1).map((value) => Number(value.replaceAll('_', ''))) ?? [];
  if (!expectedMerge.exclusivity.includes(`-plus-${walPeak}x-the-largest-plus-target-index-pages-measured-in-a-worker-on-the-preparations-backup-else-${indexShare}x-the-target-files-plus-${indexShare}x-the-other-sources-plus-${backupMarginMiB}MiB;`)
    || !expectedMerge.exclusivity.includes(`; large-session-sqlite-temporary-files-${sqliteShare}x-the-largest-source-`)
    || !expectedMerge.noticePolicy.includes(`-the-preparations-estimates-until-rows-streamed-${rateStreamMs / 1000}s-then-the-rate-of-streaming-alone-`)
    || !expectedMerge.exclusivity.includes(`-statfs-under-${backupMarginMiB}MiB-left-rolled-back-early-`)
    || !expectedMerge.writePath.includes(`-rowid-segments-of-${skipChunks}-read-chunks-`)
    || !expectedMerge.backupPolicy.includes(`-or-after-${backupStaleHours}h-`)
    || !expectedMerge.casPolicy.includes(`-keeps-at-most-${memoryEntries}-identities-in-memory-`)) {
    failures.push('migration.json#historicalMerge 的大库会话空间模型（WAL 倍数、索引页比例、数据库临时文件比例、余量）、剩余时间改按速率之前的写入时长、跳过闭包每段的读取块数、目标备份登记的过期时限与正文核验缓存的内存上限必须与代码常量一致');
  }
  const largeSessionSource = readText(path.join(root, 'backend/reliableKernel/runtimeLargeMergeSession.ts'));
  const largeSessionConstant = (name) => Number(new RegExp(`${name}: ([\\d_.]+)[,\\n]`).exec(largeSessionSource)?.[1]?.replaceAll('_', ''));
  const [largeMarginMiB] = /freeSpaceMarginBytes: ([\d_]+) \* 1024 \* 1024,/.exec(largeSessionSource)?.slice(1).map((value) => Number(value.replaceAll('_', ''))) ?? [];
  const largeResultMinutes = Number(/resultTtlMs: ([\d_]+) \* 60_000/.exec(largeSessionSource)?.[1]);
  if (!expectedMerge.noticePolicy.includes(`; requester-progress-notification-at-most-every-${largeSessionConstant('progressIntervalMs')}ms-`)
    || !expectedMerge.noticePolicy.includes(`-per-source-and-${largeSessionConstant('stageStepPercent')}-percent-step-`)
    || !expectedMerge.noticePolicy.includes(`-told-after-the-reload-within-${largeResultMinutes}-minutes-`)
    || !expectedMerge.exclusivity.includes(`-temporary-disk-temporary-bytes-plus-${largeMarginMiB}MiB-only-on-a-disk-of-its-own-`)) {
    failures.push('migration.json#historicalMerge 的大库会话进度节流间隔、阶段步长、结果有效期与临时目录的空间余量必须与 runtimeLargeMergeSession.ts 的常量一致');
  }
  const exclusive = migration?.exclusiveMaintenance;
  const expectedExclusive = {
    location: 'target-control-root/exclusive-maintenance',
    uses: 'user-requested-data-root-migration; oversized-historical-merge-fallback; large-historical-merge-session; offline-gc; never-epoch-upgrade',
    request: 'one-file-per-requester-with-operation-key-user-message-and-activity; heartbeat-2s-refreshed-while-operation-runs-ignored-after-15s; marked-withdrawn-before-removal',
    protocol: 'prepare-each-host-answers-ready-busy-or-declined; confirm-only-when-all-ready; go-only-when-all-confirmed; no-host-yields-before-go; new-round-per-locked-attempt',
    participation: 'host-registers-after-runtime-ready; registration-grace-equals-prepare-timeout; unregistered-live-host-after-grace-or-unknown-host-abandons; host-registers-as-opening-right-after-its-runtime-opened-busy-until-its-participant-answers-outside-after-2m; start-identities-compared-only-when-both-registration-and-liveness-have-one; closing-or-reloading-host-marks-registration-leaving-and-unregisters-after-runtime-closed; leaving-or-answered-then-unregistered-host-absent-waited-for-until-liveness-gone-30s-then-timed-out; no-go-when-only-leaving-hosts-remain',
    busyPolicy: 'abandon-at-once-by-default; wait-bounded-only-outside-locks-with-advance-notice-per-reason; busy-again-before-go-releases-locks-and-waits-outside-at-most-3-locked-attempts; busy-after-go-published-ends-the-call-as-coordinated-before-that-waits-outside; abandon-reason-from-last-actual-busy-requester-other-work-or-focus-requester-alone-worded-without-other-windows',
    concurrentRequesters: 'window-with-running-request-answers-busy-and-never-yields; later-request-gives-way-to-earlier-one-that-waits-or-is-past-prepare-by-created-at-then-request-id-naming-this-windows-own-earlier-request-as-such; window-giving-way-holds-its-confirm-and-go-answers-until-own-request-ended; explicit-call-reason-kept-across-reload-only-when-this-window-yields-to-the-request-it-gave-way-to-valid-when-reopened-within-10-minutes-waiting-for-that-maintenance-not-counted; same-operation-key-later-request-gives-way-at-once-as-superseded-without-notice-or-backoff-and-the-earlier-waits-for-that-window-instead-of-counting-it-busy-unless-only-the-later-waits-while-the-earlier-abandons-on-busy-still-in-prepare-then-neither-gives-way-and-the-earlier-counts-it-busy; busy-answer-for-its-own-request-names-that-work-and-other-maintenance-is-worded-apart',
    lockHold: 'admission-and-maintenance-only-for-locked-round-prepare-8s-confirm-20s-release-30s-then-operation; never-while-waiting-for-busy-windows',
    peerBehavior: 'busy-work-while-write-command-in-flight-frozen-or-not-or-lease-pinned-or-pending-conversation-work-or-own-request-running-or-own-operation-held-from-user-consent-through-its-preparation; busy-focus-while-focused-except-past-prepare-of-final-countdown-or-notice; 5s-cancellable-countdown-or-final-countdown-without-cancel-or-notice; countdown-polls-request-and-closes-with-a-no-reload-notice-once-withdrawn-silently-once-it-moved-to-a-new-round; notice-and-advance-wait-notice-told-once-per-request-whatever-round-and-followed-by-one-no-reload-notice-once-withdrawn-without-this-window-reloading; go-stage-busy-never-reloads-that-round; go-rechecks-request-before-reload; reload-with-unsent-composer-in-webview-state-written-at-once-when-confirmation-starts-and-before-reload-with-250ms-to-land-and-on-pagehide',
    goAbandonCost: 'each-window-reloads-at-most-once-per-call; busy-at-go-abandons-the-call; windows-already-reloaded-wait-on-admission-then-reopen-with-unsent-input-kept; per-operation-10m-cooldown-whatever-the-key-holds-off-automatic-calls-and-explicit-calls-without-the-requester-token; requester-token-per-operation-kept-in-workspace-state-until-completed-lets-the-requesting-window-retry-after-its-reload-on-any-target; reason-states-when-to-retry',
    requesterSelf: 'skipped-by-requester-host-boot-id-else-requester-process; requester-busy-callback-counts-like-another-window-while-preparing-confirming-yielding-and-right-before-operation-write-commands-in-flight-included-so-it-waits-outside-the-locks; before-go-hook-after-all-confirmed-checks-first-then-freezes-with-infallible-steps-busy-or-throw-returns-outside-or-abandons-before-any-reload-thawed-when-round-ends; requester-closes-own-runtime-inside-operation',
    activityMarker: 'holder-publishes-operation-description-stage-and-start-inside-each-held-claim-bound-to-claim-token; operation-may-add-an-expected-end-an-unreadable-one-dropped-alone; refreshed-every-2s-during-locked-round-and-operation; stale-after-15s-reported-never-taken-over; gone-with-the-claim; published-by-exclusive-maintenance-old-data-set-upgrade-merge-source-finalization-and-backup-cleanup',
    reloadedHostBehavior: 'wait-on-configuration-admission-until-maintenance-ends-then-reread-data-root; after-1s-notification-shows-holder-activity-and-elapsed-shell-shows-it-without-seconds-redrawn-on-stage-change-neutral-without-marker; notification-and-shell-status-settled-once-a-claim-is-taken-before-the-runtime-opens-later-waits-shown-anew; wait-and-warnings-timed-from-current-holder-claim-token; poll-50ms-then-250ms-after-2s-then-1s-after-10s-restarted-per-holder; warning-offers-keep-waiting-or-close-window-after-long-hold-or-stale-heartbeat-answered-after-open-explained; expected-end-shown-then-said-slower-than-expected; with-fresh-heartbeat-long-hold-warning-postponed-until-running-1.5x-the-expected-duration-never-before-10m-stale-heartbeat-warned-at-once; never-opens-past-the-lock',
    backoff: 'per-operation-key-exponential-5m-to-6h-after-abandon-or-failure-after-go; deterministic-failure-blocks-key-for-automatic-calls-only; explicit-call-runs-blocked-key-and-success-clears-it; clear-key-api; key-carries-identity-that-changes-once-fixed; per-operation-10m-cooldown-after-go; ignore-backoff-explicit-per-call-skips-key-backoff; success-resets-key; read-only-refusal-query-answers-what-a-call-would-meet-cooldown-backoff-block-or-a-window-outside-the-protocol-by-the-same-rules-writing-nothing',
    waitBound: 'prepare-8s-busy-wait-10m-confirm-20s-release-30s-monotonic; cancellable-only-before-go-and-not-at-all-when-the-caller-passes-cancellable-false-as-data-root-commands-do; outcome-completed-busy-declined-legacy-host-timed-out-cancelled-backoff-blocked-or-superseded-with-reason; failure-after-go-rethrown',
    processProbe: 'platform-identity-once-per-pid-and-start-identity-then-kill-0; unknown-probe-result-kept-5s-then-probed-again; registration-kill-0-only; final-decision-uncached',
    cleanup: 'crashed-requester-requests-and-responses-swept-by-next-request; answers-removed-only-without-request-in-listings-before-and-after-and-unwritten-15s; cleanup-failure-logged-never-replaces-outcome; eperm-retried',
    exclusivityProof: 'host-liveness-records-only; request-advisory'
  };
  const openingWaitSource = readText(path.join(root, 'vscode/runtimeOpeningWait.ts'));
  const [maintenanceWarnMinutes] = /maintenanceWarnMs: ([\d_]+) \* 60_000,/.exec(openingWaitSource)?.slice(1).map((value) => Number(value.replaceAll('_', ''))) ?? [];
  const [expectedEndStretch] = /expectedEndStretch: ([\d.]+),/.exec(openingWaitSource)?.slice(1).map(Number) ?? [];
  if (!expectedExclusive.reloadedHostBehavior.includes(`-postponed-until-running-${expectedEndStretch}x-the-expected-duration-never-before-${maintenanceWarnMinutes}m-`)) {
    failures.push('migration.json#exclusiveMaintenance.reloadedHostBehavior 的维护告警时间与按预计结束时间推迟的倍数必须与 runtimeOpeningWait.ts 的常量一致');
  }
  if (!plainObject(exclusive) || JSON.stringify(Object.keys(exclusive).sort()) !== JSON.stringify(Object.keys(expectedExclusive).sort())
    || Object.entries(expectedExclusive).some(([key, value]) => exclusive[key] !== value)) {
    failures.push('多窗口独占维护必须分阶段协调：全部窗口就绪才确认、全部确认才让出，go 之后遇忙本次结束；两个请求方不互等；等待忙窗口只在锁外，锁内轮次有时限；放弃与让出后失败按操作键退避、确定性失败只拦自动调用、按操作冷却；持锁方发布带心跳的维护进行中标记，等待打开的窗口说明原因且绝不越过锁；独占仍以 Host liveness 证明');
  }
  const relocation = migration?.dataRootRelocation;
  const expectedRelocation = {
    entry: 'settings-page-button; command-palette-opens-settings-page; native-folder-picker-only; confirm-panel-prompts-with-complete-lists; read-only-plan',
    preflight: 'absolute-path; writable-target-and-parent; per-disk-space-by-file-sizes-first-new-2x-database-plus-cas-by-target-cluster-when-copied-or-fat-exfat-temp-1x-old-1x-short-space-refused-before-counting; not-inside-or-above-current-root; cloud-sync-folder-warning; existing-limcode-target-current-rows-counted-on-the-windows-read-connection-without-a-copy-above-merge-one-transaction-hard-limit-refused-before-any-coordination; fresh-root-batched-copy-unbounded-rows-not-counted; other-data-sets-with-an-online-host-left-behind-with-the-reason; merge-bookkeeping-of-the-old-directory-and-an-existing-target-readable-and-consistent-else-refused-with-the-reason; a-merge-into-a-data-set-that-moves-still-committing-and-finishable-in-the-old-directory-refused-it-finishes-there-at-the-next-open-first',
    targetStates: 'missing-or-empty-fresh-root-the-extensions-own-pointer-file-ignored; user-files-including-settings-record-stores-alone-only-a-new-limcode-subfolder; limcode-runtime-with-a-selected-current-data-set-created-at-this-path-merge-into-it-when-offline; copied-from-elsewhere-alone-and-offline-renamed-aside-whole-under-the-relocation-id-never-deleted-or-merged-automatically-registered-in-place-as-read-only-foreign-history-then-fresh-root; copied-mixed-with-user-files-only-a-new-limcode-subfolder; anything-else-refused',
    phases: 'pending-record-in-pointer-compare-and-set; online-staging-record-journal-fresh-root-and-cas-precopy-via-backup-api; target-anchor-recorded-in-the-pending-record-before-the-first-target-change; preparation-cancellable-coordination-and-exclusive-phase-not; exclusive-maintenance-final-countdown-waiting-outside-locks-requester-work-counted; before-go-confirms-idle-then-freezes-the-window-refusing-write-commands-at-entry-until-the-operation-ends-only-work-from-before-counts-only-conversations-owned-at-the-freeze-claimed-for-execution; stages-reported-to-waiting-windows-undo-included; attempt-coordination-key-cleared-afterwards; requester-closes-runtime; source-fingerprints; configuration; receiving-database-undo-copy-with-its-fingerprint; merge-engine-migration-mode; merge-inserted-rows-including-local-handle-authority-and-timeline-provenance-and-exact-handle-update-before-after-images-journaled-before-commit; received-fingerprint-journaled; debug-captures-copied-with-their-data-set; other-data-sets; merge-bookkeeping-after-the-merges-deletion-records-and-ledger-carried-an-existing-targets-kept-and-joined-per-source-identity-continuations-of-each-changed-identity-expanded-merge-requests-and-finalization-notes-of-the-data-sets-that-move-rewritten-to-their-new-identities-foreign-root-requests-to-where-the-target-finds-them-a-newer-target-request-kept-journaled-then-verified; completion-record-naming-the-initiating-installation; moved-notice-in-old-directory-with-the-unfinished-work-of-each-data-set-that-moved-listed-from-its-private-snapshot-written-durably-before-the-pointer-switch-under-the-same-admission-an-earlier-notice-kept-for-the-undo-and-inside-it-a-failed-write-undoes-the-relocation; conversations-the-merge-left-out-not-listed-as-carried; switching-recorded-durably-in-the-target-right-before-the-pointer-switch-never-offered-for-undo-to-other-installations; pointer-switch-last-with-identity-and-relocation-id; a-moved-notice-of-the-target-removed-only-when-it-guards-no-unsettled-work-else-kept-and-warned-in-the-plan; record-confirmed-published-by-the-initiating-installation; every-window-reloads',
    mergeMode: 'selected-source-allowed; no-merge-ledger-written; leaves-out-conversations-the-target-or-an-identity-it-continues-recorded-as-deleted-absent-from-it; unfinished-work-carried-unchanged; streaming-model-request-or-running-process-refused; snapshot-integrity-and-probes-in-worker',
    otherDataSets: 'same-id-independent-data-sets-registered-pending-merge-without-expiry; merged-and-unchanged-carried-by-current; work-an-earlier-relocation-carried-away-and-not-settled-here-listed-in-the-plan-by-project-and-never-moved-again-settled-first-in-the-exclusive-phase-before-the-target-changes-as-at-an-open-with-convergence-held-and-nothing-executable-when-chosen-at-confirmation-which-is-the-consent-to-exactly-what-it-named-else-refused-and-undone; in-use-by-an-online-host-too-large-failed-taken-or-unreadable-stay-in-old-directory-recorded-pending-in-new-configuration-root-with-located-old-control-root-and-shown-with-what-to-do; exclusive-offline-assertion-only-for-the-current-and-migrating-data-sets; carry-pending-residual-settlement-consent-and-convergence-with-the-relocation-journal',
    configuration: 'registered-directories-files-global-rules-and-skills; top-level-symbolic-links-copied-as-links-same-rule-for-plan-and-copy; record-stores-at-any-depth-merged-by-id-current-wins; replaced-versions-copied-to-relocation-backups-then-atomic-replace; journal-before-every-change; sha256-verified-and-fsynced',
    failure: 'pointer-unchanged; any-failure-after-the-pointer-switch-never-undoes-the-pointer-is-read-again-and-naming-this-relocation-is-success-with-the-finishing-error-reported; a-complete-record-is-undone-only-when-the-caller-proves-the-pointer-did-not-switch-published-or-finalized-never; undo-first-checks-the-receiving-data-set-against-its-fingerprints-before-and-after-the-relocation-and-before-plus-the-journaled-inserted-rows-and-exact-handle-updates-after-images-checked-before-restoring-before-images-no-derived-tables-ignored-and-when-changed-since-touches-nothing-marks-the-record-held-and-names-the-backups; receiving-data-set-unreadable-undo-not-attempted-record-unchanged-tried-again-later; half-restored-database-judged-by-the-undo-copys-file-stamps; no-database-restore-while-a-host-has-the-target-open-also-right-after-the-failure; complete-record-marked-undoing-before-any-undo-step-and-an-undoing-record-always-continued-staging-marked-best-effort-so-others-see-a-failed-relocation-being-undone-a-full-disk-retried-after-each-step; the-undo-and-every-continued-undo-removes-its-own-moved-notice-and-puts-back-the-earlier-one-or-stops-for-the-next-attempt; disk-full-undo-deletes-first-and-names-what-can-be-deleted-by-hand; journal-undo-restores-receiving-database-idempotently-and-replaced-configuration-removes-created-entries-and-the-objects-added-to-the-receiving-cas-listed-before-the-precopy; copied-data-renamed-back-or-its-location-reported-and-found-again-by-relocation-id-when-the-record-is-gone; no-record-found-counts-as-undone-only-while-the-target-anchor-matches-otherwise-unreachable-and-kept-the-user-may-forget-the-record-after-confirmation; not-undone-reported-and-pending-record-kept-own-window-retries-it-first; startup-announces-migrating-only-while-the-owner-lives-and-the-target-record-is-in-progress-an-undo-under-way-or-unfinished-is-said-as-such-in-startup-command-open-return-and-plan(relocation-undoing); crash-undone-at-next-startup-from-pending-record; unswitched-completion-redone-while-receiving-unchanged-by-the-initiating-installation-only; abandoned-private-copies-swept; old-directory-data-never-modified',
    oldDirectory: 'kept; pointer-relocation-id-must-match-the-completion-record-switches-without-copying-never-justify-deletion; delete-only-what-the-completion-record-proves-migrated-and-unchanged-by-fingerprint-and-digest; a-data-set-whose-migration-left-out-conversations-the-target-had-deleted-kept-they-exist-only-there; a-data-sets-content-that-did-not-move-listed-as-unmigrated-deleted-only-when-ticked; backups-and-archives-only-when-ticked-with-sizes; each-archive-removed-only-under-the-foreign-claims-the-current-directory-takes-on-it-without-waiting-and-with-no-view-registered-else-kept-and-told-in-use; all-hosts-offline; confirmed-list-must-still-match; moved-notice-kept-when-deleting; return-switches-pointer-invalidates-the-record-and-clears-its-own-moved-notice-after-recording-there-what-was-deleted-here-under-an-identity-continuing-one-of-it-through-that-relocation-else-no-switch; other-installations-warned-without-blocking-and-offered-the-new-directory-also-when-it-is-unavailable',
    unavailableRoot: 'identity-file-matched-against-pointer-else-limcode-structure-selection-identity-or-root-binding; identity-recorded-on-first-normal-open-inside-admission; unfinished-relocation-settled-inside-admission-before-open-undone-when-its-process-is-gone-refused-otherwise; unconfirmed-completion-confirmed-and-finalized-only-by-the-initiating-installation-whose-pointer-names-it-others-refused-while-its-process-lives-and-asked-once-it-is-gone; carried-work-of-an-old-directory-refuses-the-open-until-the-user-continues-here-uses-the-new-directory-or-keeps-it-closed-the-prompt-says-all-of-it-is-settled-before-anything-runs-and-what-cannot-be-keeps-it-closed-return-by-the-initiating-installation-is-consent-its-notice-missing-unreadable-or-not-understood-refuses-the-return-as-does-a-consent-that-cannot-be-recorded; a-moved-notice-that-cannot-be-understood-refuses-the-open(moved-notice-invalid)-never-taken-for-none; a-notice-whose-relocation-is-still-under-way-with-its-process-not-proven-gone-refuses-as-relocating; consented-carried-work-settled-right-after-the-runtime-opens-with-convergence-recovery-and-takeover-held-released-only-once-all-of-it-is-settled-recorded-once-continued-after-a-crash; settled-with-user-stop-transitions-and-abandon-transitions-reason-data-root-relocated(pending-results-that-would-open-a-turn-failed-their-wakes-and-process-completion-dispatches-dead-lettered-a-runtime-continuation-queued-for-them-cancelled-unrouted-child-answers-given-a-failed-delivery-without-a-wake-queued-non-message-intents-cancelled-detached-background-children-stopped-then-their-queued-continuation-cancelled-with-the-subtree); a-target-conversation-another-live-host-holds-a-claim-a-live-host-holds-unexpired-or-a-still-active-target-turn-left-to-that-host-as-live-a-dead-hosts-hold-or-claim-is-stale-and-given-up; settled-in-rounds-collaboration-converged-and-the-whole-data-set-inventoried-again-in-the-runtime-after-each-round-tried-3-times-at-most-5-rounds; anything-left-live-failed-including-an-unexpected-settlement-error-needs-human-or-rounds-exhausted-keeps-it-consented-recorded-item-by-item-in-the-notice-closes-the-runtime-unreleased-and-fails-the-open(moved-work-unsettled)-with-a-prompt-naming-each-item-why-and-what-to-do-retry-or-the-new-directory-the-next-open-settles-the-whole-data-set-again; relocating-relocation-undoing-and-transient-read-errors-offer-retry-only-other-read-errors-and-invalid-moved-notices-also-other-directories; only-enoent-and-enotdir-count-as-missing; missing-mismatched-or-empty-refuses-startup-with-retry-return-choose-other-or-default-after-second-confirmation; never-creates-an-empty-root; reads-of-file-and-record-store-settings-never-create-directories-missing-equals-defaults-on-first-save; the-moved-notice-of-this-installations-own-unswitched-relocation-not-taken-as-moved-giving-its-record-up-removes-that-notice-first-putting-back-the-one-it-replaced; a-target-record-that-cannot-be-read-refuses-as-unreadable'
  };
  if (!plainObject(relocation) || JSON.stringify(relocation) !== JSON.stringify(expectedRelocation)) {
    failures.push('数据目录迁移只能复制核对后最后切换指针：在线预复制、锁外等待后独占阶段经合并引擎迁移模式写入、每步先记日志、失败或崩溃按日志撤销、删除旧目录只删按指纹证明已迁移且未改动的内容，不可用（身份不符）的数据目录绝不新建空库');
  }
  const cleanup = migration?.backupCleanup;
  const expectedCleanup = {
    "entry": "settings-page-other-data-root-button; data-set-management-and-command-palette-only-open-the-settings-page; progress-notification-while-checking; check-and-deletion-are-write-commands-counted-in-the-freeze-baseline; refused-like-a-write-command-while-this-window-is-frozen-for-a-data-root-operation-at-entry-and-again-before-deleting; a-check-or-deletion-failing-as-a-whole-told-in-words-its-technical-cause-only-in-the-log",
    "deletableKinds": [
      "epoch-migration-backups",
      "merge-backups",
      "merge-source-backups"
    ],
    "listedOnly": "copied-directory-as-a-whole-with-its-settings-rules-and-skills; archives-directory-entries-that-are-no-archive; foreign-history-that-failed-or-cannot-be-verified-now; control-root-legacy-backups; limcode-data-backups; name-location-size-and-reason-never-deleted; new-reset-backups-under-.limcode-runtime-reset-backups-never-deleted",
    "foreignHistory": "archives-of-every-scope-of-the-current-and-the-left-data-directories-and-data-sets-of-copied-directories-beside-any-of-them-as-discovered-and-verified-by-runtime-foreign-history; only-verified-ones; deletion-unit-the-located-control-root-a-whole-archive-or-one-data-set-of-a-copied-directory-never-the-copied-directory-told-when-no-data-set-is-left; proven-by-same-identity-and-content-digest-as-a-local-data-set-other-than-the-open-one-its-ids-read-from-the-same-files-as-its-digest-and-every-body-in-its-cas-or-by-coverage-of-it-and-of-its-kept-backups-in-one-local-data-set-of-the-configuration-root; open-data-set-has-no-safe-digest-proven-only-by-coverage-through-its-reader; kept-backups-by-their-own-rules-and-content-lists; legacy-backups-debug-captures-process-output-diagnostics-beyond-the-journal-unknown-entries-entries-of-another-type-claim-look-alikes-links-or-special-files-keep-it-whole; unfinished-work-keeps-it-when-proven-by-coverage; databases-only-through-the-foreign-copy-dev-ino-checked-state-unchanged-and-records-as-small-regular-files; its-foreign-claim-taken-without-waiting-in-check-deletion-and-settling-held-by-verification-a-merge-or-another-cleanup-means-kept; a-merge-of-it-committing-or-requested-and-not-yet-run-keeps-it-in-check-and-deletion; a-read-only-view-registered-under-the-current-configuration-root-for-its-whole-life-means-kept-dead-registrations-removed-unreadable-ones-count; local-digest-and-ids-under-their-own-maintenance-never-inside-the-foreign-claim; deletion-under-admission-and-foreign-claim-relocates-and-verifies-again-compares-every-directory-by-identity-and-names-and-every-file-outside-its-content-store-by-exact-state-and-the-proving-data-set-compares-once-more-right-before-the-rename-renames-checks-coverage-and-tree-again-and-marks-with-its-id; admission-released-once-the-mark-is-durable-recursive-removal-under-the-foreign-claim-alone; only-writes-in-a-foreign-directory-rename-mark-and-removal-of-the-deleted-root-itself; leftovers-found-where-discovery-finds-roots-settled-under-admission-and-the-same-claim-removed-after-the-admission; two-installations-sharing-a-left-data-directory-do-not-exclude-each-other-known-limitation",
    "coverage": "every-conversation-message-revision-and-history-record-id-of-the-copy-turns-tool-calls-and-results-file-changes-interactions-and-answers-processes-and-output-attachments-compressions-child-executions-and-collaboration-messages-and-every-body-as-a-regular-file-of-its-size-in-the-proving-local-data-set-for-a-backup-the-one-of-its-control-root; every-message-visible-in-the-copy-shown-there-with-the-same-current-revision-else-deletable-only-as-replaced-content-grouped-apart-and-never-ticked-by-default; copy-read-in-facts-worker-from-private-copy-ids-and-visible-messages-read-from-the-tables-not-indexed-cached-gzip-compressed-by-exact-file-state-in-merge-ledger-coverage-a-copy-with-body-ids-only-checked-by-the-proving-data-sets-own-rows-a-local-data-set-also-with-body-locations-and-project-names; a-listed-copy-keeps-only-its-conversations-and-visible-messages-for-the-deletion-to-read-again; current-data-set-only-through-its-own-worker-reader-250-ids-per-read; other-local-data-sets-through-facts-worker-private-copy-under-their-maintenance; copy-or-data-set-sharing-an-inode-with-a-local-database-wal-or-shm-by-dev-ino-never-copied-kept-as-history; uncovered-kept-as-history-naming-what-is-missing; data-sets-named-as-the-history-management-names-them-never-by-id; reasons-in-words-technical-cause-only-in-the-log-times-in-local-time; an-unreadable-directory-noted-as-a-problem-its-backups-kept-the-check-completes",
    "conditions": "upgrade-backup-completion-record-exact-3-4-to-5-or-3-4-5-to-6-next-binding-same-data-set-local-generation-not-lower-and-7-days-after-completion-from-the-latest-of-record-time-directory-name-and-record-file-mtime-ctime-later-than-now-kept; published-3-to-4-upgrade-backups-kept; merge-and-source-backup-root-binding-same-data-set-local-generation-not-lower",
    "protections": "in-progress-control-root-journal-or-committing-merge; newest-complete-merge-backup-at-least-1h-old-per-control-root-and-every-newer-one; merge-backup-younger-than-1h; merge-backup-age-from-the-later-of-name-time-and-directory-mtime; directory-holding-anything-its-kind-does-not-write-tmp-files-meaning-unfinished; source-backup-referenced-by-unreported-finalization; large-merge-preparation-target-backup-while-its-registration-is-live-or-unused-never-deleted-nor-the-anchor-registrations-unreadable-keep-every-merge-backup; foreign-source-partial-or-pending-or-residual-kept; selected-library-never-deleted-unselected-local-source-deletion-requires-merged-into-current-with-unchanged-cached-file-state-or-explicit-current-coverage-never-partial-or-residual",
    "confirmation": "first-confirm-panel-grouped-by-kind-name-size-created-purpose-owner-and-conclusion-only-deletable-items-have-boxes-complete-ones-ticked-replaced-content-grouped-apart-unticked-description-states-the-proof-as-it-is; second-danger-confirm-panel-items-total-size-messages-that-become-unreadable-check-time-cannot-be-undone",
    "deletion": "reverified-under-configuration-admission-and-control-root-maintenance-by-the-same-rules-file-state-hard-links-local-identity-and-generation-journals-newest-and-coverage; backup-cleanup-activity-marker-in-both-claims; current-data-set-checked-again-by-conversations-and-visible-messages-none-replaced-beyond-what-was-listed-others-by-file-state; directory-compared-once-more-right-before-the-rename-by-identity-names-and-exact-file-state-a-link-put-in-its-place-kept; rename-to-deleting-id-then-coverage-and-directory-checked-again; not-covered-or-unverifiable-renamed-back-and-kept; verified-mark-naming-the-renamed-directory-this-configuration-root-and-its-cleanup-identity-made-durable-then-recursive-remove-mark-last-only-of-a-real-directory-never-through-a-link; failure-after-the-mark-reported-unfinished-never-kept; crash-leftover-marked-by-this-installation-from-this-configuration-root-or-a-left-data-directory-whose-cleanup-identity-is-still-the-same-or-gone-with-its-bookkeeping-finished-by-next-cleanup-never-renamed-back-half-removed; any-other-renamed-back-and-checked-again; a-mark-or-identity-that-cannot-be-read-now-left-for-the-next-check",
    "filesystem": "never-follows-symbolic-links; platform-path-comparison; sqlite-only-in-workers",
    "reclaim": "files-with-other-hard-links-not-counted",
    "localDataSetDeletion": "selected-never-delete; partial-or-residual-never-delete; exact-merged-into-current-and-unchanged-cached-state-or-explicit-coveredByCurrent-reusing-backup-cleanup-coverage-for-source-and-nested-backups; coverage-refuses-unfinished-work-missing-conversations-revisions-bodies-and-edited-deleted-or-replaced-visible-messages; never-auto-delete-unmerged-source"
  };
  if (!plainObject(cleanup) || JSON.stringify(cleanup) !== JSON.stringify(expectedCleanup)) {
    failures.push('备份清理只删能证明完整存在于本地库的副本：升级前、合并前与合并来源的收尾前备份的全部对话、消息修订与其它历史记录 id 和它引用的正文都在同一控制根的本地库里、显示的消息也相同才可删（显示不同的单列、默认不勾选；当前库只经它自己的读取线程查询，与本地库是同一个文件的硬链接不读），保护满 1 小时的最新一份及更新的、不满 1 小时、有临时文件、进行中的日志与未报告的收尾引用，升级备份按最晚的时间满 7 天、旧版 3→4 备份一律保留；外来历史库只处理核验通过的，与非当前本地库身份与内容摘要相同、或它与它保留的备份的全部 id 都在某一个本地库里才可删，按控制根删（拷来目录整体不删），外来声明不等待地取、声明内重新核验，外来目录里只动被删那一份；拷来目录整体与旧格式备份只列出；两步确认，锁内同口径复核后先改名、再核一次覆盖，通过才写已核对标记再删，不跟随符号链接');
  }
  const cleanupSource = readText(path.join(root, 'backend/reliableKernel/runtimeBackupCleanup.ts'));
  const graceDays = Number(/RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS = ([\d_]+) \* 24 \* 60 \* 60 \* 1000;/.exec(cleanupSource)?.[1]?.replaceAll('_', ''));
  const minAge = /RUNTIME_BACKUP_CLEANUP_MERGE_BACKUP_MIN_AGE_MS = (?:([\d_]+) \* )?60 \* 60 \* 1000;/.exec(cleanupSource);
  const minAgeHours = minAge ? Number(minAge[1]?.replaceAll('_', '') ?? 1) : Number.NaN;
  const readBatch = Number(/RUNTIME_BACKUP_CLEANUP_READ_BATCH = ([\d_]+);/.exec(cleanupSource)?.[1]?.replaceAll('_', ''));
  if (!expectedCleanup.conditions.includes(`-and-${graceDays}-days-after-completion`)
    || !expectedCleanup.protections.includes(`; merge-backup-younger-than-${minAgeHours}h;`)
    || !expectedCleanup.coverage.includes(`-reader-${readBatch}-ids-per-read;`)) {
    failures.push('migration.json#backupCleanup 的升级宽限天数、合并前备份最短保留时间与每次读取 id 数必须与 runtimeBackupCleanup.ts 的常量一致');
  }
  const directoryConstant = (file, name) => new RegExp(`export const ${name} = '([^']+)';`).exec(readText(path.join(root, 'backend/reliableKernel', file)))?.[1];
  const deletableDirectories = [
    directoryConstant('runtimeEpochMigration.ts', 'RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY'),
    directoryConstant('runtimeDataSetMerge.ts', 'RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY'),
    directoryConstant('runtimeDataSetMerge.ts', 'RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY')
  ];
  const deletableKinds = /RUNTIME_BACKUP_DELETABLE_KINDS: readonly RuntimeBackupKind\[\] = Object\.freeze\(\[([^\]]*)\]\)/.exec(cleanupSource)?.[1]
    ?.split(',').map((item) => item.trim().replace(/^'|'$/g, '')).filter(Boolean) ?? [];
  if (JSON.stringify(deletableDirectories) !== JSON.stringify(expectedCleanup.deletableKinds)
    || JSON.stringify(deletableKinds) !== JSON.stringify(['epoch-migration', 'merge-target', 'merge-source', 'foreign-history'])) {
    failures.push('备份清理可删的只有 migration.json#backupCleanup.deletableKinds 列出的三种目录（升级前备份、合并前备份、合并来源的收尾前备份）与核验通过的外来历史库');
  }
  const foreignSource = readText(path.join(root, 'backend/reliableKernel/runtimeForeignHistory.ts'));
  const claimSource = readText(path.join(root, 'backend/reliableKernel/runtimeHostControl.ts'));
  // Foreign history is deleted only under its own foreign claim taken without waiting, never under a
  // maintenance claim of its located paths (that one lives beside the foreign directory).
  if (!cleanupSource.includes('tryWithForeignRuntimeRootClaim(') || !cleanupSource.includes('copyForeignRuntimeSqliteFiles(')
    || /withRuntimeMaintenance\((?:proof\.)?root\.located|withRuntimeMaintenance\(read\.root/.test(cleanupSource)
    || !/refuseWhenHeld: true/.test(foreignSource) || !/if \(wait\?\.refuseWhenHeld\) throw new RuntimeClaimHeldError/.test(claimSource)) {
    failures.push('清理备份删除外来历史库必须取它在当前配置根下的外来声明且不等待（被只读查看、核验或合并持有时保留），数据库只经外来库模块的复制函数读，不取外来目录旁的维护声明');
  }
  // An open read-only view is registered in the current configuration root for its whole life and
  // keeps the root; the history rows beyond messages are the undeletable domains; the admission is
  // released once a foreign root's mark is durable (its removal runs under the foreign claim alone).
  const readSource = (file) => readText(path.join(root, 'backend/reliableKernel', file));
  const viewsSource = readSource('runtimeForeignHistoryViews.ts');
  if (!cleanupSource.includes('liveForeignRuntimeHistoryViews(') || !readSource('runtimeDataSetHistory.ts').includes('registerForeignRuntimeHistoryView(')
    || !viewsSource.includes("const VIEWS_DIRECTORY = 'foreign-views';") || !viewsSource.includes('resolveVscodeRuntimeMergeLedgerRoot(')
    || !cleanupSource.includes('withForeignClaimReleasingAdmission<RemovalOutcome>(')
    || !/includes\('delete'\)\) \{\n\s+throw new Error\(`History record domain/.test(readSource('runtimeDataSetFacts.ts'))) {
    failures.push('清理备份：打开着的外来库只读查看在当前配置根 .limcode-runtime-merges/foreign-views 登记到关闭为止，遇到存活的查看按正在使用保留；覆盖核对的其它历史记录只取没有 delete 变更的域；外来库的已核对标记落盘后放开 admission，递归删除只在外来声明内');
  }
  // A local backup is compared once more right before and after its rename, and removed only as a
  // real directory; a large-merge preparation's registered backup stays and anchors nothing; a mark
  // of a data directory this installation left counts after a relocation (盲审 #3, #4, F2).
  if (!cleanupSource.includes('if (!await sameShallowTree(entry.path, proof.tree))')
    || !cleanupSource.includes('(await sameShallowTree(deleting, proof.tree) ?')
    || !cleanupSource.includes('if (!(await fs.lstat(directory)).isDirectory()) throw')
    || !cleanupSource.includes('readRuntimeLargeMergeTargetBackups(paths)') || !cleanupSource.includes('&& !preparingBackupReason(ledger, backup)')
    || !cleanupSource.includes('previousDataRootPaths.find((root) => comparable(path.resolve(root)) === written)')) {
    failures.push('清理备份：本地备份改名前最后一步与改名之后都比较目录、只删真的目录不跟随链接；大库合并准备登记的备份不删也不当锚点；迁移之后认出本安装以前的数据目录写的已核对标记');
  }
  if (migration?.candidateRoot?.isolated !== true || migration?.candidateRoot?.mayReadLegacyRuntime !== false) {
    failures.push('候选验证必须使用隔离数据根且不能读取旧运行时');
  }
  if (migration?.releaseDecisions?.cutoverActor !== 'final-vsix-cutover-only-coordinator') failures.push('cutover必须由最终VSIX的cutover-only coordinator执行');
  if (migration?.releaseDecisions?.agentSystemScopeLinks !== 'reset-no-authority') failures.push('agentSystem scope link因无独立authority必须重置');

  const manifest = migration?.physicalManifest;
  if (!plainObject(manifest)) {
    failures.push('migration.physicalManifest必须是对象');
    return;
  }
  const constantsPath = path.join(root, 'backend/capabilities/vscodeStorage/constants.ts');
  const pathsPath = path.join(root, 'backend/capabilities/vscodeStorage/paths.ts');
  const protocolPath = path.join(root, 'shared/protocol.ts');
  const constantsSource = readText(constantsPath);
  const pathsSource = readText(pathsPath);
  const protocolSource = readText(protocolPath);
  const registeredDirConstants = parseIdentifierConstArray(constantsSource, 'REGISTERED_STORAGE_ROOT_DIRS');
  const registeredFileConstants = parseIdentifierConstArray(constantsSource, 'REGISTERED_STORAGE_ROOT_FILES');
  const constantValues = new Map([...constantsSource.matchAll(/export const ([A-Z][A-Z0-9_]+) = '([^']+)'/g)].map((match) => [match[1], match[2]]));

  const roots = objectArray(manifest.registeredRoots, 'migration.physicalManifest.registeredRoots', failures);
  failures.push(...exactSetProblems('migration注册root常量', registeredDirConstants, roots.map((entry) => entry.pathSource?.constant)));
  const files = objectArray(manifest.registeredFiles, 'migration.physicalManifest.registeredFiles', failures);
  failures.push(...exactSetProblems('migration注册file常量', registeredFileConstants, files.map((entry) => entry.pathSource?.constant)));

  const settings = objectArray(manifest.settingsSections, 'migration.physicalManifest.settingsSections', failures);
  const protocolSettings = parseQuotedConstArray(protocolSource, 'GLOBAL_SETTINGS_SECTIONS');
  failures.push(...exactSetProblems('migration global settings section', protocolSettings, settings.map((entry) => String(entry.id ?? '').replace(/^setting\./, ''))));
  const conversationSettings = parseQuotedConstArray(protocolSource, 'CONVERSATION_SETTINGS_SECTIONS');
  failures.push(...exactSetProblems('migration conversation settings section', conversationSettings, manifest.conversationSettings?.sections ?? []));
  if (manifest.conversationSettings?.disposition !== 'archive-reset-whole') failures.push('Conversation settings必须归档重置');
  if (!String(manifest.conversationSettings?.filePattern ?? '').includes('conversation-')) failures.push('Conversation settings必须声明真实文件匹配规则');

  const externals = objectArray(manifest.externalEntries, 'migration.physicalManifest.externalEntries', failures);
  failures.push(...exactSetProblems('migration外部/控制项', EXTERNAL_MIGRATION_IDS, externals.map((entry) => entry.id)));
  const allEntries = [...roots, ...files, ...settings, ...externals];
  uniqueStrings(allEntries.map((entry) => entry.id), 'migration物理项ID', failures);
  const allowedKinds = new Set(manifest.allowedPhysicalKinds ?? []);
  const allowedDispositions = new Set(manifest.allowedDispositions ?? []);
  for (const entry of allEntries) {
    nonEmptyString(entry.id, 'migration物理项.id', failures);
    nonEmptyString(entry.logicalDomain, `${entry.id}.logicalDomain`, failures);
    if (!allowedKinds.has(entry.physicalKind)) failures.push(`${entry.id}.physicalKind未登记`);
    if (!allowedDispositions.has(entry.disposition)) failures.push(`${entry.id}.disposition未登记`);
    nonEmptyString(entry.repository, `${entry.id}.repository`, failures);
    nonEmptyString(entry.codec, `${entry.id}.codec`, failures);
    nonEmptyString(entry.indexPolicy, `${entry.id}.indexPolicy`, failures);
    nonEmptyString(entry.recordsPolicy, `${entry.id}.recordsPolicy`, failures);
    nonEmptyStringArray(entry.verification, `${entry.id}.verification`, failures);
    nonEmptyString(entry.unknownFilePolicy, `${entry.id}.unknownFilePolicy`, failures);
    const constant = entry.pathSource?.constant;
    if (constant) {
      const expectedPath = constantValues.get(constant);
      if (entry.pathSource?.relativePath !== expectedPath) failures.push(`${entry.id}.relativePath与${constant}不一致`);
      if (entry.pathSource?.getPathsRequired !== true) failures.push(`${entry.id}必须通过getPaths解析`);
      const property = entry.pathSource?.storagePathsProperty;
      if (property && !pathsSource.includes(property)) failures.push(`${entry.id}.storagePathsProperty在paths.ts不存在：${property}`);
      if (!property && entry.pathSource?.resolution !== 'getPaths().globalStorageUri + registered constant') {
        failures.push(`${entry.id}缺少getPaths constant解析规则`);
      }
    }
  }

  const scopePolicy = manifest.scopePolicy;
  failures.push(...exactSetProblems('保留配置scope', ['global', 'agent', 'workflow'], scopePolicy?.preservedScopeKinds ?? []));
  failures.push(...exactSetProblems('重置配置scope', ['conversation', 'run', 'agentSystem'], scopePolicy?.resetScopeKinds ?? []));
  for (const entry of roots.filter((item) => item.disposition === 'filter-by-scope' && item.id !== 'root.settings')) {
    failures.push(...exactSetProblems(`${entry.id}保留scope`, scopePolicy.preservedScopeKinds, entry.preservedScopeKinds ?? []));
    failures.push(...exactSetProblems(`${entry.id}重置scope`, scopePolicy.resetScopeKinds, entry.resetScopeKinds ?? []));
    if (!String(entry.indexPolicy).includes('rewrite-index')) failures.push(`${entry.id}过滤后必须重写index`);
  }
  const settingsRoot = roots.find((entry) => entry.id === 'root.settings');
  if (settingsRoot?.disposition !== 'filter-by-scope') failures.push('settings root必须按global/conversation过滤');
  const common = settings.find((entry) => entry.id === 'setting.common');
  if (!(common?.relocateFields ?? []).includes('proxy')) failures.push('common.proxy必须从globalStatus迁入settings root');
  const unknown = externals.find((entry) => entry.id === 'external.unknown-data-root-files');
  if (unknown?.disposition !== 'external-untouched' || unknown?.unknownFilePolicy !== 'leave-untouched') failures.push('未知data-root用户文件必须完全不触碰');
  const workspace = externals.find((entry) => entry.id === 'external.workspace');
  if (workspace?.disposition !== 'external-untouched') failures.push('Workspace必须声明external-untouched');
  for (const id of ['external.global-skills', 'external.global-agents-rule', 'external.global-claude-rule']) {
    if (externals.find((entry) => entry.id === id)?.disposition !== 'preserve-in-place') failures.push(`${id}必须原地保留`);
  }

  const expectedSequence = [
    'close-command-admission',
    'drain-checks',
    'persist-cutover-request',
    'quit-vscode-window',
    'install-final-vsix',
    'restart-extension-host-cutover-only',
    'archive-runtime-with-journal',
    'filter-and-verify-configuration',
    'create-new-root-binding-pending',
    'create-limcode-sqlite-and-cas',
    'write-current-runtime-kernel-epoch',
    'atomic-activate-root-binding',
    'open-new-runtime-only',
    'run-installed-gate'
  ];
  const sequence = stringArray(migration?.cutoverSequence, 'migration.cutoverSequence', failures);
  failures.push(...exactSetProblems('cutover步骤', expectedSequence, sequence));
  for (let index = 1; index < expectedSequence.length; index += 1) {
    if (sequence.indexOf(expectedSequence[index - 1]) >= sequence.indexOf(expectedSequence[index])) {
      failures.push(`硬切换顺序必须先${expectedSequence[index - 1]}再${expectedSequence[index]}`);
    }
  }
  if (migration?.archiveContract?.actor !== 'final-vsix-cutover-only-coordinator') failures.push('archiveContract缺少真实执行主体');
  for (const marker of ['journal', '恢复', '激活前失败']) {
    const text = JSON.stringify(migration?.archiveContract ?? {});
    if (!text.includes(marker)) failures.push(`archiveContract缺少失败语义：${marker}`);
  }
}

/**
 * Foreign history (archives and copied data directories) is registered in place and read only:
 * located paths for every read, the recorded binding only as an identity fence, never a
 * RootAuthority or RuntimeDatabase, and its cache and claims only under the current configuration root.
 * It is merged into the current data set only on the user's request, under its claim, copied and
 * never linked, recorded under the current configuration root; never finalized or migrated.
 */
function validateForeignHistory(root, authority, failures) {
  const read = (file) => readText(path.join(root, 'backend/reliableKernel', file));
  const foreignSource = read('runtimeForeignHistory.ts');
  const foreignMergeSource = read('runtimeForeignHistoryMerge.ts');
  const casTransferSource = read('runtimeCasTransfer.ts');
  const forbidden = /\bRuntimeDatabase\b|new RootAuthority|withRuntimeMaintenance\(root\.recorded|recorded\.paths\.(databasePath|casRootPath|rootPointerPath|runtimeEpochPath)/;
  if (authority?.rootPolicy?.foreignHistory !== 'verified-in-place-read-only-located-paths-recorded-fence-never-root-authority-never-written-except-backup-cleanup-deleting-a-proven-root-itself; registered-pending-and-merged-into-current-under-its-claim-copied-never-linked-ledger-under-current-configuration-root; reset-archives-named-time-id8-or-time-epoch-n-to-m-id8-or-the-17-digits-of-the-manual-reset-of-released-0.0.10-0.0.20; published-epochs-3-4-5-upgraded-by-the-exact-migrator-only-on-each-private-copy-in-a-worker-converted-bodies-in-an-overlay-under-the-current-configuration-root-read-before-the-root-a-failed-upgrade-listed-not-verified; other-epochs-listed-not-verified-with-location-size-and-reason; new-reset-backups-under-.limcode-runtime-reset-backups-registered-as-residual-never-automatically-discovered-for-merge'
    || !foreignSource.includes("const CACHE_DIRECTORY = 'foreign';") || !foreignSource.includes("const CLAIMS_DIRECTORY = 'foreign-claims';")
    || !foreignSource.includes("const UPGRADE_CAS_DIRECTORY = 'foreign-upgrade-cas';")
    || forbidden.test(foreignSource)) {
    failures.push('外来历史库只能原位只读登记：读取只经 located 路径，recorded 只作身份栅栏与显示，从不建立 RootAuthority 或打开 RuntimeDatabase，结果缓存、声明与已发布旧格式升级时转换出的正文只在当前配置根 .limcode-runtime-merges/foreign、foreign-claims 与 foreign-upgrade-cas，外来目录除清理备份删除经证明的那一份本身之外从不写入');
  }
  const mergeSource = read('runtimeDataSetMerge.ts');
  const streamedSource = read('runtimeDataSetStreamedMerge.ts');
  const ledgerSource = read('runtimeDataSetMergeLedger.ts');
  const foreignId = 'const FOREIGN_ID = /^foreign:(archive|copied):[0-9a-f]{16}$/;';
  const missing = [
    // Its claim is held from preparation to commit, taken before (never inside) configuration admission.
    [foreignSource, 'if (isRuntimeDataRootAdmissionHeld(configurationRoot)) {'],
    [foreignMergeSource, 'const claim = await holdForeignRuntimeRootClaim({ globalStoragePath: configurationRoot }, locatedId, pointerOf(location), { refuseWhenHeld: !!options.signal });'],
    // Runtime metadata is snapshotted first. Packed bytes come from a scoped private SQLite
    // main/WAL copy; absent packed keys retain strict no-follow loose-file descriptor reads.
    [foreignMergeSource, 'copy: async (root) => copyLocatedRuntimeDatabase(root, await this.heldFiles(), this.signal)'],
    [foreignMergeSource, 'objects = await locatedCasTransferSource(candidate.root, () => this.heldFiles(), this.signal);'],
    [foreignMergeSource, 'try { await objects.close(); }'],
    [foreignMergeSource, 'finally { await snapshot.close(); }'],
    [foreignMergeSource, 'try { return await objects.open(object); }'],
    [foreignSource, 'const packed = await openPackedCasSnapshot({ ...root.recorded, paths: root.located }, root.containerRoot, held, signal);'],
    [foreignSource, 'copy = await copyForeignRuntimeSqliteFiles(containerRoot, file, held, PACKED_CAS_FILE, signal);'],
    [foreignSource, 'worker = await PackedCasWorkerClient.open({ ...binding,'],
    [foreignSource, 'casRootPath: path.dirname(copy.databasePath)'],
    [foreignSource, '? openLocatedRuntimeFile(await reachable(object), await currentHeld()) : bufferReadHandle(bytes);'],
    [foreignSource, 'await assertNoSymbolicPath(root.containerRoot, directory);'],
    [foreignSource, 'const handle = await fs.open(file, OPEN_READ_ONLY);'],
    [foreignSource, 'if (held.has(`${info.dev}:${info.ino}`)) throw openDatabase(file);'],
    [casTransferSource, 'const objects = this.options.sourceObjects;'],
    [casTransferSource, 'copyObjectIntoCas(objects, this.temporaryRoot, row, targetFile, row.sha256, row.byte_length, verified)'],
    [casTransferSource, "return 'copied';"],
    // Never finalized, never a migration source, fenced by its held claim, its objects copied (never linked).
    [mergeSource, "if (isForeignCandidate(candidate)) throw new TypeError('A foreign history root is never finalized.');"],
    [mergeSource, "if (isForeignCandidate(candidate)) throw new TypeError('A data-root migration has no foreign sources.');"],
    [mergeSource, '? candidate.hold.fence(body) : withRuntimeMaintenance(binding.paths, body);'],
    [mergeSource, 'verified, verifyOnly, exclusions, signal: candidate.hold.signal, sourceObjects: candidate.hold.objects(candidate), freeSpace: options.freeSpace ?? freeSpace'],
    [mergeSource, "kind: 'blocked', code: 'runtime-data-set-merge-foreign-old-copy',"],
    [mergeSource, "kind: 'blocked', code: 'runtime-data-set-merge-foreign-unfinished-work',"],
    // The large-merge session reads a foreign source only through the hold its preparation took.
    [streamedSource, 'const resolver = historicalMergeSources(paths, (candidateId) => internals.sources.get(candidateId)?.state.foreign);'],
    // Only a request names a foreign source (with its location), and only a foreign id carries one.
    [ledgerSource, foreignId], [foreignSource, foreignId],
    [ledgerSource, 'if (FOREIGN_ID.test(request.candidateId) !== (foreign !== undefined)) continue;'],
    // Its own committing merge (only read from it) never makes a foreign root unverifiable.
    [foreignSource, 'const merged = typeof record.candidateId === \'string\' && FOREIGN_ID.test(record.candidateId) ? [record.target] : [record.source, record.target];']
  ].filter(([source, text]) => !source.includes(text));
  const metadataSnapshotAt = foreignMergeSource.indexOf('snapshot = await createLocatedRuntimeDatabaseSnapshot(candidate.root, {');
  const packedSnapshotAt = foreignMergeSource.indexOf('objects = await locatedCasTransferSource(candidate.root, () => this.heldFiles(), this.signal);');
  if (missing.length > 0 || metadataSnapshotAt < 0 || packedSnapshotAt <= metadataSnapshotAt || forbidden.test(foreignMergeSource)
    || /withRuntimeMaintenance\(|withLocatedRuntimeRootFence\(|auditForeignRuntimeRoot\(/.test(foreignMergeSource)) {
    failures.push('外来历史库按待合并登记或用户请求合并进当前库：从准备到提交持有它在当前配置根的声明（在准入之外取得），快照与审计只在私有拷贝上，正文经不跟随链接的描述符复制、从不硬链接，'
      + '从不收尾、升级、做来源备份或作为迁移来源，未结束任务按对话剔除、与本地库同身份时拒绝并写明原因，账本与指纹只在当前配置根；'
      + `缺少：${missing.map(([, text]) => text.slice(0, 60)).join(' | ') || '（无）'}`);
  }
}

/**
 * Deleted conversations never come back through a merge (migration.json#historicalMerge.deletedConversationPolicy):
 * the deletion command records them before its commit, every merge reads those records and the closures
 * for the target and the identities it continues, and nothing unreadable is read as none.
 */
function validateDeletedConversations(root, failures) {
  const read = (file) => readText(path.join(root, file));
  const kernel = (file) => read(`backend/reliableKernel/${file}`);
  const records = kernel('runtimeMergeTombstones.ts');
  const deletion = kernel('conversationDeletion.ts');
  const command = read('backend/application/reliableKernel/conversationDeleteCommand.ts');
  const facade = read('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.ts');
  const merge = kernel('runtimeDataSetMerge.ts');
  const streamed = kernel('runtimeDataSetStreamedMerge.ts');
  const ledger = kernel('runtimeDataSetMergeLedger.ts');
  const foreignHistory = kernel('runtimeForeignHistory.ts');
  const cleanup = kernel('runtimeBackupCleanup.ts');
  const relocation = kernel('runtimeDataRootRelocation.ts');
  const missing = [
    // One durable file per deletion, strictly read; the identity directory and its continuation file by name.
    [records, "export const RUNTIME_DELETED_CONVERSATIONS_DIRECTORY = 'deleted-conversations';"],
    [records, "export const RUNTIME_IDENTITY_ALIASES_DIRECTORY = 'aliases';"],
    [records, 'const DELETION_RECORD_NAME = /^\\d{8}T\\d{9}Z-[0-9a-f]{8}\\.json$/;'],
    [records, "if (!exactKeys(record, ['version', 'conversationIds', 'deletedAt']) || record!.version !== RECORD_VERSION"],
    [records, "if (!exactKeys(aliases, ['version', 'continues']) || aliases!.version !== RECORD_VERSION || !Array.isArray(aliases!.continues)"],
    [records, 'await handle.sync();'], [records, 'await syncDirectoryDurably(directory);'],
    // Recorded with exactly the deleted ids, right before the deletion commits; a failure only warns.
    [deletion, 'await options.beforeCommit?.(deletionOrder);\n      await this.database.transaction(steps);'],
    [command, 'application.conversationDeletion.delete(this.conversationId, { beforeCommit: (ids) => this.recordDeleted(ids) }));'],
    [facade, 'recordDeleted: (conversationIds) => recordRuntimeDeletedConversations('],
    [facade, '对话已删除，但没能记下删除记录，以后合并旧拷贝时这些对话可能会回来。'],
    // Every merge (a migration's too) reads them for the target and the identities it continues.
    [merge, '  const merged = await recordedConversations(paths, target, candidate);'],
    [merge, 'for (const id of await mergeRecordsReadable(() => readRuntimeDeletedConversations(target.configurationRootPath, targets))) merged.add(id);'],
    // What the user deleted from the source itself (an earlier copy of it still holds it), withdrawn when not deleted.
    [merge, "for (const id of await mergeRecordsReadable(() => readRuntimeDeletedConversations(root, sources), '这个历史库的删除记录')) merged.add(id);"],
    [command, 'for (const receipt of this.receipts.splice(0)) await receipt.withdraw().catch(() => undefined);'],
    [cleanup, 'if ((await readRuntimeDataSetMergeRequests(paths)).has(foreignId)) {'],
    [merge, 'for (const id of runtimeDataSetConversationsMergedFrom(record, source, targets)) merged.add(id);'],
    [streamed, '  const merged = await engine.recordedConversations(paths, target, candidate);'],
    [streamed, '    const merged = await engine.recordedConversations(paths, target, candidate);'],
    // Old copies of continued identities; an unreadable local data set defers a foreign merge.
    [merge, 'const owner = await localOwnerOf(target, inspection.candidates, { dataSetId: candidate.dataSetId!, rootInstanceId: candidate.rootInstanceId! }, true);'],
    [merge, 'for (const source of sources) for (const id of runtimeDataSetConversationsMergedFrom(record, source, targets)) merged.add(id);'],
    [merge, "kind: 'deferred', code: 'runtime-data-set-merge-local-unreadable',"],
    [merge, "kind: 'blocked', code: 'runtime-data-set-merge-continued-identity',"],
    [foreignHistory, 'await findRuntimeIdentityOwner(configurationRoot, locals, { dataSetId: entry.dataSetId, rootInstanceId: entry.rootInstanceId }'],
    // Closures survive a new incarnation; an interrupted foreign commit converges without its root.
    [ledger, 'const { mergedInto, formerMergedInto } = carriedConversations(previous, record.source);'],
    [merge, 'const local = foreign ? undefined : await resolveVscodeRuntimeDataSet(paths, candidateId);'],
    [merge, 'if (!await convergeInterruptedCommit(storagePaths, target, source, report)) continue;'],
    [cleanup, 'const committing = await foreignMergePending(input.configurationRootPath, found.id);'],
    [cleanup, 'const committing = await foreignMergePending(configurationRootPath, proof.found.id);'],
    // A migration that left conversations out keeps that data set in the old directory.
    [relocation, 'else if (migrated.skippedConversations) {']
  ].filter(([source, text]) => !source.includes(text));
  if (missing.length > 0) {
    failures.push('删除的对话不会经合并回来：删除命令在提交前把整棵子树持久记到当前配置根，写不成照常删除并如实提示；每次合并（在线、独占、大库会话与准备、外来、迁移）'
      + '按目标及其延续身份读删除记录与闭包，读不出就推迟；延续身份的拷贝是当前库的旧拷贝；新化身不丢旧身份的闭包；提交后中断的外来合并不定位它也能收敛；'
      + `缺少：${missing.map(([, text]) => text.slice(0, 60)).join(' | ')}`);
  }
}

function validateAuthority(authority, migration, failures) {
  if (authority?.productScope !== 'single-user-local-extension') failures.push('产品范围必须是单用户本机扩展');
  const database = authority?.runtimeDatabase;
  if (database?.engine !== 'sqlite' || database?.fileName !== 'limcode.sqlite' || database?.filesPerDataSet !== 1) {
    failures.push('运行时必须使用一个limcode.sqlite');
  }
  if (database?.genericJsonTables !== false) failures.push('禁止通用JSON领域表');
  if (database?.arbitrarySqlBatch !== false) failures.push('禁止业务层任意SQL批处理');
  if (database?.businessWritesThroughRepositories !== true) failures.push('业务写入必须经过领域仓储');
  if (database?.maintenanceTransactions !== 'offline-private-instance-only-opened-under-root-maintenance-with-hosts-offline-no-commit-listeners; one-write-transaction-across-requests-other-writes-refused-while-open; appended-steps-under-ordinary-insert-invariants-failed-append-rolls-back-all; touched-model-request-aggregates-and-historical-copies-kept-in-a-temp-table-aggregates-asserted-at-commit; commit-reads-no-changes-back-snapshot-required-allocated-sequences-counted-only; wal-checkpoint-truncate-a-separate-request-outside-the-transaction') {
    failures.push('维护事务只用于持有维护声明、没有在线宿主的离线私有实例，不回传 changes，打开期间拒绝其它写，插入不变量照常');
  }
  if (database?.connectionModel?.writer !== 'single-dedicated-worker-per-host'
    || database?.connectionModel?.crossHostWrites !== 'sqlite-serialized-transactions'
    || authority?.sequenceAllocation?.concurrency !== 'sqlite-serialized-writer-transactions') {
    failures.push('每个宿主独立 SQLite worker，跨宿主写入和序号分配必须由 SQLite 事务互斥');
  }
  if (authority?.schemaPolicy?.currentManifestRequired !== true
    || authority?.schemaPolicy?.runtimeKernelEpoch !== 'single-current-epoch'
    || authority?.schemaPolicy?.incrementalLegacyMigrationChain !== false
    || authority?.schemaPolicy?.incompatibleRuntimeData !== 'exact-published-upgrade-else-fail-closed'
    || authority?.schemaPolicy?.exactPredecessorUpgrade
      !== 'published-epoch-3-4-or-5-to-6-with-backup-journal'
    || authority?.schemaPolicy?.currentEpoch !== 6
    || authority?.schemaPolicy?.packedSmallCasAdmission !== 'epoch-6-whole-data-set-admission-fence-for-packed-small-cas; new-writes-only-loose-cas-keeps-its-bytes; no-history-body-rewrite-or-startup-packing; old-epoch-5-readers-refuse-open; live-or-unknown-old-hosts-block-upgrade'
    || authority?.schemaPolicy?.frozenToolsReferenceAdmission !== 'epoch-6-whole-data-set-admission-fence-for-frozen-tools-reference-recipes; new-writes-only-inline-recipes-keep-their-bytes; no-domain-row-or-history-body-rewrite-in-upgrade; old-epoch-5-readers-refuse-open; live-or-unknown-old-hosts-block-upgrade'
    || authority?.schemaPolicy?.catalogReferenceAdmission !== 'epoch-6-whole-data-set-admission-fence-for-compact-catalog-reference-recipes; new-writes-only-inline-recipes-keep-their-bytes; no-domain-row-or-history-body-rewrite-in-upgrade; old-epoch-5-readers-refuse-open; live-or-unknown-old-hosts-block-upgrade') {
    failures.push('SQLite schema必须只有当前manifest和单一运行epoch，不维护旧迁移链');
  }
  if (authority?.rootPolicy?.mode !== 'offline-restart-only' || authority?.rootPolicy?.onlineMigration !== false) {
    failures.push('换根只能离线并在重启后完成');
  }
  if (authority?.rootPolicy?.historicalEpochUpgrade !== 'automatic-backup-then-exact-target-offline-upgrade'
    || authority?.rootPolicy?.historyDiscovery !== 'per-candidate-errors-no-implicit-fallback') {
    failures.push('历史发现必须隔离逐库错误，旧格式自动备份精确升级且禁止隐式换库');
  }
  failures.push(...exactSetProblems('RootBinding字段', ROOT_BINDING_FIELDS, authority?.rootPolicy?.rootBindingFields ?? []));
  if (authority?.rootPolicy?.hostRegistration !== 'serialized-with-runtime-maintenance'
    || authority?.rootPolicy?.maintenanceLifetime !== 'operation-only'
    || authority?.rootPolicy?.configurationRootAdmission !== 'placement-through-host-registration'
    || authority?.rootPolicy?.sharedConfigurationMaintenance !== 'all-runtime-scopes-offline'
    || authority?.rootPolicy?.maintenanceExclusivity !== 'reject-live-or-unknown-other-hosts') {
    failures.push('Runtime 维护必须与宿主注册互斥，且不得破坏存活或身份未知的其他宿主');
  }
  const ownership = authority?.conversationHostOwnership;
  failures.push(...exactSetProblems('会话宿主归属作用域', ['dataSetId', 'conversationId'], ownership?.scope ?? []));
  if (ownership?.manager !== 'ConversationRuntimeOwnerManager'
    || ownership?.storage !== 'runtime-control-directory'
    || ownership?.singleHostPerConversation !== true
    || ownership?.multipleHostsPerWorkspace !== true
    || ownership?.executionLeaseIsSeparate !== true
    || ownership?.liveHostPreemption !== false
    || ownership?.takeover !== 'verified-dead-or-reused-process-only'
    || ownership?.release !== 'no-view-references-no-active-commands-no-pending-work-this-host-executes'
    || ownership?.releasedExecutionLease !== 'claimable-by-any-host') {
    failures.push('同工作区允许多宿主，每个对话必须单宿主归属，且独立于 ExecutionLease；归属只为本宿主能执行的待处理工作保留，已交还的执行租约任何宿主都可接管');
  }
  failures.push(...exactSetProblems('会话归属门禁', [
    'open', 'restore', 'admission', 'recovery', 'child-execution', 'delivery-wake', 'conversation-mutation'
  ], ownership?.gates ?? []));

  failures.push(...exactSetProblems(
    '配置交叉映射字段',
    ['key', 'authority', 'repository', 'codec', 'migrationEntryIds'],
    authority?.configurationDomainEntryFields ?? []
  ));
  const configuration = objectArray(authority?.configurationDomains, 'authority.configurationDomains', failures);
  failures.push(...exactSetProblems('配置领域', CONFIGURATION_DOMAINS, configuration.map((entry) => entry.key)));
  const physicalIds = new Set([
    ...(migration?.physicalManifest?.registeredRoots ?? []).map((entry) => entry.id),
    ...(migration?.physicalManifest?.registeredFiles ?? []).map((entry) => entry.id),
    ...(migration?.physicalManifest?.settingsSections ?? []).map((entry) => entry.id),
    ...(migration?.physicalManifest?.externalEntries ?? []).map((entry) => entry.id)
  ]);
  const configurationRefs = [];
  for (const entry of configuration) {
    if (entry.authority !== 'configuration-file-root') failures.push(`${entry.key}必须继续由独立configuration file root保存`);
    nonEmptyString(entry.repository, `${entry.key}.repository`, failures);
    nonEmptyString(entry.codec, `${entry.key}.codec`, failures);
    const refs = nonEmptyStringArray(entry.migrationEntryIds, `${entry.key}.migrationEntryIds`, failures);
    for (const ref of refs) {
      if (!physicalIds.has(ref)) failures.push(`${entry.key}引用未登记migration物理项${ref}`);
      configurationRefs.push(ref);
    }
  }
  uniqueStrings(configurationRefs, '配置物理项ownership', failures);
  const expectedConfigurationPhysicalIds = [
    ...(migration?.physicalManifest?.registeredRoots ?? [])
      .filter((entry) => entry.id !== 'root.settings' && ['preserve-whole', 'filter-by-scope'].includes(entry.disposition))
      .map((entry) => entry.id),
    ...(migration?.physicalManifest?.settingsSections ?? []).map((entry) => entry.id)
  ];
  failures.push(...exactSetProblems('配置领域physical crosswalk', expectedConfigurationPhysicalIds, configurationRefs));

  const requiredEntryFields = stringArray(authority?.domainEntryFields, 'authority.domainEntryFields', failures);
  failures.push(...exactSetProblems(
    '领域交叉映射字段',
    ['key', 'table', 'repository', 'codec', 'mutations', 'client', 'deletePolicy', 'resetPolicy', 'indexes'],
    requiredEntryFields
  ));
  const domains = objectArray(authority?.runtimeDomains, 'authority.runtimeDomains', failures);
  failures.push(...exactSetProblems('运行时领域', REQUIRED_RUNTIME_DOMAINS, domains.map((entry) => entry.key)));
  uniqueStrings(domains.map((entry) => entry.table), 'SQLite表', failures);
  uniqueStrings(domains.map((entry) => entry.repository), '领域仓储', failures);
  for (const domain of domains) {
    for (const field of requiredEntryFields) if (!(field in domain)) failures.push(`${domain.key ?? '未知领域'}缺少交叉映射字段${field}`);
    nonEmptyString(domain.key, '运行时领域.key', failures);
    if (!/^[a-z][a-z0-9_]*$/.test(domain.table ?? '')) failures.push(`${domain.key}.table必须使用稳定的小写下划线名称`);
    nonEmptyString(domain.repository, `${domain.key}.repository`, failures);
    nonEmptyString(domain.codec, `${domain.key}.codec`, failures);
    nonEmptyStringArray(domain.mutations, `${domain.key}.mutations`, failures);
    nonEmptyString(domain.client, `${domain.key}.client`, failures);
    nonEmptyString(domain.deletePolicy, `${domain.key}.deletePolicy`, failures);
    if (domain.resetPolicy !== 'runtime-dataset') failures.push(`${domain.key}.resetPolicy必须是runtime-dataset`);
    nonEmptyStringArray(domain.indexes, `${domain.key}.indexes`, failures);
  }
  for (const forbidden of ['ChildTurnLink', 'ProviderContinuation', 'ClientChangeLog', 'AskUser', 'TaskList', 'McpToolCall']) {
    if (domains.some((entry) => entry.key === forbidden)) failures.push(`首发运行时领域不得包含${forbidden}`);
  }
  requireDomainIndex(domains, 'CommandReceipt', 'source_kind,source_key UNIQUE', failures);
  requireDomainIndex(domains, 'ContextSegmentSource', 'source_kind,source_id,source_revision UNIQUE', failures);
  requireDomainIndex(domains, 'ContextSequenceNode', 'parent_node_id,segment_id UNIQUE', failures);
  forbidDomainIndex(domains, 'ContextSequenceNode', 'parent_node_id UNIQUE', failures);
  requireDomainIndex(domains, 'ContextSequenceRoot', 'root_node_id', failures);
  forbidDomainIndex(domains, 'ContextSequenceRoot', 'root_node_id UNIQUE', failures);
  requireDomainIndex(domains, 'ConversationContextHeadLink', 'conversation_id UNIQUE', failures);
  requireDomainIndex(domains, 'ModelRequestMessageLink', 'model_request_id UNIQUE', failures);
  requireDomainIndex(domains, 'ModelRequestMessageLink', 'message_id UNIQUE', failures);
  requireDomainIndex(domains, 'RuntimeDelivery', 'inbox_item_id,target_conversation_id,attempt_seq UNIQUE', failures);
  requireDomainIndex(domains, 'RuntimeDeliveryIntentLink', 'delivery_id UNIQUE', failures);
  requireDomainIndex(domains, 'RuntimeDeliveryIntentLink', 'turn_intent_id UNIQUE', failures);
  requireDomainIndex(domains, 'RuntimeDeliveryInputLink', 'delivery_id UNIQUE', failures);
  requireDomainIndex(domains, 'RuntimeDeliveryInputLink', 'pending_turn_input_id UNIQUE', failures);
  requireDomainIndex(domains, 'RuntimeInboxPayloadLink', 'inbox_item_id UNIQUE', failures);
  requireDomainIndex(domains, 'RuntimeDeliveryWake', 'delivery_id UNIQUE', failures);
  requireDomainIndex(domains, 'ProcessCompletionSourceLink', 'process_id UNIQUE', failures);
  requireDomainIndex(domains, 'ProcessCompletionDispatch', 'process_receipt_id UNIQUE', failures);
  requireDomainIndex(domains, 'ConversationReuseLink', 'reuse_key UNIQUE', failures);
  requireDomainIndex(domains, 'ConversationBranchLink', 'target_conversation_id UNIQUE', failures);
  requireDomainIndex(domains, 'ConversationOriginLink', 'conversation_id UNIQUE', failures);
  requireDomainIndex(domains, 'ProjectContext', 'uri UNIQUE', failures);
  requireDomainIndex(domains, 'ConversationProjectLink', 'conversation_id UNIQUE', failures);
  const originDomain = domains.find((entry) => entry.key === 'ConversationOriginLink');
  if ((originDomain?.indexes ?? []).some((index) => index.includes('source_run'))) failures.push('ConversationOriginLink不得继续引用Run身份');
  for (const key of ['ChildExecution', 'ChildExecutionParentLink', 'ChildExecutionTurnLink', 'ChildExecutionIntentLink', 'ChildExecutionActiveTurnLink']) {
    if (!domains.some((entry) => entry.key === key)) failures.push(`ChildExecution lineage缺少${key}`);
  }

  const dispositions = objectArray(authority?.capabilityDispositions, 'authority.capabilityDispositions', failures);
  failures.push(...exactSetProblems('能力disposition', CAPABILITY_DISPOSITIONS, dispositions.map((entry) => entry.id)));
  for (const entry of dispositions) {
    nonEmptyString(entry.disposition, `${entry.id}.disposition`, failures);
    nonEmptyString(entry.target, `${entry.id}.target`, failures);
    if (!STAGES.includes(entry.ownerStage)) failures.push(`${entry.id}.ownerStage无效`);
    nonEmptyStringArray(entry.acceptance, `${entry.id}.acceptance`, failures);
  }
  if (!String(dispositions.find((entry) => entry.id === 'ask-user')?.target ?? '').includes('InteractionRequest')) failures.push('ask_user必须映射到通用Interaction/Tool领域');
  if (!String(dispositions.find((entry) => entry.id === 'task-list')?.disposition ?? '').includes('derived')) failures.push('task list只能是派生客户端投影');

  if (authority?.contentAuthority?.store !== 'cas-directory') failures.push('大内容必须由CAS目录保存');
  if (authority?.contentAuthority?.onlineGcInFirstRelease !== false) failures.push('第一版不建设在线CAS垃圾回收');
  const publishOrder = authority?.contentAuthority?.publishOrder ?? [];
  if (publishOrder.indexOf('publish-by-digest') > publishOrder.indexOf('commit-sqlite-reference')) failures.push('CAS内容必须先发布，再提交SQLite引用');
  if (authority?.executionAuthority?.identity !== 'Turn') failures.push('Turn必须是唯一执行身份');
  if (authority?.executionAuthority?.runOrAgentRunMayOwnLifecycle !== false) failures.push('Run和AgentRun不得拥有生命周期');
  if (authority?.executionAuthority?.ecs !== 'committed-read-projection') failures.push('ECS必须只是已提交数据的读投影');
  if (authority?.executionAuthority?.clientState !== 'bounded-read-model') failures.push('ClientState必须是有界读模型');
  if (authority?.externalWorld?.exactlyOnceExternalEffects !== false) failures.push('不得承诺所有外部副作用严格只执行一次');
  if (authority?.externalWorld?.unknownOutcome !== 'outcome_unknown') failures.push('不可核验的外部结果必须使用outcome_unknown');
}

function validateIdentity(identity, failures) {
  if (identity?.turnIdentity?.soleExecutionIdentity !== true) failures.push('Turn必须是唯一执行身份');
  if (identity?.turnIdentity?.runIdAuthorityAllowed !== false) failures.push('RunId不得继续作为权威身份');
  if (identity?.turnIdentity?.dedupeBy !== 'CommandReceipt(source_kind,source_key)') failures.push('命令去重必须使用CommandReceipt(source_kind,source_key)');
  failures.push(...exactSetProblems('会话宿主身份字段', [
    'dataSetId', 'rootInstanceId', 'rootGeneration', 'conversationId', 'hostBootId',
    'ownerToken', 'processId', 'processStartIdentity', 'startedAt'
  ], identity?.conversationOwnerIdentity?.fields ?? []));
  if (identity?.conversationOwnerIdentity?.scope !== 'authority.json#conversationHostOwnership') {
    failures.push('会话宿主身份必须引用统一的 conversationHostOwnership 合同');
  }
  nonEmptyString(identity?.recoveryJudgment?.precondition, '恢复前置会话归属条件', failures);
  failures.push(...exactSetProblems('Effect身份字段', ['operationId', 'attemptId', 'effectIntentId', 'effectReceiptId'], identity?.effectIdentity?.fields ?? []));
  failures.push(...exactSetProblems('提供方流身份字段', ['modelRequestId', 'attemptSeq', 'socketGeneration', 'streamSeq'], identity?.providerStreamIdentity?.fields ?? []));
  failures.push(...exactSetProblems('RootBinding字段', ROOT_BINDING_FIELDS, identity?.rootBinding?.fields ?? []));
  if (identity?.rootBinding?.cache !== 'immutable-complete-binding-only') failures.push('只能缓存完整且不可变的RootBinding');
  if (identity?.sequencePolicy?.javascript !== 'string-or-bigint-never-number') failures.push('大序号在JavaScript中不得使用number');
  failures.push(...exactSetProblems('identity recovery scan ID', RECOVERY_IDS, identity?.recoveryScan?.scanIds ?? []));
  if (identity?.recoveryScan?.authority !== 'tool.json#recoveryScan') failures.push('recovery scan细节必须由tool.json唯一权威定义');
  const delivery = JSON.stringify(identity?.deliveryIdentity ?? {});
  for (const marker of ['inbox_item_id,target_conversation_id,attempt_seq', 'attempt_seq+1', 'retry_of_delivery_id', 'RuntimeDeliveryInputLink', 'handled_at']) {
    if (!delivery.includes(marker)) failures.push(`Delivery身份合同缺少${marker}`);
  }
}

function validateTool(tool, failures) {
  failures.push(...exactSetProblems('工具执行链', [
    'ToolCall',
    'ToolCallSourceLink',
    'ToolCallPolicySnapshot',
    'ToolExecution',
    'Operation',
    'Attempt',
    'EffectIntent',
    'EffectReceipt',
    'ToolOutcome',
    'ToolModelResult'
  ], tool?.executionChain ?? []));
  if (tool?.resultCardinality?.toolExecutionPerCall !== 'exactly-one') failures.push('每个ToolCall必须只有一个ToolExecution');
  if (tool?.resultCardinality?.toolModelResultPerCall !== 'exactly-one-after-terminal') failures.push('每个终态ToolCall必须只有一个ToolModelResult');
  if (tool?.resultCardinality?.proposalMayBeModelResult !== false) failures.push('提案不能冒充模型工具结果');
  failures.push(...exactSetProblems('Effect kind', ['file_mutation', 'process_start', 'process_exit', 'process_stop_request', 'file_transfer', 'subagent_spawn', 'subagent_cancel', 'mcp_tool_call'], tool?.effectIntent?.effectKinds ?? []));
  for (const outcome of ['succeeded', 'failed', 'cancelled', 'conflict', 'outcome_unknown']) {
    if (!(tool?.effectReceipt?.outcomes ?? []).includes(outcome)) failures.push(`EffectReceipt缺少${outcome}`);
  }
  const retry = tool?.retryPolicy;
  failures.push(...exactSetProblems('自动重试类型', ['provider-transient'], retry?.automaticKinds ?? []));
  if (
    retry?.providerRetryAuthority !== 'frozen-turn-authority+sqlite-model-request-attempt'
    || retry?.providerDefaultMaxRetries !== 8
    || retry?.providerMaxRetries !== 10
    || retry?.configuredPerFrozenAuthority !== true
    || retry?.visibleToUser !== true
    || retry?.visibleWhenTransientThoughtExists !== true
    || retry?.cancelable !== true
  ) failures.push('提供方临时故障必须由冻结Authority驱动最多10次可见、可取消的SQLite重试');
  if (JSON.stringify(retry?.backoffMilliseconds) !== JSON.stringify([500, 1000, 2000, 4000, 8000, 16000, 30000])) failures.push('提供方重试退避必须为0.5/1/2/4/8/16/30秒');
  if (JSON.stringify(retry?.semanticDeadlinesMilliseconds) !== JSON.stringify({ ordinaryFirst: 300000, ordinaryIdle: 600000, compressionCompletion: 270000 })) failures.push('提供方deadline必须为普通首语义300s/idle600s、压缩终态270s');
  if (retry?.automaticAfterExtensionRestart !== 'resume-committed-retry') failures.push('已提交Provider retry必须在Extension重启后恢复');
  for (const field of ['fileMutationAutomaticRetry', 'commandExecutionAutomaticRetry', 'subagentStartAutomaticRetry']) {
    if (retry?.[field] !== false) failures.push(`tool.retryPolicy.${field}必须为false`);
  }
  if (tool?.parallelExecution?.supported !== true) failures.push('必须保留互不冲突工具的并行执行');
  const freshAdmission = tool?.providerBatch?.freshDispatchAdmission;
  if (
    freshAdmission?.scope !== 'process-local-one-shot'
    || freshAdmission?.issuer !== 'same-dispatcher-after-non-deduplicated-atomic-create-commit'
    || freshAdmission?.requiresNonDeduplicatedCommit !== true
    || freshAdmission?.requiresCommitSeq !== true
    || freshAdmission?.subsetConsumption !== true
    || freshAdmission?.recoveryReusable !== false
    || freshAdmission?.fallback !== 'full-durable-preflight'
    || freshAdmission?.preservesTerminationAndEffectFences !== true
  ) failures.push('Provider fresh batch admission必须是同dispatcher签发、进程内一次性且失败回退完整durable preflight');
  failures.push(...exactSetProblems('Provider fresh batch admission匹配字段', [
    'batchId', 'turnId', 'modelRequestId', 'toolCallId', 'providerCallId',
    'toolName', 'arguments', 'policy', 'providerOrdinal', 'callSeq'
  ], freshAdmission?.exactMatchFields ?? []));
  failures.push(...exactSetProblems('Provider fresh batch admission仅可省略', [
    'fresh-tool-six-domain-preflight',
    'model-request-recipe-reread',
    'host-definition-reread',
    'frozen-authority-reread'
  ], freshAdmission?.skipsOnly ?? []));
  failures.push(...exactSetProblems('进程操作', ['execute', 'read_output', 'wait', 'stop'], tool?.processCapability?.operations ?? []));
  if (tool?.processCapability?.releaseMode !== 'detached-wrapper-exact-recovery') failures.push('后台进程首发必须使用detached wrapper精确恢复模式');
  failures.push(...exactSetProblems('进程wrapper证据', ['stableNonce', 'wrapperPid', 'childPid', 'processGroupId', 'startFingerprint', 'commandDigest', 'spoolPath'], tool?.processCapability?.wrapper?.requiredEvidence ?? []));
  if (tool?.processCapability?.wrapper?.noDaemonBroker !== true) failures.push('进程恢复不得扩展成通用daemon/broker');
  const processText = JSON.stringify(tool?.processCapability ?? {});
  for (const marker of ['outcome_unknown', '禁止对裸 PID', 'exit receipt', 'RootBinding', 'getPaths']) if (!processText.includes(marker)) failures.push(`进程恢复合同缺少${marker}`);

  const output = tool?.processOutput;
  for (const field of ['maxChunkBytes', 'maxTerminalTailBytesPerStream', 'maxFlushDelayMs']) {
    if (!positiveInteger(output?.[field])) failures.push(`tool.processOutput.${field}必须是正整数`);
  }
  if (output?.contentStorage !== 'cas') failures.push('ProcessOutputChunk正文必须进入CAS');
  if ('maxRetainedBytesPerProcess' in (output ?? {}) || 'maxRetainedChunksPerProcess' in (output ?? {})) {
    failures.push('进程输出合同不得保留每进程总字节或总chunk截断');
  }
  if (!String(output?.retention ?? '').includes('没有每进程总字节或总chunk上限')) failures.push('进程输出必须完整保留而非总量截断');
  if (output?.registration?.keyset !== 'processId+chunkSeq' || !positiveInteger(output?.registration?.maxTransactionWireBytes)) {
    failures.push('进程输出登记必须按processId+chunkSeq keyset及事务wire bytes分批');
  }
  if (!positiveInteger(output?.readPages?.maxPageContentBytes) || !String(output?.readPages?.rule ?? '').includes('完整输出')) {
    failures.push('进程mode=output必须以可续页面完整遍历');
  }
  failures.push(...exactSetProblems('进程输出计数', ['retainedBytes', 'retainedChunks', 'droppedBytes', 'truncated'], output?.processCounters ?? []));

  if (tool?.mcpCapability?.releaseDecision !== 'keep-settings-rebuild-effect' || tool?.mcpCapability?.effectKind !== 'mcp_tool_call') failures.push('MCP必须保留设置并通过mcp_tool_call Effect执行');
  if (tool?.mcpCapability?.connectionState !== 'memory-only-rebuild-on-extension-host-start') failures.push('MCP连接状态必须只在内存并于宿主启动重建');
  const mcpText = JSON.stringify(tool?.mcpCapability ?? {});
  for (const marker of ['outcome_unknown', '不自动重试', 'ToolModelResult']) if (!mcpText.includes(marker)) failures.push(`MCP Effect合同缺少${marker}`);
  for (const marker of ["全来源拒绝'*'", '保存无列表记录时仍保留', '只有该Agent或工作流自己的sourceConfigs能开启', 'toolAllowedByPolicy', "'mcp:<来源id>/<原始工具名>'", 'allowedTools从不准入MCP工具', 'enabledTools白名单', '不是工具名数组时该来源按禁用处理']) {
    if (!String(tool?.mcpCapability?.sourceAdmission ?? '').includes(marker)) failures.push(`MCP来源准入合同缺少${marker}`);
  }
  const transferText = JSON.stringify(tool?.workEnvironmentTransferCapability ?? {});
  if (tool?.workEnvironmentTransferCapability?.effectKind !== 'file_transfer') failures.push('transfer必须通过file_transfer Effect执行');
  for (const marker of ['outcome_unknown', '禁止自动重试', 'enabled=false', 'rejected']) {
    if (!transferText.includes(marker)) failures.push(`transfer Effect合同缺少${marker}`);
  }

  const scans = objectArray(tool?.recoveryScan?.scans, 'tool.recoveryScan.scans', failures);
  failures.push(...exactSetProblems('recovery scan ID', RECOVERY_IDS, scans.map((entry) => entry.id)));
  for (const scan of scans) {
    if (scan.ownerStage !== RECOVERY_OWNER.get(scan.id)) failures.push(`${scan.id}.ownerStage必须是${RECOVERY_OWNER.get(scan.id)}`);
    nonEmptyString(scan.target, `${scan.id}.target`, failures);
    nonEmptyString(scan.action, `${scan.id}.action`, failures);
  }
  if (tool?.externalEffectPromise?.modelResultExactlyOnce !== true) failures.push('模型工具结果必须唯一');
  if (tool?.externalEffectPromise?.externalSideEffectExactlyOnce !== false) failures.push('不得承诺外部副作用严格只执行一次');
}

function validateFile(file, failures) {
  if (file?.threatModel !== 'trusted-single-user-local-plugin') failures.push('文件合同必须按单用户自用插件设定边界');
  if (file?.changeSet?.domain !== 'FileChangeSet' || file?.changeSet?.memberDomain !== 'FileChangeSetMember') failures.push('文件提案必须使用FileChangeSet和FileChangeSetMember');
  if (file?.changeSet?.onePerToolCall !== true) failures.push('一个文件工具调用只能有一个FileChangeSet');
  if (file?.changeSet?.modelResult !== false) failures.push('FileChangeSet不能是模型最终结果');
  if (file?.decision?.firstResponseWins !== true) failures.push('文件审批必须只接受第一个决定');
  if (file?.pathBoundary?.recursiveComponentSecurityWalk !== true) failures.push('规划读取与执行必须校验目标路径组成部分及规范化边界');
  if (file?.pathBoundary?.sameAccountMaliciousProcessProtection !== false || file?.apply?.externalWriterAtomicCas !== false) {
    failures.push('文件路径栅栏不得承诺防御同账户恶意进程或外部写入者的原子比较交换');
  }
  if (file?.apply?.automaticRollback !== false || file?.apply?.automaticRetry !== false) failures.push('文件修改不自动回滚或重试');
  if (file?.apply?.overwriteWithoutBaseCheck !== false) failures.push('替换文件前必须核对基础摘要');
  if (file?.unresolvedClosure?.recoveryScanId !== 'recovery.file-change-unresolved') failures.push('未决FileChangeSet必须绑定稳定recovery scan ID');
  for (const outcome of ['succeeded', 'failed', 'partial', 'conflict', 'cancelled', 'outcome_unknown']) {
    if (!(file?.receipt?.outcomes ?? []).includes(outcome)) failures.push(`FileMutationReceipt缺少${outcome}`);
  }
  if (file?.toolResult?.proposalIsFinal !== false || file?.toolResult?.oneToolModelResultPerToolCall !== true) failures.push('文件工具只能在审批和执行结束后生成唯一模型结果');
}

function validateContext(context, failures) {
  const requiredDomains = [
    'ContextSegment',
    'ContextSegmentSource',
    'ContextSequenceNode',
    'ContextSequenceRoot',
    'ConversationContextHeadLink',
    'ConversationContextHandleState',
  'ContextRootHandleCatalog',
    'ModelContextProjection',
    'ModelRequest',
    'ModelRequestMessageLink',
    'CompressionBlock',
    'CompressionBlockSource',
    'ModelStreamCheckpoint',
    'ModelStreamFence'
  ];
  failures.push(...exactSetProblems('上下文领域', requiredDomains, context?.domains ?? []));
  if (context?.segment?.content !== 'cas' || context?.segment?.immutable !== true || context?.segment?.identity !== 'source-occurrence') failures.push('上下文片段必须按来源出现建模、不可变并由CAS保存');
  if (context?.segment?.contentObjectDoesNotDefineSegmentIdentity !== true) failures.push('ContentObject不得定义ContextSegment身份');
  if (context?.segmentSources?.sourceIdentityUnique !== 'source_kind,source_id,source_revision UNIQUE') failures.push('ContextSegmentSource必须使用source tuple唯一键');
  if (context?.segment?.toolPairAtomic !== true) failures.push('工具调用和工具结果必须作为不可拆分片段');
  if (context?.persistentSequence?.firstReleaseShape !== 'persistent-parent-dag') failures.push('第一版上下文序列必须使用可分支persistent parent DAG');
  if (!String(context?.persistentSequence?.branching ?? '').includes('(parent_node_id,segment_id) UNIQUE')) failures.push('Context DAG必须使用parent+segment幂等唯一键');
  if (!String(context?.persistentSequence?.currentHead ?? '').includes('ConversationContextHeadLink')) failures.push('当前Context root必须由ConversationContextHeadLink显式表达');
  if (context?.persistentSequence?.rootRetention !== 'ContextSequenceRoot 与 ContextSequenceNode 首版保留到 runtime dataset reset，不在线删除') failures.push('Context root/node首版只能dataset reset删除');
  if (context?.persistentSequence?.fullPrefixStoredPerProjection !== false || context?.persistentSequence?.fullSourceLinksCopiedPerProjection !== false) failures.push('投影不得复制完整历史前缀或全部来源关系');
  if (context?.persistentSequence?.balancedTreeRequired !== false) failures.push('第一版不要求复杂平衡树');
  if (!(context?.persistentSequence?.root ?? []).includes('tailSegmentCount')) failures.push('Context root必须有tailSegmentCount');
  if (context?.projection?.fullPromptContent !== false) failures.push('ModelContextProjection不得保存完整提示词正文');
  if (context?.compression?.splitToolPair !== false) failures.push('压缩不能拆开工具调用和结果');
  if (context?.compression?.management?.legacyCompressionUpdate !== 'removed-no-in-place-title-or-summary-mutation') failures.push('CompressionUpdate不得原地修改摘要');
  if (!String(context?.compression?.management?.replace ?? '').includes('immutable CompressionBlock')) failures.push('压缩修改必须创建不可变replacement');
  const compressionForkOwnership = String(context?.compression?.forkOwnership ?? '');
  for (const marker of ['CompressionBlock 归属单个 Conversation', 'CompressionBlockSource', 'CompressionBlockObservationLink', '按 Conversation 选择恰好一个', '源对话删除不影响分支']) {
    if (!compressionForkOwnership.includes(marker)) failures.push(`压缩块分支归属规则缺少${marker}`);
  }
  for (const replaySource of ['ContextSequenceRoot', 'AuthoritySnapshot', 'immutable-model-request-recipe']) {
    if (!(context?.replay?.uses ?? []).includes(replaySource)) failures.push(`上下文重放缺少${replaySource}`);
  }
  if (context?.replay?.mutatesRuntime !== false || context?.replay?.readsCurrentConversationHistory !== false) failures.push('dry-run和历史重放不得修改运行事实或改读当前会话历史');

  failures.push(...exactSetProblems(
    'Conversation fork领域',
    ['ConversationReuseLink', 'ConversationBranchLink', 'ConversationOriginLink', 'ConversationProjectLink'],
    context?.conversationFork?.domains ?? []
  ));
  if (context?.conversationFork?.releaseDecision !== 'keep-relations-and-rebuild') failures.push('Conversation fork必须保留独立关系语义');
  if (context?.conversationFork?.legacyRunReference !== 'forbidden-use-source-turn-id-instead') failures.push('Conversation fork来源不得继续依赖Run');
  const forkHistoryRule = String(context?.conversationFork?.historyRule ?? '');
  for (const marker of ['只复制已终止轮次', 'ConversationForkRejectedError', '本 ToolCall 自己的来源行', '整轮可见消息', '全部 ModelRequest', '自己的 AuthoritySnapshot', '子 Agent 自己的轮次仍按其任务编译权限', '没有自己轮次的分支手动压缩时按分支当前设置编译', 'ModelContextProjection 重新挂到分支', 'compression.forkOwnership', '只保留先于切点的压缩', '改用压缩前的根', '可见消息全被删除或重试丢弃', '恰好含其保留部分的根', '分支用已有的不可变节点插入自己的历史根', '只有创建根在末尾之前被原地编辑改写', '切点永不延长', '追加在切点之后', '只检查分支自身的片段', '不参与 fork 身份与重放比较']) {
    if (!forkHistoryRule.includes(marker)) failures.push(`Conversation fork历史规则缺少${marker}`);
  }
  const forkSettingsRule = String(context?.conversationFork?.settingsRule ?? '');
  for (const marker of ['8 组作用域记录/链接', '工作流选择与工作环境链接', '只写入目标仍为空的槽位', 'fork 事务之前', '重放不再复制', 'ConversationForkRejectedError 永久拒绝', '分支点消息已被删除', '找不到已完成的历史', '删除该命令目标 id 下尚未提交分支的对话层设置', '清理失败只记日志', 'fork_conversation 工具调用只尝试一次，任何失败都在目标对话未建立时同样删除这些设置']) {
    if (!forkSettingsRule.includes(marker)) failures.push(`Conversation fork设置复制规则缺少${marker}`);
  }

  const continuation = context?.providerContinuation;
  if (continuation?.releaseDecision !== 'disabled-full-request' || continuation?.runtimeDomainRequired !== false) failures.push('ProviderContinuation首发必须禁用且不建运行领域');
  if (continuation?.disabledBehavior !== 'always-send-full-request') failures.push('禁用ProviderContinuation时必须始终发送完整请求');
  const disabledText = JSON.stringify(continuation?.disabledRules ?? []);
  for (const marker of ['完整请求', '不读取 ProviderContinuation', '不产生或发送 suffix']) if (!disabledText.includes(marker)) failures.push(`ProviderContinuation disabled规则缺少${marker}`);
  if (continuation?.runtimeProtocolNegotiation !== false) failures.push('ProviderContinuation不得引入运行时版本协商');
  if (continuation?.futureEnabledContract?.requiresContractRevision !== true) failures.push('未来启用ProviderContinuation必须修改机器合同');

  const retry = context?.providerRetry;
  if (
    retry?.automaticTransientRetry !== true
    || retry?.authority !== 'frozen-turn-authority+sqlite-model-request-attempt'
    || retry?.defaultMaxRetries !== 8
    || retry?.maxRetries !== 10
    || retry?.configuredPerFrozenAuthority !== true
    || retry?.visible !== true
    || retry?.visibleWhenTransientThoughtExists !== true
    || retry?.cancelable !== true
    || retry?.afterExtensionRestart !== 'resume-committed-retry-with-not-before-deadline'
    || retry?.newAttemptKeepsSameModelRequest !== true
  ) failures.push('模型提供方必须使用冻结Authority下有界、可见、可取消、可重启恢复的持久重试');
  if (JSON.stringify(retry?.backoffMilliseconds) !== JSON.stringify([500, 1000, 2000, 4000, 8000, 16000, 30000])) failures.push('模型提供方重试退避合同不匹配');
  if (JSON.stringify(retry?.semanticDeadlinesMilliseconds) !== JSON.stringify({ ordinaryFirst: 300000, ordinaryIdle: 600000, compressionCompletion: 270000 })) failures.push('模型提供方普通语义/压缩终态deadline合同不匹配');
  for (const field of ['ordinaryTransactionMayHashFullHistory', 'ordinaryTransactionMayRewriteFullHistory', 'clientMayDeepCloneFullHistory']) {
    if (context?.performance?.[field] !== false) failures.push(`context.performance.${field}必须为false`);
  }
}

function validateSubagent(subagent, failures) {
  const toolBoundary = String(subagent?.spawn?.toolBoundary ?? '');
  for (const marker of ['parent-Turn-policy-frozen-at-spawn(toolPolicy.inherited', 'reuse-the-spawn-Turn-bound', 'built-in-tools-need-both-lists-without-exception',
    'a-source-the-parent-never-enabled-stays-off', 'maxChildAgentDepth-takes-the-minimum', 'only-when-every-ancestor-agrees', 'yolo-loosens-only-its-own-level',
    'a-disabled-skill-can-be-neither-listed-nor-loaded', 'including-Turns-the-user-starts-in-the-child-conversation',
    'model-spawned-children-only-narrow', 'a-Plan-the-user-approves-to-run-in-a-new-conversation', 'authorityBound-executor_agent',
    'global-and-its-own-scopes-still-narrow', 'only-when-its-own-settings-allow-it', 'keeps-the-planning-Turn-model-fallback-and-child-thinking-inheritance']) {
    if (!toolBoundary.includes(marker)) failures.push(`子Agent工具边界规则缺少${marker}`);
  }
  const skillPreload = String(subagent?.spawn?.skillPreload ?? '');
  for (const marker of ['resolved-within-the-skill-settings-frozen-for-the-child-first-Turn', 'fails-the-spawn-before-any-fact-is-written',
    'lead-the-child-first-input-MessageRevision-in-CAS', 'never-read-skills-again']) {
    if (!skillPreload.includes(marker)) failures.push(`子Agent预载技能规则缺少${marker}`);
  }
  const collaboration = subagent?.collaboration;
  if (collaboration?.teamScope !== 'derive-root-conversation-from-ChildExecutionParentLink-no-team-table'
    || collaboration?.messageAuthority !== 'peer-tool-output-never-user-or-developer-authorization'
    || collaboration?.delivery !== 'reuse-RuntimeInboxItem-RuntimeDelivery-RuntimeDeliveryInputLink-RuntimeDeliveryWake'
    || collaboration?.sendMessage !== 'persist-message-and-delivery; active-target-consumes-at-safe-boundary; a-team-message-to-a-target-without-a-running-Turn-commits-a-wake-that-opens-one-Turn-per-idle-period-which-takes-in-everything-pending; a-message-from-a-child-task-Turn-to-the-parent-it-answers-never-wakes-it; every-Turn-a-wake-opens-spends-the-automatic-followup-budget-checked-and-counted-in-the-transaction-that-commits-its-continuation(a-message-as-a-delivery_wake-charge-row-of-its-sender-budget); a-spent-budget-opens-no-Turn-and-the-message-waits-for-the-next-Turn; cross-conversation-sends-instead-queue-behind-the-running-Turn-see-crossConversation.delivery'
    || collaboration?.followupTask !== 'explicit-request-may-wake-idle-or-join-active; never-implicitly-cancel'
    || collaboration?.board?.offering !== 'not-offered-to-models-in-phase-one; agent_board-is-not-in-the-builtin-tool-registry; domain-and-control-plane-code-retained'
    || collaboration?.board?.scope !== 'existing-root-conversation-no-membership-authority'
    || collaboration?.board?.notification !== 'active-subscribers-only; no-idle-wake') {
    failures.push('协作必须复用稳定父树与可靠投递，区分静默消息和显式唤醒，并保留工具来源权限');
  }
  failures.push(...exactSetProblems('协作消息领域', [
    'CollaborationMessage', 'CollaborationMessageSourceLink', 'CollaborationMessageTargetLink',
    'CollaborationMessagePayloadLink', 'CollaborationMessageReplyLink', 'CollaborationBudget', 'CollaborationRequest',
    'CollaborationRequestTurnLink'
  ], collaboration?.messageDomains ?? []));
  failures.push(...exactSetProblems('协作留言板领域', [
    'CollaborationBoardChannel', 'CollaborationBoardChannelScopeLink', 'CollaborationBoardPost',
    'CollaborationBoardPostChannelLink', 'CollaborationBoardPostSourceLink', 'CollaborationBoardReplyLink',
    'CollaborationBoardSubscriptionLink', 'CollaborationBoardCommandReceipt'
  ], collaboration?.board?.domains ?? []));
  failures.push(...exactSetProblems('子Agent上下文分叉模式', ['none', 'all', 'positive-integer-string'], collaboration?.forkTurns ?? []));
  if (collaboration?.forkAuthority !== 'completed-committed-context-only; no-active-turn-no-child-control-links-no-lease-or-ownership-copy; copied-Turns-own-copies-of-their-historical-AuthoritySnapshot; the-child-own-Turns-compile-authority-from-its-assignment') {
    failures.push('子Agent上下文分叉只复制已完成历史：复制的轮次持有其历史 AuthoritySnapshot 副本，子 Agent 自己的轮次按任务编译权限');
  }
  const crossConversation = collaboration?.crossConversation;
  if (crossConversation?.switch !== 'ToolPolicy.toolConfigs.run_agent.config.crossConversationCollaboration; boolean; default-off; non-boolean-fails-closed; frozen-in-Turn-authority; configSchema-defaultValue-only'
    || crossConversation?.offering !== 'top-level-conversations-only; hidden-and-rejected-when-switch-off; control-plane-rechecks-calling-Turn-frozen-authority'
    || crossConversation?.targets !== 'other-active-top-level-conversations-of-the-caller-project-by-ConversationProjectLink; conversations-without-a-project-reach-only-each-other; child-task-conversations-never-listed-or-addressed'
    || crossConversation?.allowlist !== 'the-switch-is-the-grant; the-Turn-frozen-switch-alone-offers-and-admits-the-five-tools-in-top-level-conversations; send-create-and-fork-only-while-the-Turn-effective-allowedTools-include-run_agent(otherwise-list-and-read-only); no-tool-list-controls-them-and-their-names-in-saved-lists-are-ignored-by-the-resolver-and-dropped-by-the-next-settings-save; the-settings-switch-writes-only-its-own-value; no-per-tool-disable(the-switch-is-the-only-on-off-control); per-tool-autoApproveExecution-false-still-requires-confirmation; stored-crossConversationGrantedTools-fields-are-ignored-without-migration'
    || crossConversation?.delivery !== 'running-target-queues-behind-its-current-Turn; followup-starts-its-own-Turn-and-only-that-Turn-consumes-it; followup-waits-behind-any-running-Turn-at-dispatch-including-one-started-after-its-anchor; followups-from-different-senders-start-sequential-Turns-never-merged; queued-followups-start-in-send-order-by-the-CollaborationMessage.message_seq-their-send-transaction-assigned-never-by-timestamp; that-Turn-spends-only-the-requester-budget; message-joins-the-next-Turn-whatever-starts-it; completion-replies-join-a-running-requester-Turn-at-a-safe-boundary; a-cross-conversation-completion-or-failure-reply-to-an-idle-requester(also-after-a-user-stop)-starts-one-requester-Turn-that-spends-the-chain-automatic-followup-budget; with-the-budget-spent-the-reply-waits-for-the-next-Turn-without-error; team-replies-also-start-an-idle-requester-Turn-unless-a-child-task-Turn-replies-to-the-parent-it-answers; cross-conversation-plain-messages-start-no-Turn'
    || crossConversation?.authority !== 'peer-text-is-an-attributed-collaboration-envelope-sent-as-user-role-runtime-data-never-a-user-message; its-fixed-kernel-header-says-it-is-from-another-conversation-or-team-agent-not-this-conversation-user-and-untrusted; list-and-read-carry-an-untrusted-data-notice') {
    failures.push('跨对话协作必须由默认关闭的冻结开关下发，只给顶层对话，不寻址子 Agent，运行中目标排队，且对方文本不成为用户指令');
  }
  if (crossConversation?.approval !== 'send-type-tools-auto-approved-by-default; per-tool-autoApproveExecution-false-requires-confirmation') {
    failures.push('跨对话协作的发送类工具默认自动批准，可逐个要求确认');
  }
  if (crossConversation?.consent !== 'sender-only-authorization-as-in-Codex; the-target-has-no-switch-or-consent-check; defences-are-the-untrusted-data-envelope-and-peer-text-never-gaining-user-text-authority') {
    failures.push('跨对话协作只由发送方授权：目标方没有开关或确认检查，防线是不可信数据信封与对方文本不获得用户授权');
  }
  if (!String(crossConversation?.decisions ?? '').includes('a-cross-conversation-reply-starts-an-idle-requester-Turn-that-spends-and-continues-the-budget-of-the-request-it-answers')) {
    failures.push('跨对话回复须开启空闲请求方的一轮，并花费和沿用它所回复请求的预算');
  }
  const crossScope = String(crossConversation?.scope ?? '');
  for (const marker of ['the-project-bounds-list-read-send-and-fork', 'create_conversation-creates-in-the-caller-project', 'checked-by-the-control-plane-however-its-reference-was-obtained', 'another-project-is-refused']) {
    if (!crossScope.includes(marker)) failures.push(`跨对话项目范围规则缺少${marker}`);
  }
  const crossRead = String(crossConversation?.read ?? '');
  for (const marker of ['newest-first-page', 'stays-under-the-tool-result-cap', 'olderMessageRef-leads-to-them', 'read_conversation-with-R#-messageRef-and-offset-pages-it-whole', 'collaboration-inputs-a-Turn-took-in']) {
    if (!crossRead.includes(marker)) failures.push(`跨对话读取规则缺少${marker}`);
  }
  const readBudget = crossConversation?.readBudget;
  if (!Number.isSafeInteger(readBudget?.pageTokens) || !Number.isSafeInteger(readBudget?.messagePreviewTokens)
    || readBudget.messagePreviewTokens > readBudget.pageTokens) {
    failures.push('跨对话读取必须给出页预算与单条预览预算，单条不超过整页');
  }
  const messageText = collaboration?.messageText;
  const paging = String(messageText?.paging ?? '');
  const preview = String(messageText?.preview ?? '');
  if (!Number.isSafeInteger(messageText?.pageTokens) || !Number.isSafeInteger(messageText?.pageMaxCharacters)
    || !paging.includes('read_agent_messages-with-M#-messageRef-and-offset') || !paging.includes('following-nextOffset-until-null-returns-the-whole-text')
    || !preview.includes('marker-names-the-exact-call-read_agent_messages') || !preview.includes('recipientSeesPreview')) {
    failures.push('协作消息必须可按页读取全文，截断预览标出读取调用并告知发送方');
  }
  const crossCreate = String(crossConversation?.create ?? '');
  for (const marker of ['stable-Conversation-id-from-ToolCall', 'checked-before-any-write', 'commit-in-one-transaction', 'leaves-no-Conversation', 'replay-after-deletion-is-refused', 'refused-at-admission-clears-settings-a-crashed-attempt-left-only-when-a-read-finds-some', 'no-ConversationOriginLink']) {
    if (!crossCreate.includes(marker)) failures.push(`跨对话新建对话规则缺少${marker}`);
  }
  const crossFork = String(crossConversation?.fork ?? '');
  for (const marker of ['commandId-is-ToolCall', 'completed-history-up-to-the-last-ended-Turn', 'starts-no-Turn', 'replay-keeps-the-committed-boundary', 'never-navigates-the-view', 'hosted-by-another-window-is-refused-with-a-clear-error', 'any-failed-attempt-clears-copied-settings']) {
    if (!crossFork.includes(marker)) failures.push(`跨对话分支规则缺少${marker}`);
  }
  const inheritedRefs = String(crossConversation?.inheritedRefs ?? '');
  for (const marker of ['selfConversationRef', 'forkedFromConversationRefs', 'inheritedMessageRefs', 'fails-with-where-it-came-from']) {
    if (!inheritedRefs.includes(marker)) failures.push(`分支继承引用规则缺少${marker}`);
  }
  const crossLimits = crossConversation?.limits;
  if (!Number.isSafeInteger(crossLimits?.maxPendingInboundMessages) || crossLimits.maxPendingInboundMessages < 1
    || !Number.isSafeInteger(crossLimits?.maxConversationSpawnsPerTurn) || crossLimits.maxConversationSpawnsPerTurn < 1
    || crossLimits?.automaticFollowupBudget !== 'cross-conversation-followups-and-create_conversation-spend-maxAutomaticFollowups; checked-before-any-write; so-does-each-requester-Turn-a-cross-conversation-reply-starts-checked-in-its-admission-transaction'
    || crossLimits?.pendingInbound !== 'undelivered-message-and-followup-deliveries-from-any-sender-per-target; completion-replies-exempt; enforced-on-cross-conversation-sends'
    || crossLimits?.pendingInboundRefusal !== 'names-the-unread-count-and-that-no-message-or-followup-can-be-queued-until-the-target-takes-them-in-with-its-next-turn; suggests-no-retry'
    || crossLimits?.spawns !== 'create_conversation-and-fork_conversation-calls-of-one-sender-Turn-ranked-by-committed-call-order'
    || crossLimits?.overflow !== 'clear-tool-error; nothing-written; no-new-settings') {
    failures.push('跨对话协作必须复用自动续派预算并给出固定的积压与新建分支上限');
  }
  failures.push(...exactSetProblems('跨对话协作工具', ['list_conversations', 'read_conversation', 'send_conversation_message', 'create_conversation', 'fork_conversation'], crossConversation?.tools ?? []));
  failures.push(...exactSetProblems('跨对话协作只读工具', ['list_conversations', 'read_conversation'], crossConversation?.readonlyTools ?? []));
  if (!/null/.test(subagent?.delivery?.intentLink ?? '') || !/当前设置/.test(subagent?.delivery?.intentLink ?? '')) {
    failures.push('协作消息续跑必须记录 sourceTurnId 为 null 并按目标对话当前设置编译权限');
  }

  failures.push(...exactSetProblems('子Agent操作', ['spawn', 'send', 'wait', 'list', 'read', 'interrupt_subtree'], subagent?.operations ?? []));
  failures.push(...exactSetProblems('子Agent模型必填字段', ['operation'], subagent?.modelContract?.required ?? []));
  failures.push(...exactSetProblems('子Agent新建字段', ['taskName', 'prompt'], subagent?.modelContract?.spawnRequired ?? []));
  failures.push(...exactSetProblems('子Agent续派字段', ['childRef', 'prompt'], subagent?.modelContract?.sendRequired ?? []));
  if (subagent?.modelContract?.implicitSpawnAllowed !== false || subagent?.modelContract?.legacyModeAllowed !== false) {
    failures.push('子Agent必须显式选择操作，不能缺引用隐式新建或回退旧mode');
  }
  if (subagent?.assignmentProjection?.runtimeSchemaChangeRequired !== false
    || subagent?.assignmentProjection?.cardLimit !== 32) failures.push('子任务视图须复用现有Runtime事实并保持32条卡片上限');
  for (const operation of ['list', 'read']) {
    const contract = subagent?.[operation];
    if (contract?.readOnly !== true || contract?.pagination?.defaultLimit !== 32
      || contract?.pagination?.maximumLimit !== 100 || contract?.pagination?.maximumPageTokens !== 2600
      || contract?.pagination?.cursor !== true || contract?.pagination?.rereadCursor !== true) {
      failures.push(`子Agent ${operation}须提供只读、有界、可重读的分页合同`);
    }
  }
  if (subagent?.releaseDecisions?.interruptSubtree !== 'required-first-release') failures.push('interrupt_subtree必须是首发必选能力');
  failures.push(...exactSetProblems('ChildExecution lineage领域', [
    'ChildExecution',
    'ChildExecutionParentLink',
    'ChildExecutionTurnLink',
    'ChildExecutionIntentLink',
    'ChildExecutionActiveTurnLink',
    'ChildInterruptionRequest',
    'ChildInterruptionLineageLink',
    'ChildInterruptionTurnLink',
    'ChildInterruptionIntentLink'
  ], subagent?.lineage?.domains ?? []));
  const lineageText = JSON.stringify(subagent?.lineage ?? {});
  for (const marker of ['ChildExecutionParentLink', 'ActiveTurnLink 只表达当前活动 Turn', 'pending IntentLink']) {
    if (!lineageText.includes(marker)) failures.push(`ChildExecution lineage规则缺少${marker}`);
  }
  failures.push(...exactSetProblems('子Agent完成策略', ['wait_for_answer', 'background'], subagent?.spawn?.completionPolicies ?? []));
  if (subagent?.completionPolicyConsumption?.secondToolModelResultAllowed !== false) failures.push('子Agent切到后台后不得给原ToolCall生成第二个模型结果');
  failures.push(...exactSetProblems('子Agent发送方式', ['queue_next_turn', 'interrupt_current_turn'], subagent?.send?.modes ?? []));
  for (const storage of ['TurnIntent', 'PendingTurnInput']) if (!(subagent?.send?.storage ?? []).includes(storage)) failures.push(`子Agent追加信息必须进入${storage}`);
  if (subagent?.wait?.readOnly !== true || subagent?.wait?.changesDeliveryState !== false) failures.push('等待子Agent必须是只读操作');
  if (subagent?.answer?.oneCurrentSubmissionPerBridge !== true || subagent?.answer?.bridgeOwner !== 'ChildExecution') failures.push('AnswerBridge必须归属稳定ChildExecution且只有一个当前答案');
  failures.push(...exactSetProblems('交付阶段', ['current_turn', 'next_turn', 'notify_only'], subagent?.delivery?.phases ?? []));
  failures.push(...exactSetProblems('交付状态', ['pending', 'consumed', 'failed'], subagent?.delivery?.states ?? []));
  if (subagent?.delivery?.deadLetterQueue !== false) failures.push('第一版不建设独立死信队列');
  const deliveryText = JSON.stringify(subagent?.delivery ?? {});
  for (const marker of ['inbox_item_id,target_conversation_id,attempt_seq', 'attempt_seq+1', 'retry_of_delivery_id', '旧failed行不复活']) {
    if (!deliveryText.includes(marker)) failures.push(`subagent Delivery合同缺少${marker}`);
  }
  if (!subagent?.delivery?.historicalMerge?.includes('historical-merge-settled')) failures.push('合并前收尾必须登记既有停止与放弃转换的原因');
  if (subagent?.parentHandling?.deliveryConsumedMeansParentCompleted !== false) failures.push('答案送达不能冒充父Turn已经处理完成');
  if (subagent?.parentHandling?.source !== 'RuntimeDelivery.state + RuntimeDeliveryInputLink.handled_at') failures.push('parentHandling必须只读取对应InputLink.handled_at');
  if (subagent?.interrupt?.requestIsTerminal !== false) failures.push('发出终止请求不能冒充Turn已经结束');
  const cancelText = JSON.stringify(subagent?.interrupt ?? {});
  for (const marker of ['ChildExecutionParentLink', 'ActiveTurnLink', 'pending ChildExecutionIntentLink']) if (!cancelText.includes(marker)) failures.push(`interrupt_subtree规则缺少${marker}`);
  failures.push(...exactSetProblems('子Agent前端事实', ['childExecutionState', 'activeChildTurnState', 'answerSubmissionState', 'runtimeDeliveryState', 'parentHandlingState', 'terminationState'], subagent?.uiFacts ?? []));
  failures.push(...exactSetProblems('F recovery scan ID', F_RECOVERY_IDS, subagent?.recoveryOwnership?.scanIds ?? []));
  if (subagent?.recoveryOwnership?.stage !== 'F') failures.push('子代理recovery owner必须是F');
}

function validateClient(root, client, failures) {
  const history = client?.collaborationHistory;
  if (history?.authority !== 'RuntimeDeliveryTimelineLink+CollaborationSendTimelineLink; independent-Message-acceptance-relations'
    || history?.order !== 'physical-predecessor-message_seq-then-shared-exchange_seq; imported-order-explicit; no-clock-order'
    || history?.cursor !== 'exchange-beforeExchangeSeq-then-message-beforeMessageSeq+beforeId-then-answer-beforeCreatedAt+beforeId; independent-bounded-inventory-lanes'
    || history?.scan !== 'indexed-conversation-exchange-suffix; legacy-message-global-window; answer-conversation-created_at-id-index; no-unbounded-history-walk'
    || history?.peerTitle !== 'at-most-256-indexed-Message-memberships-per-placeholder-peer; fallback-to-stored-title'
    || history?.lostResponse !== 'collaboration-result-or-error-false-or-reject-reconnects-exact-session; renderer-deadline-clears-loading-and-allows-manual-retry'
    || history?.transport !== 'sessionId+requestId+conversationId+navigationGeneration-fenced; ACK-before-optional-read'
    || history?.view !== 'independent-bounded-card-rows; physical-membership-cut-not-display-floor; missing-proof-remains-explicitly-unlocated'
    || history?.merge !== 'historical-records-by-type-id; committed-live-records-win; no-duplicate-cards; reset-on-conversation-change'
    || history?.maxPageRows !== 200 || history?.maxScannedRows !== 4096
    || history?.maxPeerTitleMembershipRows !== 256
    || history?.maxRecordBytes !== 2048 || history?.maxPageBytes !== 524288) {
    failures.push('协作历史必须按独立持久序号有界分页、按请求和会话隔离、与实时记录去重合并');
  }
  failures.push(...exactSetProblems('协作历史因果闭包', [
    'RuntimeDeliveryTimelineLink',
    'CollaborationSendTimelineLink',
    'RuntimeDeliveryAnswerPresentation',
    'CollaborationMessage',
    'CollaborationMessageSourceLink',
    'CollaborationMessageTargetLink',
    'RuntimeDelivery(canonical-accepted-and-latest-attempt)',
    'RuntimeInboxItem',
    'AnswerSubmission',
    'AnswerBridge',
    'ChildExecution',
    'ChildExecutionParentLink',
    'Turn(own-conversation)',
    'CollaborationPeerConversation'
  ], history?.closure ?? []));
  const collaboration = client?.collaborationProjection;
  if (collaboration?.scope !== 'selected-conversation-source-or-target-only'
    || collaboration?.snapshotSelection !== 'bounded-accepted-exchange-suffix-plus-loaded-Turn-envelopes-and-bounded-pending-failed-inventory; canonical-accepted-attempt-closure'
    || collaboration?.messageBodiesInFeed !== false || collaboration?.boardBodiesInFeed !== false
    || collaboration?.messagePreview !== 'CollaborationMessage-envelope-carries-whitespace-normalized-text_preview-of-at-most-320-characters; full-body-only-through-explicit-read') {
    failures.push('协作前端投影必须有界、仅属于当前会话并按需读取正文');
  }
  const peerRule = String(collaboration?.peerConversations ?? '');
  for (const marker of ['collaborationPeerConversations', 'display_title', 'status-deleted', 'missing-peer-as-unknown']) {
    if (!peerRule.includes(marker)) failures.push(`协作对方对话投影缺少${marker}`);
  }
  const deliveryRule = String(collaboration?.deliveryState ?? '');
  for (const marker of ['RuntimeDelivery-of-its-loaded-outgoing-messages', 'newest-attempt', 'failed-incoming-stays-visible']) {
    if (!deliveryRule.includes(marker)) failures.push(`协作卡片投递状态缺少${marker}`);
  }

  if (client?.persistence?.clientChangeLog !== false || client?.persistence?.clientCommitTables !== false) failures.push('第一版不得持久化前端变更日志或提交表');
  if (client?.persistence?.sessionState !== 'memory-only') failures.push('前端同步会话必须只在内存中');
  if (client?.crossHostSynchronization?.detection !== 'sqlite-externalDataVersion'
    || client?.crossHostSynchronization?.projection !== 'bounded-snapshot-required-on-external-change'
    || client?.crossHostSynchronization?.backgroundWake !== 'persistent-RuntimeDeliveryWake-owner-routed-level-scan'
    || client?.crossHostSynchronization?.daemonRequired !== false) {
    failures.push('跨宿主同步必须检测外部 SQLite 提交并使用有界快照及归属路由的持久唤醒');
  }
  if (client?.conversationViews?.mainChat !== 'single-flight-open-and-focus-existing-per-host'
    || client?.conversationViews?.foreignOwner !== 'reject-only-the-occupied-conversation'
    || client?.conversationViews?.lastViewClosed !== 'release-only-after-runtime-work-and-command-pins-settle') {
    failures.push('主聊天页按对话去重，跨宿主只拒绝被占用对话，关闭视图不得释放未收尾工作');
  }
  if (client?.session?.maxInflightDataMessages !== 1) failures.push('同一前端会话只能有一个数据包在途');
  for (const field of ['maxQueuedBatches', 'maxQueuedBytes']) if (!positiveInteger(client?.session?.[field])) failures.push(`client.session.${field}必须是正整数`);
  if (client?.session?.snapshotRequiredCoalesced !== true) failures.push('snapshot-required必须合并为单一控制状态');
  const queueOverflowRule = String(client?.session?.queueOverflowRule ?? '');
  if (
    !queueOverflowRule.includes('压缩')
    || !queueOverflowRule.includes('仍越过')
    || !queueOverflowRule.includes('丢弃')
    || !queueOverflowRule.includes('snapshot-required')
  ) failures.push('Client queue必须先压缩未发送净变化，仍超限才丢弃普通changes并转snapshot-required');
  failures.push(...exactSetProblems('Client session字段', ['sessionId', 'hostBootId', 'nextMessageSeq', 'inflightMessageSeq?', 'lastAckedCommitSeq?', 'snapshotRequired'], client?.session?.fields ?? []));
  if (client?.sequence?.persistenceAcrossHostRestart !== false || client?.sequence?.wireType !== 'decimal-integer-string') failures.push('commitSeq只能在hostBoot内单调并用十进制整数字符串传输');

  const snapshot = client?.snapshot;
  if (snapshot?.windowRecordSummaryMaxBytes !== 2048 || snapshot?.modelRequestSummaryMaxBytes !== 32768) {
    failures.push('普通窗口摘要须保持 2 KiB，ModelRequest 结构化计量摘要须有独立 32 KiB 硬上限');
  }
  const metricSummaryRule = String(snapshot?.modelRequestSummaryRule ?? '');
  for (const marker of ['usage_json', 'stream_stats_json', '最多 8', '不得截断', '显式失败', 'snapshot/changes/history']) {
    if (!metricSummaryRule.includes(marker)) failures.push(`ModelRequest 计量摘要合同缺少${marker}`);
  }
  if (!positiveInteger(snapshot?.messageWindowLimit) || !positiveInteger(snapshot?.activeRecordLimitPerType) || !positiveInteger(snapshot?.maxBytes)) failures.push('前端首屏必须有明确正整数上限');
  failures.push(...exactSetProblems('snapshot字段', ['sessionId', 'hostBootId', 'snapshotCommitSeq', 'projections'], snapshot?.fields ?? []));
  if (snapshot?.includesFullContextHistory !== false || snapshot?.includesLargeToolContent !== false) failures.push('首屏快照不得携带完整上下文或大工具正文');

  const changes = client?.changes;
  if (
    changes?.source !== 'committed-transaction-result'
    || changes?.oneBatchPerDatabaseCommit !== false
    || changes?.unsentCommitRangeCompaction !== true
    || changes?.oneCommitOneAtomicBatch !== true
  ) failures.push('前端变化必须来自已提交事务；单commit不可拆分，未发送commit range必须允许净变化压缩');
  failures.push(...exactSetProblems('changes字段', ['sessionId', 'hostBootId', 'commitSeq', 'changes'], changes?.fields ?? []));
  for (const field of ['maxChangeBatchRecords', 'maxChangeBatchBytes']) if (!positiveInteger(changes?.[field])) failures.push(`client.changes.${field}必须是正整数`);
  if (!String(changes?.pendingSequenceRule ?? '').includes('不分配messageSeq') || !String(changes?.pendingSequenceRule ?? '').includes('空洞')) failures.push('未发送changes不得提前占用messageSeq或因压缩制造wire gap');
  if (!String(changes?.singleCommitOverflowRule ?? '').includes('不拆分') || !String(changes?.singleCommitOverflowRule ?? '').includes('snapshot-required')) failures.push('单commit超限必须保持原子并转snapshot-required');
  if (!String(changes?.queueOverflowRule ?? '').includes('先合并') || !String(changes?.queueOverflowRule ?? '').includes('仍超限')) failures.push('changes queue合同必须先合并共享ACK基线，仍超限才snapshot');
  if (client?.snapshotFeedHandoff?.mode !== 'atomic-commit-seq-barrier') failures.push('snapshot→changes必须使用commitSeq原子barrier');
  if (client?.snapshotFeedHandoff?.persistentClientChangeLog !== false) failures.push('snapshot/feed barrier不得引入持久ClientChangeLog');
  const handoffText = JSON.stringify(client?.snapshotFeedHandoff ?? {});
  for (const marker of ['snapshotCommitSeq', 'commitSeq', '不得遗漏']) if (!handoffText.includes(marker)) failures.push(`snapshot/feed handoff缺少${marker}`);

  const pagination = client?.pagination;
  if (pagination?.mode !== 'keyset' || pagination?.offsetAllowed !== false || pagination?.frozenRowsAllowed !== false) failures.push('历史读取必须使用键集分页，不能使用offset或冻结整页行');
  if (!positiveInteger(pagination?.maxPageRows) || !positiveInteger(pagination?.maxPageBytes)) failures.push('分页必须有行数和字节上限');
  if (pagination?.appliesTo !== 'sortIdRegistry-keyset-pages') failures.push('键集分页规则必须只约束sortIdRegistry登记的Feed分页');
  failures.push(...exactSetProblems('键集分页排除的独立分页', ['conversationHistoryPagination'], pagination?.notApplicableTo ?? []));
  validateConversationHistoryPagination(root, client?.conversationHistoryPagination, failures);
  if (client?.rendering?.largeLists !== 'virtual-or-segmented' || client?.rendering?.messageHistory !== 'virtual-or-segmented') failures.push('前端大列表和消息历史必须虚拟滚动或分段渲染');
  if (client?.rendering?.customScrollbar !== 'AdvancedScrollbar') failures.push('前端滚动区域必须复用AdvancedScrollbar');
  if (client?.bridgePayload?.structuredClonePlainDataOnly !== true) failures.push('Bridge载荷必须是可结构化克隆的纯数据');
  for (const surface of ['runtime-sqlite', 'cas', 'ordinary-client-state', 'log', 'error', 'vsix']) {
    if (!(client?.secrets?.forbidden ?? []).includes(surface)) failures.push(`密钥禁止面缺少${surface}`);
  }
}

/**
 * The sidebar conversation list is a separate page-number pagination: bounded OFFSET inside the
 * window, keyset boundaries beyond it. The window must equal the constant the projection enforces.
 */
function validateConversationHistoryPagination(root, history, failures) {
  if (history?.surface !== 'sidebar-conversation-history-list; ConversationHistoryPageRecord'
    || history?.mode !== 'page-number'
    || history?.order !== 'Conversation.updated_at+id-desc; mutable-sort-key'
    || history?.partition !== 'every-read-returns-the-exact-slice-of-the-current-order; adjacent-pages-never-repeat-or-skip-rows'
    || history?.offsetAllowed !== true
    || history?.maxOffsetRows !== 10000
    || history?.offsetRule !== 'bounded-OFFSET-only-when-rows-before-the-page<=maxOffsetRows'
    || history?.beyondOffsetWindow !== 'keyset-boundary-from|after|before-on-updated_at+id; last-page-read-upward-from-the-end; approximate-under-concurrent-change'
    || history?.clamp !== 'requested-page-clamped-to-the-current-last-page-inside-one-read-transaction; one-projection-read-per-request'
    || history?.cursor !== 'pageIndex+optional-boundary+scopeKey+pageSize+dataSetId:rootInstanceId:rootGeneration; no-commitSeq; no-trail'
    || history?.dataSetMismatch !== 'restart-at-first-page'
    || history?.refresh !== 'host-resends-the-backend-returned-pageInfo.cursor; foreign-commits-keep-the-page-number'
    || history?.localActionReveal !== 'this-window-create-fork-or-command-whose-commit-refreshes-the-Conversation-row(input,steer,queued-guidance,stop,retry,edit,edit-and-run,delete-message,manual-compression-at-admission,answer,rename)-in-the-shown-scope-returns-to-the-first-page; replays-and-commands-leaving-the-row-keep-the-page; other-project-actions-never-move-a-project-page'
    || history?.total !== 'exact-scope-count; project-count-via-ProjectContext.uri-and-ConversationProjectLink.project_context_id-indexes'
    || history?.frozenRowsAllowed !== false
    || history?.maxPageRows !== 200) {
    failures.push('侧栏会话历史必须按页码定位：有界OFFSET窗口外用键集边界，各页为当前排序精确划分，游标只绑定页码与数据集身份');
  }
  const projection = readText(path.join(root, 'backend/reliableKernel/clientProjection.ts'));
  const windowRows = /export const CONVERSATION_HISTORY_EXACT_OFFSET_ROWS = ([\d_]+);/.exec(projection)?.[1];
  if (windowRows === undefined || Number(windowRows.replaceAll('_', '')) !== history?.maxOffsetRows) {
    failures.push('侧栏会话历史的OFFSET窗口必须与clientProjection.ts的CONVERSATION_HISTORY_EXACT_OFFSET_ROWS一致');
  }
}

function validateTargets(targets, registry, failures) {
  if (targets?.usage !== 'single-user-local' || targets?.distribution !== 'manual-vsix') failures.push('目标只允许单用户本机手动VSIX');
  failures.push(...exactSetProblems('安装包要求出口', ['installed'], targets?.validation?.requiredAt ?? []));
  if (targets?.localTarget?.platform !== 'linux' || targets?.localTarget?.arch !== 'x64') failures.push('本机性能基线目标必须保持Linux x64');
  const artifactTargets = objectArray(targets?.artifactTargets, 'targets.artifactTargets', failures);
  failures.push(...exactSetProblems(
    'VSIX制品目标',
    ['local-linux-x64', 'local-win32-x64', 'local-darwin-x64', 'local-darwin-arm64'],
    artifactTargets.map((entry) => entry.id)
  ));
  const supportedArtifactTargets = new Set([
    'linux/x64',
    'win32/x64',
    'darwin/x64',
    'darwin/arm64'
  ]);
  for (const target of artifactTargets) {
    if (!supportedArtifactTargets.has(`${target.platform}/${target.arch}`)) {
      failures.push(`VSIX制品目标无效：${target.id ?? '<missing>'}`);
    }
    if (target.extensionHostKind !== 'local') failures.push(`VSIX制品目标必须是本地Extension Host：${target.id ?? '<missing>'}`);
  }
  if ((targets?.unsupported ?? []).includes('windows')) failures.push('Windows已是正式VSIX目标，不能继续列为unsupported');
  const buildProvenance = targets?.validation?.buildProvenance;
  for (const field of ['commitSha', 'mainEntrySha256', 'worktreeClean']) if (!(buildProvenance?.fields ?? []).includes(field)) failures.push(`构建来源缺少${field}`);
  if (buildProvenance?.mainEntrySource !== 'VSIX内package.json.main') failures.push('制品校验必须从VSIX内package.json.main解析真实入口');
  const cleanlinessSource = String(buildProvenance?.worktreeCleanSource ?? '');
  for (const marker of ['git status', '--porcelain', '--untracked-files=all']) if (!cleanlinessSource.includes(marker)) failures.push(`构建时洁净来源缺少${marker}`);
  for (const marker of ['重算', 'SHA-256', 'worktreeClean']) {
    if (!String(buildProvenance?.packageVerification ?? '').includes(marker)) failures.push(`VSIX provenance验证缺少${marker}`);
  }
  const smoke = objectArray(targets?.validation?.smoke, 'targets.validation.smoke', failures);
  failures.push(...exactSetProblems('installed smoke ID', SMOKE_IDS, smoke.map((entry) => entry.id)));
  for (const entry of smoke) {
    nonEmptyString(entry.description, `${entry.id}.description`, failures);
    nonEmptyStringArray(entry.steps, `${entry.id}.steps`, failures);
    nonEmptyStringArray(entry.assertions, `${entry.id}.assertions`, failures);
  }
  const packageChecks = registry?.validatorGroups?.find((entry) => entry.id === 'package')?.checks ?? [];
  const smokeRefs = packageChecks.filter((entry) => String(entry.id).startsWith('package.smoke.')).map((entry) => entry.contractRef);
  failures.push(...exactSetProblems('package smoke contractRef', SMOKE_IDS, smokeRefs));
}

function validateTransitionLedger(root, ledger, failures) {
  if (ledger?.compatibilityAdaptersAllowed !== false) failures.push('过渡清单不得允许兼容适配器');
  const entries = objectArray(ledger?.entries, 'transition-ledger.entries', failures);
  uniqueStrings(entries.map((entry) => entry.key), '过渡条目', failures);
  const allowedDispositions = new Set(['replace-and-delete', 'split-and-delete', 'delete']);
  for (const entry of entries) {
    if ('ownerStage' in entry) failures.push(`${entry.key}不得再用ownerStage混合replacement/delete语义`);
    if (!STAGES.includes(entry.replacementStage)) failures.push(`${entry.key}.replacementStage无效`);
    if (entry.deleteStage !== 'G') failures.push(`${entry.key}.deleteStage必须是G`);
    if (!allowedDispositions.has(entry.disposition)) failures.push(`${entry.key}.disposition无效`);
    nonEmptyString(entry.replacement, `${entry.key}.replacement`, failures);
    if (entry.deletedAtCommit || entry['deleted-at-commit']) {
      nonEmptyString(entry.deletedAtCommit ?? entry['deleted-at-commit'], `${entry.key}.deletedAtCommit`, failures);
      continue;
    }
    const relativePath = entry.selector?.path;
    const symbol = entry.selector?.symbol;
    nonEmptyString(relativePath, `${entry.key}.selector.path`, failures);
    nonEmptyString(symbol, `${entry.key}.selector.symbol`, failures);
    if (!relativePath || !symbol) continue;
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      if (ledger.status !== 'active') failures.push(`${entry.key}定位文件不存在：${relativePath}`);
      continue;
    }
    const source = readText(absolutePath);
    if (!source.includes(symbol)) {
      if (ledger.status !== 'active') failures.push(`${entry.key}定位符号不存在：${symbol}`);
      continue;
    }
    if (entry.selector.member && !source.includes(entry.selector.member) && ledger.status !== 'active') {
      failures.push(`${entry.key}定位成员不存在：${entry.selector.member}`);
    }
  }
  const requiredKeys = ['conversation-fork-link-cohort', 'mcp-direct-runtime-execution', 'mutable-compression-update', 'agent-system-scope-kind'];
  for (const key of requiredKeys) if (!entries.some((entry) => entry.key === key)) failures.push(`transition ledger缺少能力去向${key}`);
}

function validateCrossContract(documents, failures) {
  const authority = documents['authority.json'];
  const context = documents['context.json'];
  const subagent = documents['subagent.json'];
  const tool = documents['tool.json'];
  const identity = documents['identity.json'];
  const domainSet = new Set((authority.runtimeDomains ?? []).map((entry) => entry.key));
  for (const domain of context.domains ?? []) if (!domainSet.has(domain)) failures.push(`context领域未进入authority runtimeDomains：${domain}`);
  for (const domain of context.conversationFork?.domains ?? []) if (!domainSet.has(domain)) failures.push(`fork领域未进入authority runtimeDomains：${domain}`);
  for (const domain of subagent.lineage?.domains ?? []) if (!domainSet.has(domain)) failures.push(`subagent lineage领域未进入authority runtimeDomains：${domain}`);
  for (const domain of subagent.answer?.domains ?? []) if (!domainSet.has(domain)) failures.push(`subagent answer领域未进入authority runtimeDomains：${domain}`);
  for (const domain of subagent.delivery?.domains ?? []) if (!domainSet.has(domain)) failures.push(`subagent delivery领域未进入authority runtimeDomains：${domain}`);
  for (const domain of [...(subagent.collaboration?.messageDomains ?? []), ...(subagent.collaboration?.board?.domains ?? [])]) {
    if (!domainSet.has(domain)) failures.push(`collaboration领域未进入authority runtimeDomains：${domain}`);
  }
  if (context.providerContinuation?.runtimeDomainRequired === false && domainSet.has('ProviderContinuation')) failures.push('ProviderContinuation禁用时authority不得建表');
  failures.push(...exactSetProblems('tool/identity recovery ID', tool.recoveryScan?.scans?.map((entry) => entry.id) ?? [], identity.recoveryScan?.scanIds ?? []));
  const effectKinds = new Set(tool.effectIntent?.effectKinds ?? []);
  if (tool.mcpCapability?.effectKind && !effectKinds.has(tool.mcpCapability.effectKind)) failures.push('MCP effectKind未进入EffectIntent全集');
  if (tool.workEnvironmentTransferCapability?.effectKind && !effectKinds.has(tool.workEnvironmentTransferCapability.effectKind)) failures.push('transfer effectKind未进入EffectIntent全集');
  const candidateChecks = new Set(documents['gate-registry.json']?.validatorGroups?.find((entry) => entry.id === 'candidate')?.checks?.map((entry) => entry.id) ?? []);
  for (const required of [
    'candidate.context-compression-node-bound',
    'candidate.provider-continuation-disabled-full-request',
    'candidate.process-wrapper-recovery',
    'candidate.process-output-bounds',
    'candidate.mcp-effect-recovery',
    'candidate.conversation-fork-links',
    'candidate.compression-immutable-replacement'
  ]) if (!candidateChecks.has(required)) failures.push(`candidate gate缺少冻结能力检查${required}`);
}

function validateHumanPlanMarkers(root, failures) {
  const read = (relative) => readText(path.join(root, relative));
  const readme = read('docs/architecture/reliable-kernel/README.md');
  if (!readme.includes(CONTRACT_REVISION)) failures.push(`可靠内核README必须标记合同修订${CONTRACT_REVISION}`);
  // The contracts README headline names the base revision and every file revised after it, each
  // next to its own file, so a reader never takes a newer contract for the base one.
  const contractsHeadline = read('docs/architecture/reliable-kernel/contracts/README.md')
    .split(/\r?\n/).find((line) => line.startsWith('>')) ?? '';
  if (!contractsHeadline.includes(`基础合同修订：\`${CONTRACT_REVISION}\``)) {
    failures.push(`合同README首行必须标记基础合同修订${CONTRACT_REVISION}`);
  }
  for (const [file, revision] of FILE_CONTRACT_REVISIONS) {
    if (!contractsHeadline.includes(`\`${file}\`：\`${revision}\``)) failures.push(`合同README首行必须标记${file}修订${revision}`);
  }
  if (readme.includes('AnswerBridge / ChildTurnLink')) failures.push('README仍把ChildTurnLink写成目标模型');
  for (const marker of ['ChildExecution', 'disabled-full-request', 'detached wrapper', 'mcp_tool_call']) {
    if (!readme.includes(marker)) failures.push(`README缺少r4冻结口径：${marker}`);
  }
  const phaseD = read('docs/architecture/reliable-kernel/phases/phase-d-effects-tools-files-processes.md');
  for (const id of RECOVERY_IDS.filter((value) => RECOVERY_OWNER.get(value) === 'D')) if (!phaseD.includes(id)) failures.push(`Phase D缺少owner recovery ID：${id}`);
  for (const id of F_RECOVERY_IDS) if (phaseD.includes(id)) failures.push(`Phase D不得声明拥有F recovery ID：${id}`);
  const phaseF = read('docs/architecture/reliable-kernel/phases/phase-f-subagent-client.md');
  for (const id of F_RECOVERY_IDS) if (!phaseF.includes(id)) failures.push(`Phase F缺少owner recovery ID：${id}`);
  const phaseG = read('docs/architecture/reliable-kernel/phases/phase-g-hard-cut-release.md');
  for (const marker of ['cutover-only coordinator', 'smoke.file-proposal-approve-apply', 'smoke.turn-interrupt']) if (!phaseG.includes(marker)) failures.push(`Phase G缺少r4硬切口径：${marker}`);
}

function requireDomainIndex(domains, key, index, failures) {
  const domain = domains.find((entry) => entry.key === key);
  if (!domain || !(domain.indexes ?? []).includes(index)) failures.push(`${key}缺少索引${index}`);
}

function forbidDomainIndex(domains, key, index, failures) {
  const domain = domains.find((entry) => entry.key === key);
  if ((domain?.indexes ?? []).includes(index)) failures.push(`${key}不得使用索引${index}`);
}

function parseIdentifierConstArray(source, name) {
  const body = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source)?.[1];
  if (!body) return [];
  return [...body.matchAll(/\b[A-Z][A-Z0-9_]+\b/g)].map((match) => match[0]);
}

function parseQuotedConstArray(source, name) {
  const body = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source)?.[1];
  if (!body) return [];
  return [...body.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectArray(value, label, failures) {
  if (!Array.isArray(value) || value.some((entry) => !plainObject(entry))) {
    failures.push(`${label}必须是对象数组`);
    return [];
  }
  return value;
}

function stringArray(value, label, failures) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    failures.push(`${label}必须是字符串数组`);
    return [];
  }
  return value;
}

function nonEmptyStringArray(value, label, failures) {
  const result = stringArray(value, label, failures);
  if (result.length === 0 || result.some((entry) => entry.length === 0)) failures.push(`${label}不能为空`);
  return result;
}

function nonEmptyString(value, label, failures) {
  if (typeof value !== 'string' || value.length === 0) failures.push(`${label}必须是非空字符串`);
}

function uniqueStrings(values, label, failures) {
  const filtered = values.filter((value) => typeof value === 'string');
  if (new Set(filtered).size !== filtered.length) failures.push(`${label}存在重复值`);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}
