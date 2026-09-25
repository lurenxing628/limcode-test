import fs from 'node:fs';
import path from 'node:path';

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
const CLIENT_FEED_CONTRACT_REVISION = '2026-09-24-r5';
const SUBAGENT_CONTRACT_REVISION = '2026-09-22-r5';
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
  'CollaborationBoardCommandReceipt'
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
    JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))
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
  validateIdentity(documents['identity.json'], failures);
  validateTool(documents['tool.json'], failures);
  validateFile(documents['file.json'], failures);
  validateContext(documents['context.json'], failures);
  validateSubagent(documents['subagent.json'], failures);
  validateClient(documents['client-feed.json'], failures);
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
    const expectedRevision = file === 'client-feed.json' ? CLIENT_FEED_CONTRACT_REVISION
      : file === 'subagent.json' ? SUBAGENT_CONTRACT_REVISION : CONTRACT_REVISION;
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
    const source = fs.readFileSync(absolute, 'utf8');
    if (!source.includes('new Map(') || !source.includes('.get(check.id)')) failures.push(`${group.id}校验器必须使用Map<checkId,handler>`);
    if (source.includes('matches(check)') || source.includes('.find(([matches])')) failures.push(`${group.id}校验器不得按description谓词匹配handler`);
    if (group.id !== 'plan' && !source.includes('PENDING:')) failures.push(`${group.id}校验器必须诚实输出PENDING`);
  }
  const packageSource = fs.readFileSync(path.join(root, 'scripts/reliable-kernel/validators/package.mjs'), 'utf8');
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
  const generatorSource = fs.readFileSync(path.join(root, 'scripts/reliable-kernel/write-build-provenance.mjs'), 'utf8');
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
  failures.push(...exactSetProblems('精确升级前驱', [3, 4], upgrade?.fromEpochs ?? []));
  if (migration?.currentRuntimeEpoch !== 5
    || upgrade?.toEpoch !== 5
    || upgrade?.sourcePolicy !== 'exact-published-table-index-trigger-manifest-and-binding-fingerprint'
    || upgrade?.backupPolicy !== 'sqlite-backup-api-plus-root-binding-and-epoch-manifest'
    || upgrade?.recoveryPolicy !== 'durable-journal-forward-only'
    || upgrade?.retiredEpoch3To4Recovery !== 'exact-pending-or-journal-before-current-upgrade'
    || upgrade?.legacyChildContinuationPolicy !== 'epoch-3-and-exact-epoch-4-missing-link-only'
    || upgrade?.epoch4MissingLinkPredecessor !== 'exact-single-missing-runtime-delivery-intent-link'
    || upgrade?.unknownDriftPolicy !== 'fail-before-data-change'
    || upgrade?.compatibilityFallback !== false
    || migration?.schemaUpgradePolicy?.olderEpoch !== 'published-3-and-4-exact-offline-upgrade-others-fail-closed'
    || migration?.schemaUpgradePolicy?.currentEpoch !== 'exact-manifest-and-physical-fingerprint-only'
    || migration?.schemaUpgradePolicy?.partialAdditiveUpgrade !== false
    || migration?.schemaUpgradePolicy?.unknownDrift !== 'fail-closed') {
    failures.push('Runtime epoch 5 只接受已发布 3/4 精确备份升级及当前代完整指纹；未知漂移必须拒绝');
  }
  failures.push(...exactSetProblems('epoch升级保留对象',
    ['runtime-rows', 'cas', 'sqlite-backup', 'runtime-archive', 'configuration', 'workspace'],
    migration?.schemaUpgradePolicy?.preserve ?? []));
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
  const constantsSource = fs.readFileSync(constantsPath, 'utf8');
  const pathsSource = fs.readFileSync(pathsPath, 'utf8');
  const protocolSource = fs.readFileSync(protocolPath, 'utf8');
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

