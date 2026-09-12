import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const { createVscodeStoragePaths } = require('../../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const {
  createDefaultLlmProviderConfig,
  normalizeLlmProviderConfig
} = require('../../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { loadRecordStore } = require('../../dist/extension/backend/capabilities/vscodeStorage/recordStore.js');
const { VscodeConfigurationAuthority } = require('../../dist/extension/backend/reliableKernel/vscodeConfigurationAuthority.js');
const { frozenCompressionPolicy, frozenInteractionAutoApproval } = require('../../dist/extension/backend/reliableKernel/frozenAuthority.js');
const {
  createDefaultLlmCompressionConfig,
  normalizeLlmCompressionMaxDurationMinutes,
  DEFAULT_LLM_RETRY_DELAY_SECONDS,
  MAX_LLM_RETRY_DELAY_SECONDS
} = require('../../dist/extension/shared/protocol.js');
const { resolveToolPolicyLayers } = require('../../dist/extension/shared/toolPolicyResolution.js');
const {
  createRemoteServerWorkEnvironmentRecord,
  workEnvironmentIdFromUri
} = require('../../dist/extension/shared/workEnvironmentCatalog.js');

async function saveLatestGlobalSettings(authority, section, settings) {
  const current = await authority.loadGlobalSettings(section);
  return authority.saveGlobalSettings(section, settings, current.revision);
}

test('调试默认设置使用独立设置文件、现有修订检查与当前数据目录，不保存开启状态', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-debug-settings-'));
  try {
    let currentRoot = path.join(root, 'first');
    const authority = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(vscode.Uri.file(currentRoot)));
    const initial = await authority.loadGlobalSettings('debugCapture');
    assert.deepEqual(initial.settings, { scope: 'conversation', maxMiB: 32, maxMinutes: 30 });
    assert.equal(initial.filePath, path.join(currentRoot, 'settings', 'debug-capture.json'));
    const updated = await authority.saveGlobalSettings('debugCapture', {
      scope: 'workspace', maxMiB: 8, maxMinutes: 5, enabled: true
    }, initial.revision);
    assert.deepEqual(updated.settings, { scope: 'workspace', maxMiB: 8, maxMinutes: 5 });
    await assert.rejects(authority.saveGlobalSettings('debugCapture', initial.settings, initial.revision), /revision|版本|冲突/i);
    const saved = JSON.parse(await fs.readFile(initial.filePath, 'utf8'));
    assert.equal('enabled' in saved.settings, false);
    currentRoot = path.join(root, 'second');
    const switched = await authority.loadGlobalSettings('debugCapture');
    assert.deepEqual(switched.settings, initial.settings);
    assert.equal(switched.filePath, path.join(currentRoot, 'settings', 'debug-capture.json'));
    assert.deepEqual(JSON.parse(await fs.readFile(initial.filePath, 'utf8')).settings, updated.settings);
    const damaged = JSON.parse(await fs.readFile(switched.filePath, 'utf8'));
    damaged.settings.maxMiB = 999;
    await fs.writeFile(switched.filePath, JSON.stringify(damaged));
    await assert.rejects(authority.loadGlobalSettings('debugCapture'), /内容损坏/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('全局 UA 随当前配置根持久化，旧窗口不能覆盖且损坏记录不回退默认值', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-network-settings-'));
  try {
    let currentRoot = path.join(root, 'first');
    const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(currentRoot));
    const authority = new VscodeConfigurationAuthority(getPaths);
    const peer = new VscodeConfigurationAuthority(getPaths);
    const initial = await authority.loadGlobalSettings('network');
    const stale = await peer.loadGlobalSettings('network');
    const updated = await authority.saveGlobalSettings('network', {
      userAgent: '  Global Client/1 (Windows)  '
    }, initial.revision);
    assert.deepEqual(updated.settings, { userAgent: 'Global Client/1 (Windows)' });
    assert.equal(updated.filePath, path.join(currentRoot, 'settings', 'network.json'));
    await assert.rejects(peer.saveGlobalSettings('network', { userAgent: 'stale client' }, stale.revision), /revision|版本|冲突/i);
    assert.deepEqual((await peer.loadGlobalSettings('network')).settings, updated.settings);

    currentRoot = path.join(root, 'second');
    const switched = await authority.loadGlobalSettings('network');
    assert.deepEqual(switched.settings, { userAgent: '' });
    assert.equal(switched.filePath, path.join(currentRoot, 'settings', 'network.json'));
    assert.deepEqual(JSON.parse(await fs.readFile(updated.filePath, 'utf8')).settings, updated.settings);
    const damaged = JSON.parse(await fs.readFile(switched.filePath, 'utf8'));
    damaged.settings.userAgent = 42;
    await fs.writeFile(switched.filePath, JSON.stringify(damaged));
    await assert.rejects(authority.loadGlobalSettings('network'), /内容损坏/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ToolPolicy 层按能力上界收窄、深合并配置，并保持来源 deny 单调', () => {
  const resolved = resolveToolPolicyLayers([
    {
      scopeKind: 'global',
      policy: {
        id: 'global-policy',
        allowedTools: ['read', 'write', 'bash'],
        preset: 'yolo',
        toolConfigs: {
          bash: {
            config: { limits: { lines: 20, chars: 1000 }, cwd: 'global' },
            autoApproveExecution: false,
            display: { autoExpand: false, autoOpenDiffPreview: true }
          }
        },
        sourceConfigs: {
          exa: { enabled: false, disabledTools: ['exa_global_denied'] }
        }
      }
    },
    {
      scopeKind: 'agent',
      policy: {
        id: 'agent-policy',
        allowedTools: ['read', 'bash', 'skills'],
        preset: 'inherit',
        toolConfigs: {
          bash: {
            config: { limits: { chars: 500 }, cwd: 'agent' },
            autoApproveExecution: true,
            display: { autoExpand: true }
          }
        },
        sourceConfigs: {
          exa: { enabled: true, disabledTools: ['exa_agent_denied'] }
        }
      }
    },
    {
      scopeKind: 'workflow',
      policy: {
        id: 'workflow-policy',
        allowedTools: ['bash'],
        preset: 'inherit'
      }
    }
  ], ['read', 'write', 'bash', 'skills', 'delete']);

  assert.equal(resolved.id, 'workflow-policy');
  assert.equal(resolved.preset, 'yolo');
  assert.deepEqual(resolved.allowedTools, ['bash']);
  assert.deepEqual(resolved.toolConfigs.bash, {
    config: { limits: { lines: 20, chars: 500 }, cwd: 'agent' },
    autoApproveExecution: true,
    display: { autoExpand: true, autoOpenDiffPreview: true }
  });
  assert.deepEqual(resolved.sourceConfigs.exa, {
    enabled: false,
    disabledTools: ['exa_agent_denied', 'exa_global_denied']
  });
});

test('VscodeConfigurationAuthority 独立持久化配置记录/Link，并按 Run→Conversation→Workflow→Agent→Global 冻结 authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-configuration-authority-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: '测试 Provider' }),
      id: 'provider:test',
      model: 'model:test',
      models: [{ id: 'model:test', name: '测试模型' }],
      systemPromptPrefix: '渠道默认前置要求',
      modelConfigs: [{
        id: 'model-config:test',
        modelId: 'model:test',
        toolCallFormat: 'function-call',
        openaiResponsesTransport: 'http',
        stream: true,
        retryOnError: true,
        retryMaxAttempts: 3,
        enableMultimodalTools: true,
        contextWindowTokens: 180_000,
        generationConfig: { maxOutputTokens: 24_000 },
        systemPromptPrefix: '模型专属前置要求',
        createdAt: 1,
        updatedAt: 1
      }]
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });

    const folderPath = path.join(root, 'workspace');
    await fs.mkdir(folderPath, { recursive: true });
    const folderUri = vscode.Uri.file(folderPath).toString();
    await authority.synchronizeWorkspaceFolders([{ uri: folderUri, name: 'Workspace', rootPath: folderPath, index: 0 }]);
    const workEnvironmentId = workEnvironmentIdFromUri(folderUri);
    const remoteEnvironment = await authority.mutations.upsertWorkEnvironment(createRemoteServerWorkEnvironmentRecord({
      id: 'work-env-remote-test',
      name: 'Remote Test',
      host: 'remote.test'
    }));

    const agent = await authority.mutations.createAgent({ name: '配置 Agent', kind: 'custom' });
    const workflow = await authority.mutations.createWorkflow({ name: '可靠 Workflow' });
    await authority.mutations.selectConversationWorkflow({
      conversationId: 'conversation:test',
      scopeKind: 'workflow',
      workflowId: workflow.id
    });
    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      name: '对话模型',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:test'
    });
    await authority.mutations.setToolPolicy({
      scopeKind: 'global',
      name: '全局工具',
      allowedTools: ['read'],
      sourceConfigs: {
        'mcp-exa': { enabled: true, disabledTools: ['exa_hidden'] }
      }
    });
    await authority.mutations.setToolPolicy({
      scopeKind: 'workflow',
      scopeId: workflow.id,
      name: 'Workflow 工具',
      allowedTools: ['read', 'skills']
    });
    await authority.mutations.setPlanReviewPolicy({
      scopeKind: 'workflow',
      scopeId: workflow.id,
      mode: 'before_mutation',
      allowReadonlyBeforeApproval: true,
      requireForToolRiskLevels: ['write']
    });
    await authority.mutations.setSystemPrompt({ scopeKind: 'global', name: '全局规则', text: 'GLOBAL' });
    await authority.mutations.setSystemPrompt({ scopeKind: 'agent', scopeId: agent.id, name: 'Agent 规则', text: 'AGENT' });
    await authority.mutations.setSystemPrompt({ scopeKind: 'workflow', scopeId: workflow.id, name: '工作流规则', text: 'WORKFLOW' });
    await authority.mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'conversation:test', name: '对话规则', text: 'CONVERSATION' });
    await authority.mutations.setRuntimeContext({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      template: 'ENV:\n{{$workEnvironment.current}}'
    });
    await authority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      enabled: true,
      allowedWorkEnvironmentIds: [workEnvironmentId],
      defaultWorkEnvironmentId: workEnvironmentId
    });
    await authority.mutations.selectConversationWorkEnvironment('conversation:test', workEnvironmentId);
    await authority.mutations.copyConversationConfiguration('conversation:test', 'conversation:fork');

    const snapshot = await authority.configurationClientState();
    assert.equal(snapshot.agents.some((record) => record.id === agent.id), true);
    assert.equal(snapshot.workflows.some((record) => record.id === workflow.id), true);
    assert.equal(snapshot.workflows.some((record) => record.id === 'builtin:plan'), true);
    assert.equal(snapshot.conversationWorkflowSelections.length, 2);
    assert.equal(snapshot.conversationWorkflowSelections.find((record) =>
      record.conversationId === 'conversation:fork'
    )?.workflowId, workflow.id);
    assert.equal(snapshot.conversationWorkEnvironmentLinks.length, 2);
    assert.equal(snapshot.conversationWorkEnvironmentLinks.find((record) =>
      record.conversationId === 'conversation:fork'
    )?.workEnvironmentId, workEnvironmentId);
    assert.equal(snapshot.workEnvironments.find((record) => record.id === workEnvironmentId)?.available, true);
    const sourceModelLink = snapshot.modelProfileScopeLinks.find((link) =>
      link.scopeKind === 'conversation' && link.scopeId === 'conversation:test'
    );
    const forkModelLink = snapshot.modelProfileScopeLinks.find((link) =>
      link.scopeKind === 'conversation' && link.scopeId === 'conversation:fork'
    );
    assert.ok(sourceModelLink);
    assert.ok(forkModelLink);
    assert.notEqual(forkModelLink.modelProfileId, sourceModelLink.modelProfileId);
    assert.equal(snapshot.modelProfiles.find((record) => record.id === forkModelLink.modelProfileId)?.model, 'model:test');
    for (const links of [
      snapshot.planReviewPolicyScopeLinks,
      snapshot.toolPolicyScopeLinks,
      snapshot.skillPolicyScopeLinks,
      snapshot.systemPromptScopeLinks,
      snapshot.runtimeContextScopeLinks,
      snapshot.workEnvironmentPolicyScopeLinks,
      snapshot.checkpointPolicyScopeLinks
    ]) {
      assert.equal(links.some((link) => link.scopeKind === 'conversation' && link.scopeId === 'conversation:fork'), false);
    }

    const forkCompiled = await authority.compile({
      conversationId: 'conversation:fork',
      turnId: 'turn:fork',
      executorAgentId: agent.id,
      intentKind: 'input'
    });
    const forkFrozen = JSON.parse(forkCompiled.authoritySnapshot.content);
    const forkPreset = JSON.parse(forkCompiled.executionPreset.content);
    assert.equal(forkFrozen.model.modelId, 'model:test');
    assert.equal(forkFrozen.planReviewPolicy.mode, 'before_mutation');
    assert.equal(forkPreset.defaultWorkEnvironmentId, workEnvironmentId);

    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:source-after-fork'
    });
    const afterSourceModelChange = await authority.configurationClientState();
    assert.equal(afterSourceModelChange.modelProfiles.find((record) =>
      record.id === forkModelLink.modelProfileId
    )?.model, 'model:test');
    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      name: '对话模型',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:test'
    });

    const compiled = await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:test',
      executorAgentId: agent.id,
      intentKind: 'input'
    });
    const frozen = JSON.parse(compiled.authoritySnapshot.content);
    assert.equal(frozen.model.providerConfigId, provider.id);
    assert.equal(frozen.model.modelId, 'model:test');
    assert.equal(frozen.model.systemPromptPrefix, '模型专属前置要求');
    assert.equal(frozen.model.maxOutputTokens, 24_000);
    assert.equal(frozen.compression.config.llmSummary.targetTokens, 8_000);
    assert.equal(frozen.compression.provider.contextWindowTokens, 180_000);
    assert.equal(frozen.compression.provider.maxOutputTokens, 16_000);
    assert.deepEqual(frozen.toolPolicy.allowedTools, ['read']);
    assert.deepEqual(frozen.toolPolicy.sourceConfigs, {
      'mcp-exa': { enabled: true, disabledTools: ['exa_hidden'] }
    });
    assert.equal(frozen.planReviewPolicy.mode, 'before_mutation');
    assert.deepEqual(frozen.planReviewPolicy.requireForToolRiskLevels, ['write']);
    assert.equal(
      frozen.systemPrompt.text,
      '[全局规则]\nGLOBAL\n\n[Agent 规则]\nAGENT\n\n[工作流规则]\nWORKFLOW\n\n[对话规则]\nCONVERSATION'
    );
    assert.equal(frozen.runtimeContext.template, 'ENV:\n{{$workEnvironment.current}}');
    assert.match(frozen.runtimeContext.text, /Workspace · 本地/);
    assert.doesNotMatch(frozen.runtimeContext.text, /work-env-/);
    assert.equal(frozen.workEnvironmentPolicy.enabled, true);
    assert.deepEqual(frozen.workEnvironmentPolicy.allowedWorkEnvironmentIds, [workEnvironmentId]);
    assert.equal(frozen.workEnvironmentPolicy.defaultWorkEnvironmentId, workEnvironmentId);

    await authority.mutations.clearWorkEnvironmentPolicy('conversation', 'conversation:test');
    const withoutEnvironmentPolicy = JSON.parse((await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:no-environment-policy',
      executorAgentId: agent.id,
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(withoutEnvironmentPolicy.workEnvironmentPolicy.enabled, false);
    assert.match(withoutEnvironmentPolicy.runtimeContext.text, /Workspace · 本地/);
    assert.doesNotMatch(withoutEnvironmentPolicy.runtimeContext.text, /work-env-/);

    // 子 Agent 继承父 Turn 冻结的工作环境边界：自身无策略时收敛到父边界，只收紧不放宽。
    const childInherited = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-inherited',
      turnId: 'turn:child-inherited',
      executorAgentId: agent.id,
      intentKind: 'input',
      inheritedWorkEnvironmentPolicy: {
        enabled: true,
        allowedWorkEnvironmentIds: [workEnvironmentId],
        defaultWorkEnvironmentId: workEnvironmentId
      }
    })).authoritySnapshot.content);
    assert.deepEqual(childInherited.workEnvironmentPolicy.allowedWorkEnvironmentIds, [workEnvironmentId]);
    assert.equal(childInherited.workEnvironmentPolicy.defaultWorkEnvironmentId, workEnvironmentId);

    // 交集为父边界子集；父默认环境在交集内时被保留。
    await authority.mutations.setRuntimeContext({
      scopeKind: 'conversation',
      scopeId: 'conversation:child-remote-only',
      template: 'ENV:\n{{$workEnvironment.current}}'
    });
    const childRemoteOnly = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-remote-only',
      turnId: 'turn:child-remote-only',
      executorAgentId: agent.id,
      intentKind: 'input',
      inheritedWorkEnvironmentPolicy: {
        enabled: true,
        allowedWorkEnvironmentIds: [remoteEnvironment.id],
        defaultWorkEnvironmentId: remoteEnvironment.id
      }
    })).authoritySnapshot.content);
    assert.deepEqual(childRemoteOnly.workEnvironmentPolicy.allowedWorkEnvironmentIds, [remoteEnvironment.id]);
    assert.equal(childRemoteOnly.workEnvironmentPolicy.defaultWorkEnvironmentId, remoteEnvironment.id);
    assert.match(childRemoteOnly.runtimeContext.text, /Remote Test/);
    assert.doesNotMatch(childRemoteOnly.runtimeContext.text, /Workspace · 本地/);

    await authority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'conversation',
      scopeId: 'conversation:child-disjoint',
      enabled: true,
      allowedWorkEnvironmentIds: [workEnvironmentId],
      defaultWorkEnvironmentId: workEnvironmentId
    });
    await authority.mutations.setRuntimeContext({
      scopeKind: 'conversation',
      scopeId: 'conversation:child-disjoint',
      template: 'ENV:\n{{$workEnvironment.current}}'
    });
    const childDisjoint = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-disjoint',
      turnId: 'turn:child-disjoint',
      executorAgentId: agent.id,
      intentKind: 'input',
      inheritedWorkEnvironmentPolicy: {
        enabled: true,
        allowedWorkEnvironmentIds: [remoteEnvironment.id],
        defaultWorkEnvironmentId: remoteEnvironment.id
      }
    })).authoritySnapshot.content);
    assert.deepEqual(childDisjoint.workEnvironmentPolicy.allowedWorkEnvironmentIds, []);
    assert.equal(childDisjoint.workEnvironmentPolicy.defaultWorkEnvironmentId, null);
    assert.doesNotMatch(childDisjoint.runtimeContext.text, /Remote Test/);
    assert.doesNotMatch(childDisjoint.runtimeContext.text, /Workspace · 本地/);

    // 不携带继承边界时保持现状：无策略会话可见全部可用环境。
    const childUnbounded = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-unbounded',
      turnId: 'turn:child-unbounded',
      executorAgentId: agent.id,
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.deepEqual(childUnbounded.workEnvironmentPolicy.allowedWorkEnvironmentIds,
      [remoteEnvironment.id, workEnvironmentId].sort());

    const changedProvider = {
      ...provider,
      modelConfigs: provider.modelConfigs.map((modelConfig) => ({
        ...modelConfig,
        systemPromptPrefix: '后来修改的模型要求',
        updatedAt: 2
      }))
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [changedProvider] });
    const afterSettingsChange = JSON.parse((await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:after-settings-change',
      executorAgentId: agent.id,
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(frozen.model.systemPromptPrefix, '模型专属前置要求');
    assert.equal(afterSettingsChange.model.systemPromptPrefix, '后来修改的模型要求');

    await authority.mutations.clearToolPolicy('workflow', workflow.id);
    const inherited = JSON.parse((await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:inherited',
      executorAgentId: agent.id,
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.deepEqual(inherited.toolPolicy.allowedTools, ['read']);
    assert.deepEqual(inherited.toolPolicy.sourceConfigs, {
      'mcp-exa': { enabled: true, disabledTools: ['exa_hidden'] }
    });

    await authority.mutations.deleteWorkflow(workflow.id);
    const afterDelete = await authority.configurationClientState();
    assert.equal(afterDelete.workflows.some((record) => record.id === workflow.id), false);
    assert.equal(afterDelete.conversationWorkflowSelections.length, 0);
    assert.equal(afterDelete.systemPromptScopeLinks.some((link) => link.scopeKind === 'workflow' && link.scopeId === workflow.id), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('子 Agent 模型优先级、父 Turn fallback 与手动续聊的 Conversation 选择保持稳定', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-model-inheritance-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: '子 Agent 模型测试 Provider' }),
      id: 'provider:child-model-test',
      model: 'model:global',
      models: [
        { id: 'model:global', name: 'Global' },
        { id: 'model:parent', name: 'Parent' },
        { id: 'model:child-agent', name: 'Child Agent' },
        { id: 'model:manual', name: 'Manual' }
      ],
      modelConfigs: []
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    const parentFallback = {
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:parent'
    };

    await authority.mutations.setModelProfile({
      scopeKind: 'agent',
      scopeId: 'main',
      name: '子 Agent 自有模型',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:child-agent'
    });
    const agentProfileWins = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-agent-profile',
      turnId: 'turn:child-agent-profile',
      executorAgentId: 'main',
      intentKind: 'input',
      modelFallback: parentFallback
    })).authoritySnapshot.content);
    assert.equal(agentProfileWins.model.modelId, 'model:child-agent');

    await authority.mutations.clearModelProfile('agent', 'main');
    const parentFallbackWins = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-parent-fallback',
      turnId: 'turn:child-parent-fallback',
      executorAgentId: 'main',
      intentKind: 'input',
      modelFallback: parentFallback
    })).authoritySnapshot.content);
    assert.equal(parentFallbackWins.model.modelId, 'model:parent');
    assert.notEqual(parentFallbackWins.model.modelId, 'model:global');

    assert.deepEqual(await authority.mutations.initializeConversationModelProfile({
      conversationId: 'conversation:child-parent-fallback',
      ...parentFallback
    }), { created: true });
    const manualContinuation = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-parent-fallback',
      turnId: 'turn:child-manual-continuation',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(manualContinuation.model.modelId, 'model:parent');

    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:child-parent-fallback',
      name: '用户显式切换',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:manual'
    });
    assert.deepEqual(await authority.mutations.initializeConversationModelProfile({
      conversationId: 'conversation:child-parent-fallback',
      ...parentFallback
    }), { created: false });
    const explicitSwitchWins = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-parent-fallback',
      turnId: 'turn:child-explicit-switch',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(explicitSwitchWins.model.modelId, 'model:manual');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('VscodeConfigurationAuthority 让 Agent 缺省 preset 继承全局 YOLO，同时保留能力上界与逐工具配置', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-configuration-yolo-inherit-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: 'YOLO Provider' }),
      id: 'provider:yolo',
      model: 'model:yolo',
      models: [{ id: 'model:yolo', name: 'YOLO 模型' }],
      modelConfigs: []
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    await authority.mutations.setToolPolicy({
      scopeKind: 'global',
      name: '全局 YOLO',
      preset: 'yolo',
      allowedTools: ['read', 'write', 'edit', 'delete', 'bash', 'skills'],
      toolConfigs: {
        write: { config: {}, autoApproveExecution: true, autoApplyChange: true },
        edit: { config: {}, autoApproveExecution: true, autoApplyChange: true },
        delete: { config: {}, autoApproveExecution: true, autoApplyChange: true },
        bash: {
          config: { limits: { lines: 40, chars: 2000 }, cwd: 'global' },
          display: { autoExpand: false }
        }
      },
      sourceConfigs: { exa: { enabled: true, disabledTools: ['exa_global_denied'] } }
    });
    await authority.mutations.setToolPolicy({
      scopeKind: 'agent',
      scopeId: 'main',
      name: 'Main 上界',
      allowedTools: ['read', 'write', 'edit', 'delete', 'bash'],
      toolConfigs: {
        bash: {
          config: { limits: { chars: 500 }, cwd: 'agent' },
          display: { autoExpand: true }
        }
      },
      sourceConfigs: { exa: { enabled: true, disabledTools: ['exa_agent_denied'] } }
    });

    const frozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:yolo',
      turnId: 'turn:yolo',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(frozen.toolPolicy.preset, 'yolo');
    assert.deepEqual(frozen.toolPolicy.allowedTools, ['bash', 'delete', 'edit', 'read', 'write']);
    assert.equal(frozen.toolPolicy.toolConfigs.write.autoApproveExecution, true);
    assert.equal(frozen.toolPolicy.toolConfigs.edit.autoApplyChange, true);
    assert.equal(frozen.toolPolicy.toolConfigs.delete.autoApplyChange, true);
    assert.deepEqual(frozen.toolPolicy.toolConfigs.bash, {
      config: { limits: { lines: 40, chars: 500 }, cwd: 'agent' },
      display: { autoExpand: true }
    });
    assert.deepEqual(frozen.toolPolicy.sourceConfigs.exa, {
      enabled: true,
      disabledTools: ['exa_agent_denied', 'exa_global_denied']
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Ask/Plan 自动审批通过原有工具策略落盘、继承并允许局部关闭', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-auto-approval-settings-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: 'Auto approval provider' }),
      id: 'provider:auto-approval', model: 'model:auto-approval',
      models: [{ id: 'model:auto-approval', name: 'Test model' }], modelConfigs: []
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    const compileRequest = {
      conversationId: 'conversation:auto-approval', turnId: 'turn:auto-approval',
      executorAgentId: 'main', intentKind: 'input'
    };
    const initial = JSON.parse((await authority.compile(compileRequest)).authoritySnapshot.content);
    assert.equal(frozenInteractionAutoApproval(initial, 'ask_user'), false);
    assert.equal(frozenInteractionAutoApproval(initial, 'submit_plan'), false);
    await authority.mutations.setToolPolicy({
      scopeKind: 'global', preset: 'custom', allowedTools: ['ask_user', 'submit_plan', 'write'],
      toolConfigs: {
        ask_user: { config: { autoApprove: true } },
        submit_plan: { config: { autoApprove: true } },
        write: { config: { allowOutsideProjectPaths: false }, autoApplyChange: false }
      }
    });
    const reopened = new VscodeConfigurationAuthority(() => paths);
    const inherited = JSON.parse((await reopened.compile(compileRequest)).authoritySnapshot.content);
    assert.equal(frozenInteractionAutoApproval(inherited, 'ask_user'), true);
    assert.equal(frozenInteractionAutoApproval(inherited, 'submit_plan'), true);
    assert.equal(inherited.toolPolicy.toolConfigs.write.autoApplyChange, false);
    await reopened.mutations.setToolPolicy({
      scopeKind: 'conversation', scopeId: compileRequest.conversationId,
      allowedTools: ['ask_user', 'submit_plan', 'write'],
      toolConfigs: { ask_user: { config: {} }, submit_plan: { config: { autoApprove: false } } }
    });
    const overridden = JSON.parse((await reopened.compile(compileRequest)).authoritySnapshot.content);
    assert.equal(frozenInteractionAutoApproval(overridden, 'ask_user'), true);
    assert.equal(frozenInteractionAutoApproval(overridden, 'submit_plan'), false);
    assert.equal(frozenInteractionAutoApproval(inherited, 'submit_plan'), true);
    assert.deepEqual(overridden.toolPolicy.toolConfigs.write, inherited.toolPolicy.toolConfigs.write);
  } finally {
    const resolvedRoot = await fs.realpath(root);
    assert.equal(path.dirname(resolvedRoot), await fs.realpath(os.tmpdir()));
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
});