function validateAuthority(authority, migration, failures) {
  if (authority?.productScope !== 'single-user-local-extension') failures.push('产品范围必须是单用户本机扩展');
  const database = authority?.runtimeDatabase;
  if (database?.engine !== 'sqlite' || database?.fileName !== 'limcode.sqlite' || database?.filesPerDataSet !== 1) {
    failures.push('运行时必须使用一个limcode.sqlite');
  }
  if (database?.genericJsonTables !== false) failures.push('禁止通用JSON领域表');
  if (database?.arbitrarySqlBatch !== false) failures.push('禁止业务层任意SQL批处理');
  if (database?.businessWritesThroughRepositories !== true) failures.push('业务写入必须经过领域仓储');
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
      !== 'published-epoch-3-or-4-to-5-with-backup-journal'
    || authority?.schemaPolicy?.currentEpoch !== 5) {
    failures.push('SQLite schema必须只有当前manifest和单一运行epoch，不维护旧迁移链');
  }
  if (authority?.rootPolicy?.mode !== 'offline-restart-only' || authority?.rootPolicy?.onlineMigration !== false) {
    failures.push('换根只能离线并在重启后完成');
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
    || ownership?.release !== 'no-view-references-no-active-commands-no-pending-runtime-work') {
    failures.push('同工作区允许多宿主，每个对话必须单宿主归属，且独立于 ExecutionLease');
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
    || retry?.providerDefaultMaxRetries !== 3
    || retry?.providerMaxRetries !== 10
    || retry?.configuredPerFrozenAuthority !== true
    || retry?.visibleToUser !== true
    || retry?.visibleWhenTransientThoughtExists !== true
    || retry?.cancelable !== true
  ) failures.push('提供方临时故障必须由冻结Authority驱动最多10次可见、可取消的SQLite重试');
  if (JSON.stringify(retry?.backoffMilliseconds) !== JSON.stringify([1000, 2000, 4000, 8000, 10000])) failures.push('提供方重试退避必须为1/2/4/8/10秒');
  if (JSON.stringify(retry?.semanticDeadlinesMilliseconds) !== JSON.stringify({ ordinaryFirst: 80000, ordinaryIdle: 60000, compressionCompletion: 270000 })) failures.push('提供方deadline必须为普通首语义80s/idle60s、压缩终态270s');
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
  if (file?.pathBoundary?.recursiveComponentSecurityWalk !== false) failures.push('自用插件不建设递归路径安全扫描');
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
    || retry?.defaultMaxRetries !== 3
    || retry?.maxRetries !== 10
    || retry?.configuredPerFrozenAuthority !== true
    || retry?.visible !== true
    || retry?.visibleWhenTransientThoughtExists !== true
    || retry?.cancelable !== true
    || retry?.afterExtensionRestart !== 'resume-committed-retry-with-not-before-deadline'
    || retry?.newAttemptKeepsSameModelRequest !== true
  ) failures.push('模型提供方必须使用冻结Authority下有界、可见、可取消、可重启恢复的持久重试');
  if (JSON.stringify(retry?.backoffMilliseconds) !== JSON.stringify([1000, 2000, 4000, 8000, 10000])) failures.push('模型提供方重试退避合同不匹配');
  if (JSON.stringify(retry?.semanticDeadlinesMilliseconds) !== JSON.stringify({ ordinaryFirst: 80000, ordinaryIdle: 60000, compressionCompletion: 270000 })) failures.push('模型提供方普通语义/压缩终态deadline合同不匹配');
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
  const collaboration = subagent?.collaboration;
  if (collaboration?.teamScope !== 'derive-root-conversation-from-ChildExecutionParentLink-no-team-table'
    || collaboration?.messageAuthority !== 'peer-tool-output-never-user-or-developer-authorization'
    || collaboration?.delivery !== 'reuse-RuntimeInboxItem-RuntimeDelivery-RuntimeDeliveryInputLink-RuntimeDeliveryWake'
    || collaboration?.sendMessage !== 'persist-message-and-delivery-without-idle-turn-admission; active-target-consumes-at-safe-boundary; cross-conversation-sends-instead-queue-behind-the-running-Turn-see-crossConversation.delivery'
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
    || crossConversation?.delivery !== 'running-target-queues-behind-its-current-Turn; followup-starts-its-own-Turn-and-only-that-Turn-consumes-it; followup-waits-behind-any-running-Turn-at-dispatch-including-one-started-after-its-anchor; followups-from-different-senders-start-sequential-Turns-never-merged; queued-followups-start-in-send-order-by-the-CollaborationMessage.message_seq-their-send-transaction-assigned-never-by-timestamp; that-Turn-spends-only-the-requester-budget; message-joins-the-next-Turn-whatever-starts-it; completion-replies-join-a-running-requester-Turn-at-a-safe-boundary; a-cross-conversation-completion-or-failure-reply-to-an-idle-requester(also-after-a-user-stop)-starts-one-requester-Turn-that-spends-the-chain-automatic-followup-budget; with-the-budget-spent-the-reply-waits-for-the-next-Turn-without-error; team-replies-and-plain-messages-start-no-Turn'
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
  if (subagent?.parentHandling?.deliveryConsumedMeansParentCompleted !== false) failures.push('答案送达不能冒充父Turn已经处理完成');
  if (subagent?.parentHandling?.source !== 'RuntimeDelivery.state + RuntimeDeliveryInputLink.handled_at') failures.push('parentHandling必须只读取对应InputLink.handled_at');
  if (subagent?.interrupt?.requestIsTerminal !== false) failures.push('发出终止请求不能冒充Turn已经结束');
  const cancelText = JSON.stringify(subagent?.interrupt ?? {});
  for (const marker of ['ChildExecutionParentLink', 'ActiveTurnLink', 'pending ChildExecutionIntentLink']) if (!cancelText.includes(marker)) failures.push(`interrupt_subtree规则缺少${marker}`);
  failures.push(...exactSetProblems('子Agent前端事实', ['childExecutionState', 'activeChildTurnState', 'answerSubmissionState', 'runtimeDeliveryState', 'parentHandlingState', 'terminationState'], subagent?.uiFacts ?? []));
  failures.push(...exactSetProblems('F recovery scan ID', F_RECOVERY_IDS, subagent?.recoveryOwnership?.scanIds ?? []));
  if (subagent?.recoveryOwnership?.stage !== 'F') failures.push('子代理recovery owner必须是F');
}