test('多个Host共享WorkEnvironment存储时只在本地投影当前Workspace可用性与有效策略', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-work-environment-rebind-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const firstAuthority = new VscodeConfigurationAuthority(() => paths);
    const secondAuthority = new VscodeConfigurationAuthority(() => paths);
    const firstPath = path.join(root, 'workspace-first');
    const secondPath = path.join(root, 'workspace-second');
    await fs.mkdir(firstPath, { recursive: true });
    await fs.mkdir(secondPath, { recursive: true });
    const firstUri = vscode.Uri.file(firstPath).toString();
    const secondUri = vscode.Uri.file(secondPath).toString();
    const firstId = workEnvironmentIdFromUri(firstUri);
    const secondId = workEnvironmentIdFromUri(secondUri);

    const provider = {
      ...createDefaultLlmProviderConfig({ name: 'Workspace Provider' }),
      id: 'provider:workspace-isolation',
      model: 'model:workspace-isolation',
      models: [{ id: 'model:workspace-isolation', name: 'Workspace Model' }],
      modelConfigs: []
    };
    await saveLatestGlobalSettings(firstAuthority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(firstAuthority, 'llm', { activeProviderConfigId: provider.id });

    const eagerFirstAuthority = new VscodeConfigurationAuthority(() => paths, undefined, [{
      uri: firstUri,
      name: 'First',
      rootPath: firstPath,
      index: 0
    }]);
    const eagerFirstSnapshot = await eagerFirstAuthority.configurationClientState();
    assert.equal(eagerFirstSnapshot.workEnvironments.find((record) => record.id === firstId)?.available, true);
    assert.equal(eagerFirstSnapshot.workEnvironments.find((record) => record.id === secondId), undefined);

    await firstAuthority.synchronizeWorkspaceFolders([{ uri: firstUri, name: 'First', rootPath: firstPath, index: 0 }]);
    await firstAuthority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'global',
      enabled: false,
      allowedWorkEnvironmentIds: [firstId],
      defaultWorkEnvironmentId: firstId
    });
    await secondAuthority.synchronizeWorkspaceFolders([{ uri: secondUri, name: 'Second', rootPath: secondPath, index: 0 }]);

    const storedEnvironments = await loadRecordStore(
      paths.workEnvironmentsRootUri,
      paths.workEnvironmentsIndexUri,
      'workEnvironment'
    );
    assert.equal(storedEnvironments.find((record) => record.id === firstId)?.available, true);
    assert.equal(storedEnvironments.find((record) => record.id === secondId)?.available, true);
    const storedPolicies = await loadRecordStore(
      paths.workEnvironmentPoliciesRootUri,
      paths.workEnvironmentPoliciesIndexUri,
      'policy'
    );
    const storedPolicy = storedPolicies.find((record) => record.id === 'work-environment-policy:global:global');
    assert.deepEqual(storedPolicy?.allowedWorkEnvironmentIds, [firstId]);
    assert.equal(storedPolicy?.defaultWorkEnvironmentId, firstId);

    const firstSnapshot = await firstAuthority.configurationClientState();
    const firstPolicy = firstSnapshot.workEnvironmentPolicies.find((record) => record.id === 'work-environment-policy:global:global');
    assert.deepEqual(firstPolicy?.allowedWorkEnvironmentIds, [firstId]);
    assert.equal(firstPolicy?.defaultWorkEnvironmentId, firstId);
    assert.equal(firstSnapshot.workEnvironments.find((record) => record.id === firstId)?.available, true);
    assert.equal(firstSnapshot.workEnvironments.find((record) => record.id === secondId)?.available, false);

    const secondSnapshot = await secondAuthority.configurationClientState();
    const secondPolicy = secondSnapshot.workEnvironmentPolicies.find((record) => record.id === 'work-environment-policy:global:global');
    assert.equal(secondPolicy?.enabled, false);
    // workspaceIds (secondId) always prepended to projected allowed
    assert.deepEqual(secondPolicy?.allowedWorkEnvironmentIds, [secondId, firstId]);
    assert.equal(secondPolicy?.defaultWorkEnvironmentId, secondId);
    assert.equal(secondSnapshot.workEnvironments.find((record) => record.id === firstId)?.available, false);
    assert.equal(secondSnapshot.workEnvironments.find((record) => record.id === secondId)?.available, true);

    const secondFrozen = JSON.parse((await secondAuthority.compile({
      conversationId: 'conversation:second-workspace',
      turnId: 'turn:second-workspace',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.deepEqual(secondFrozen.workEnvironmentPolicy.allowedWorkEnvironmentIds, [secondId]);
    assert.equal(secondFrozen.workEnvironmentPolicy.defaultWorkEnvironmentId, secondId);

    const manualId = 'work-environment:shared-remote';
    await firstAuthority.mutations.upsertWorkEnvironment({
      id: manualId,
      kind: 'remoteServer',
      source: 'manual',
      name: 'Shared Remote',
      host: 'example.test',
      available: true,
      createdAt: 1,
      updatedAt: 1
    });
    await firstAuthority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'global',
      enabled: true,
      allowedWorkEnvironmentIds: [manualId],
      defaultWorkEnvironmentId: manualId
    });
    const manualSnapshot = await secondAuthority.configurationClientState();
    const manualPolicy = manualSnapshot.workEnvironmentPolicies.find((record) => record.id === 'work-environment-policy:global:global');
    // workspaceIds (secondId) always prepended to projected allowed
    assert.deepEqual(manualPolicy?.allowedWorkEnvironmentIds, [secondId, manualId]);
    // projected default prefers this Host's workspace folder over stored default
    assert.equal(manualPolicy?.defaultWorkEnvironmentId, secondId);
    assert.equal(manualSnapshot.workEnvironments.find((record) => record.id === manualId)?.available, true);

    const manualFrozen = JSON.parse((await secondAuthority.compile({
      conversationId: 'conversation:shared-remote',
      turnId: 'turn:shared-remote',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    // compile inherits projected allowed with workspace folder prepended
    assert.deepEqual(manualFrozen.workEnvironmentPolicy.allowedWorkEnvironmentIds, [secondId, manualId]);
    // compile default = projected default (workspace folder)
    assert.equal(manualFrozen.workEnvironmentPolicy.defaultWorkEnvironmentId, secondId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('不相关的旧压缩配置不会阻塞 Agent、Workflow 与 ConfigurationSnapshot 投影', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-agent-projection-isolation-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const compressionRoot = path.join(paths.settingsRootUri.fsPath, 'llm-compression-configs');
    const recordsRoot = path.join(compressionRoot, 'records');
    const recordFile = 'records/legacy-compression.json';
    const savedAt = new Date().toISOString();
    await fs.mkdir(recordsRoot, { recursive: true });
    await fs.writeFile(path.join(compressionRoot, 'index.json'), `${JSON.stringify({
      schemaVersion: 1,
      savedAt,
      records: [{ id: 'legacy-compression', file: recordFile, updatedAt: savedAt }]
    }, null, 2)}\n`);
    await fs.writeFile(path.join(compressionRoot, ...recordFile.split('/')), `${JSON.stringify({
      schemaVersion: 1,
      savedAt,
      config: {
        id: 'legacy-compression',
        name: 'Legacy compression',
        kind: 'segmented_summary',
        trigger: {
          mode: 'token_threshold',
          thresholdUnit: 'percent',
          thresholdPercent: 90,
          preserveLatestMessages: 8,
          reserveLatestUserMessageTokens: 20_000
        },
        llmSummary: { targetTokens: 2_000 },
        createdAt: 1,
        updatedAt: 1
      }
    }, null, 2)}\n`);

    const agents = await authority.agents();
    assert.ok(agents.some((agent) => agent.id === 'main'));
    const resolvedAgent = await authority.resolveAgent({ agentType: 'main' });
    assert.equal(resolvedAgent.agentId, 'main');
    const workflow = await authority.workflow('builtin:plan');
    assert.equal(workflow.id, 'builtin:plan');
    const snapshot = await authority.configurationClientState();
    assert.ok(snapshot.agents.some((agent) => agent.id === 'main'));
    assert.ok(snapshot.workflows.some((candidate) => candidate.id === 'builtin:plan'));
    await assert.rejects(
      authority.loadGlobalSettings('llmCompressionConfigs'),
      /removed message-count\/user-reserve fields/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('重试间隔按模型覆盖渠道冻结成 retryDelayMs，并夹到 0..600 秒', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-retry-delay-authority-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: '重试间隔 Provider' }),
      id: 'provider:retry-delay',
      model: 'model:channel',
      models: [{ id: 'model:channel', name: '渠道默认模型' }, { id: 'model:override', name: '模型覆盖' }],
      retryOnError: true,
      retryMaxAttempts: 4,
      retryDelaySeconds: 30,
      modelConfigs: [{
        id: 'model-config:override',
        modelId: 'model:override',
        toolCallFormat: 'function-call',
        openaiResponsesTransport: 'http',
        stream: true,
        retryOnError: true,
        retryMaxAttempts: 2,
        retryDelaySeconds: 60,
        enableMultimodalTools: true,
        systemPromptPrefix: '',
        createdAt: 1,
        updatedAt: 1
      }]
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });

    const channelFrozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:retry-channel',
      turnId: 'turn:retry-channel',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.deepEqual(channelFrozen.model.retryPolicy, {
      enabled: true,
      maxRetries: 4,
      retryDelayMs: 30_000
    });

    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:retry-model',
      name: '模型覆盖',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:override'
    });
    const modelFrozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:retry-model',
      turnId: 'turn:retry-model',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.deepEqual(modelFrozen.model.retryPolicy, {
      enabled: true,
      maxRetries: 2,
      retryDelayMs: 60_000
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('重试间隔归一化：非法值与负数落回 0，超过上限夹到 600 秒', () => {
  const config = normalizeLlmProviderConfig({ retryDelaySeconds: 999_999 });
  assert.equal(config.retryDelaySeconds, MAX_LLM_RETRY_DELAY_SECONDS);
  assert.equal(normalizeLlmProviderConfig({}).retryDelaySeconds, DEFAULT_LLM_RETRY_DELAY_SECONDS);
  assert.equal(normalizeLlmProviderConfig({ retryDelaySeconds: -30 }).retryDelaySeconds, 0);
  assert.equal(normalizeLlmProviderConfig({ retryDelaySeconds: Number.NaN }).retryDelaySeconds, 0);
  assert.equal(normalizeLlmProviderConfig({ retryDelaySeconds: 30.9 }).retryDelaySeconds, 30);
});

test('压缩最长时间默认20分钟并限制为1到1440分钟的整数', () => {
  assert.equal(createDefaultLlmCompressionConfig().maxDurationMinutes, 20);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(undefined), 20);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(NaN), 20);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(Infinity), 20);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes('37'), 20);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(37), 37);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(2.6), 3);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(0), 1);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(-5), 1);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(999999999), 1440);
});

test('压缩配置 hard-cut 旧保留字段并冻结压缩 Provider 自己的窗口、输出上限和最长时间', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-compression-config-cutover-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const primary = {
      ...createDefaultLlmProviderConfig({ name: '主模型渠道' }),
      id: 'provider:primary-compression-cutover',
      model: 'model:primary-372k',
      models: [{ id: 'model:primary-372k', name: 'Primary 372K' }],
      contextWindowTokens: 372_000,
      generationConfig: { maxOutputTokens: 20_000 },
      modelConfigs: []
    };
    const summary = {
      ...createDefaultLlmProviderConfig({ name: '摘要渠道' }),
      id: 'provider:summary-compression-cutover',
      model: 'model:summary-64k',
      models: [{ id: 'model:summary-64k', name: 'Summary 64K' }],
      contextWindowTokens: 64_000,
      generationConfig: { maxOutputTokens: 6_000 },
      modelConfigs: []
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [primary, summary] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: primary.id });

    const legacyCompressionConfig = {
      id: 'compression-config:cutover',
      name: 'Hard cut compression',
      kind: 'llm_summary',
      trigger: {
        mode: 'token_threshold',
        thresholdUnit: 'tokens',
        thresholdTokens: 300_000,
        thresholdPercent: 80,
        preserveLatestMessages: 99,
        reserveLatestUserMessageTokens: 123_000
      },
      llmSummary: {
        providerConfigId: summary.id,
        model: summary.model,
        generationConfig: { maxOutputTokens: 12_000 }
      },
      createdAt: 1,
      updatedAt: 1
    };
    await assert.rejects(
      saveLatestGlobalSettings(authority, 'llmCompressionConfigs', {
        configs: [legacyCompressionConfig]
      }),
      /removed message-count\/user-reserve fields/
    );
    const compressionConfig = {
      ...legacyCompressionConfig,
      maxDurationMinutes: 37,
      trigger: {
        mode: 'token_threshold',
        thresholdUnit: 'tokens',
        thresholdTokens: 300_000,
        thresholdPercent: 80
      }
    };
    const saved = await saveLatestGlobalSettings(authority, 'llmCompressionConfigs', {
      configs: [compressionConfig]
    });
    const normalizedConfig = saved.settings.configs[0];
    assert.equal(normalizedConfig.maxDurationMinutes, 37);
    assert.equal((await authority.loadGlobalSettings('llmCompressionConfigs')).settings.configs[0].maxDurationMinutes, 37);
    assert.equal(normalizedConfig.llmSummary.targetTokens, 8_000);
    assert.deepEqual(Object.keys(normalizedConfig.trigger).sort(), [
      'mode', 'thresholdPercent', 'thresholdTokens', 'thresholdUnit'
    ]);
    await saveLatestGlobalSettings(authority, 'llmCompression', {
      defaultConfigId: normalizedConfig.id,
      providerBindings: [],
      modelBindings: []
    });

    const frozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:compression-cutover',
      turnId: 'turn:compression-cutover',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(frozen.modelProfile.contextWindowTokens, 372_000);
    assert.equal(frozen.model.maxOutputTokens, 20_000);
    assert.equal(frozen.compression.config.llmSummary.targetTokens, 8_000);
    assert.equal(frozen.compression.provider.providerConfigId, summary.id);
    assert.equal(frozen.compression.provider.modelId, summary.model);
    assert.equal(frozen.compression.provider.contextWindowTokens, 64_000);
    assert.equal(frozen.compression.provider.maxOutputTokens, 12_000);
    assert.equal(frozen.compression.config.maxDurationMinutes, 37);
    assert.equal(Object.hasOwn(frozen.compression, 'preserveLatestMessages'), false);
    assert.equal(Object.hasOwn(frozen.compression.config.trigger, 'preserveLatestMessages'), false);
    assert.equal(Object.hasOwn(frozen.compression.config.trigger, 'reserveLatestUserMessageTokens'), false);
    assert.equal(frozenCompressionPolicy(frozen).provider.contextWindowTokens, 64_000);
    await saveLatestGlobalSettings(authority, 'llmCompressionConfigs', {
      configs: [{ ...normalizedConfig, maxDurationMinutes: 45 }]
    });
    const nextFrozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:compression-cutover',
      turnId: 'turn:compression-cutover-next',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(nextFrozen.compression.config.maxDurationMinutes, 45);
    assert.equal(frozen.compression.config.maxDurationMinutes, 37);

    const incomplete = structuredClone(frozen);
    delete incomplete.compression.provider.contextWindowTokens;
    assert.throws(
      () => frozenCompressionPolicy(incomplete),
      /compression\.provider\.contextWindowTokens/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createVscodeStub() {
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  class Uri {
    constructor(fsPath) {
      this.scheme = 'file';
      this.fsPath = path.resolve(fsPath);
      this.path = this.fsPath.split(path.sep).join('/');
    }
    static file(filePath) { return new Uri(filePath); }
    static joinPath(base, ...segments) { return new Uri(path.join(base.fsPath, ...segments)); }
    toString() { return `file://${this.path}`; }
  }
  return {
    Uri,
    FileType,
    workspace: {
      fs: {
        async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
        async readFile(uri) { return fs.readFile(uri.fsPath); },
        async writeFile(uri, bytes) {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, bytes);
        },
        async readDirectory(uri) {
          const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry) => [
            entry.name,
            entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown
          ]);
        },
        async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
        async stat(uri) {
          const stat = await fs.stat(uri.fsPath);
          return {
            type: stat.isDirectory() ? FileType.Directory : FileType.File,
            ctime: stat.ctimeMs,
            mtime: stat.mtimeMs,
            size: stat.size
          };
        }
      }
    }
  };
}