function validateClient(client, failures) {
  const history = client?.collaborationHistory;
  if (history?.authority !== 'CollaborationMessage+CollaborationMessageSourceLink+CollaborationMessageTargetLink; independent-of-Message'
    || history?.order !== 'CollaborationMessage.message_seq+id-desc; never-created_at'
    || history?.cursor !== 'exclusive-beforeMessageSeq+beforeId; omitted-pair-starts-newest; matched-limit-stops-at-oldest-match; underfull-window-progresses-at-last-inspected-global-key-even-when-empty'
    || history?.scan !== 'bounded-global-message_seq-index-window; indexed-source-target-message_id-probes; zero-match-page-requires-explicit-user-continue; never-infer-created_at-or-exhaustion'
    || history?.peerTitle !== 'at-most-256-indexed-Message-memberships-per-placeholder-peer; fallback-to-stored-title'
    || history?.lostResponse !== 'collaboration-result-or-error-false-or-reject-reconnects-exact-session; renderer-deadline-clears-loading-and-allows-manual-retry'
    || history?.transport !== 'sessionId+requestId+conversationId+navigationGeneration-fenced; ACK-before-optional-read'
    || history?.view !== 'separate-bounded-keyset-page; no-Message-row-or-display-floor; explicit-within-Turn-order-unknown'
    || history?.merge !== 'historical-records-by-type-id; committed-live-records-win; no-duplicate-cards; reset-on-conversation-change'
    || history?.maxPageRows !== 200 || history?.maxScannedRows !== 4096
    || history?.maxPeerTitleMembershipRows !== 256
    || history?.maxRecordBytes !== 2048 || history?.maxPageBytes !== 524288) {
    failures.push('协作历史必须按独立持久序号有界分页、按请求和会话隔离、与实时记录去重合并');
  }
  failures.push(...exactSetProblems('协作历史因果闭包', [
    'CollaborationMessage', 'CollaborationMessageSourceLink', 'CollaborationMessageTargetLink',
    'RuntimeDelivery(latest-attempt)', 'Turn(own-conversation)', 'CollaborationPeerConversation'
  ], history?.closure ?? []));
  const collaboration = client?.collaborationProjection;
  if (collaboration?.scope !== 'selected-conversation-source-or-target-only'
    || collaboration?.snapshotSelection !== 'messages-sent-from-or-delivered-into-a-loaded-Turn-plus-incoming-pending-or-failed; each-incoming-card-loads-its-delivery; at-most-200-newest-by-message_seq'
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
  if (client?.rendering?.largeLists !== 'virtual-or-segmented' || client?.rendering?.messageHistory !== 'virtual-or-segmented') failures.push('前端大列表和消息历史必须虚拟滚动或分段渲染');
  if (client?.rendering?.customScrollbar !== 'AdvancedScrollbar') failures.push('前端滚动区域必须复用AdvancedScrollbar');
  if (client?.bridgePayload?.structuredClonePlainDataOnly !== true) failures.push('Bridge载荷必须是可结构化克隆的纯数据');
  for (const surface of ['runtime-sqlite', 'cas', 'ordinary-client-state', 'log', 'error', 'vsix']) {
    if (!(client?.secrets?.forbidden ?? []).includes(surface)) failures.push(`密钥禁止面缺少${surface}`);
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
    const source = fs.readFileSync(absolutePath, 'utf8');
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
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  const readme = read('docs/architecture/reliable-kernel/README.md');
  if (!readme.includes(CONTRACT_REVISION)) failures.push(`可靠内核README必须标记合同修订${CONTRACT_REVISION}`);
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