test('投影层始终并入当前 Host workspace folder 并优先作为 projected default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-projection-default-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const localUri = vscode.Uri.file(path.join(root, 'my-folder')).toString();
    const localId = workEnvironmentIdFromUri(localUri);
    const remoteId = 'work-env-remote:my-server';

    const authority = new VscodeConfigurationAuthority(() => paths, undefined, [{
      uri: localUri, name: 'My Folder', rootPath: path.join(root, 'my-folder'), index: 0
    }]);
    await authority.mutations.upsertWorkEnvironment({
      id: remoteId, kind: 'remoteServer', source: 'manual', name: 'Server',
      host: 'server.test', available: true, createdAt: 1, updatedAt: 1
    });
    await authority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'global', enabled: true,
      allowedWorkEnvironmentIds: [remoteId],
      defaultWorkEnvironmentId: remoteId
    });

    const snapshot = await authority.configurationClientState();
    const policy = snapshot.workEnvironmentPolicies.find(
      (record) => record.id === 'work-environment-policy:global:global'
    );
    assert.ok(policy, 'global policy should exist');
    assert.deepEqual(policy.allowedWorkEnvironmentIds, [localId, remoteId]);
    assert.equal(policy.defaultWorkEnvironmentId, localId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('多 Host 投影：不同窗口各自以自己的 folder 为 projected default 且不污染共享策略库', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-multi-host-default-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const uriA = vscode.Uri.file(path.join(root, 'folder-a')).toString();
    const uriB = vscode.Uri.file(path.join(root, 'folder-b')).toString();
    const idA = workEnvironmentIdFromUri(uriA);
    const idB = workEnvironmentIdFromUri(uriB);
    const remoteId = 'work-env-remote:shared-server';

    const authA = new VscodeConfigurationAuthority(() => paths, undefined, [
      { uri: uriA, name: 'A', rootPath: path.join(root, 'folder-a'), index: 0 }
    ]);
    const authB = new VscodeConfigurationAuthority(() => paths, undefined, [
      { uri: uriB, name: 'B', rootPath: path.join(root, 'folder-b'), index: 0 }
    ]);

    await authA.mutations.upsertWorkEnvironment({
      id: remoteId, kind: 'remoteServer', source: 'manual', name: 'Server',
      host: 'srv.test', available: true, createdAt: 1, updatedAt: 1
    });
    await authA.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'global', enabled: true,
      allowedWorkEnvironmentIds: [remoteId],
      defaultWorkEnvironmentId: remoteId
    });

    const snapA = await authA.configurationClientState();
    const policyA = snapA.workEnvironmentPolicies.find(
      (record) => record.id === 'work-environment-policy:global:global'
    );
    assert.deepEqual(policyA.allowedWorkEnvironmentIds, [idA, remoteId]);
    assert.equal(policyA.defaultWorkEnvironmentId, idA);

    const snapB = await authB.configurationClientState();
    const policyB = snapB.workEnvironmentPolicies.find(
      (record) => record.id === 'work-environment-policy:global:global'
    );
    assert.deepEqual(policyB.allowedWorkEnvironmentIds, [idB, remoteId]);
    assert.equal(policyB.defaultWorkEnvironmentId, idB);

    const storedPolicies = await loadRecordStore(
      paths.workEnvironmentPoliciesRootUri,
      paths.workEnvironmentPoliciesIndexUri,
      'policy'
    );
    const storedPolicy = storedPolicies.find(
      (record) => record.id === 'work-environment-policy:global:global'
    );
    assert.deepEqual(storedPolicy.allowedWorkEnvironmentIds, [remoteId]);
    assert.equal(storedPolicy.defaultWorkEnvironmentId, remoteId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
