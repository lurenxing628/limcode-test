import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const vscode = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: { fs: {
  createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }), readFile: uri => fs.readFile(uri.fsPath),
  async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
  async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(item => [item.name, item.isDirectory() ? 2 : 1]); },
  delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true }),
  async stat(uri) { const s = await fs.stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs }; }
} } };
Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
after(() => { Module._load = originalLoad; });

const dist = file => require(path.join(process.cwd(), 'dist/extension', file));
const { childConversationModelProfiles } = dist('backend/reliableKernel/childThinkingInheritance.js');
const kernel = dist('backend/reliableKernel/index.js');
const { VscodeConfigurationAuthority } = dist('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = dist('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = dist('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableChildAgentCoordinator } = dist('backend/reliableKernel/childAgentCoordinator.js');
const { readFrozenTurnAuthority } = dist('backend/reliableKernel/frozenAuthority.js');
const { ReliableToolDispatcher } = dist('backend/reliableKernel/toolDispatcher.js');
const {
  boundChildSkillPolicy,
  boundChildToolPolicy,
  frozenSkillPolicyDocument,
  frozenToolPolicyDocument,
  inheritedToolPolicyChain
} = dist('backend/reliableKernel/childExecutionBoundary.js');
const { toolAllowedByPolicy } = dist('shared/toolPolicyResolution.js');
const { isSkillEnabledByPolicy, skillCatalogWithinPolicy } = dist('backend/world/modules/skill/policy.js');

const resolved = (overrides = {}) => ({
  id: 'policy:child', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {}, ...overrides
});
const frozenPolicy = (overrides = {}) => ({
  id: 'policy:parent', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {}, ...overrides
});
const mcp = (sourceId, toolName) => ({ name: `${sourceId}_${toolName}`, source: { kind: 'mcp', sourceId, originalToolName: toolName } });

test('child built-in tools are its own list intersected with the parent Turn, keeping only its answer tool', () => {
  const bound = boundChildToolPolicy(
    resolved({ allowedTools: ['bash', 'read', 'submit_agent_answer', 'write'] }),
    frozenPolicy({ allowedTools: ['read', 'run_agent', 'write'] })
  );
  assert.deepEqual(bound.allowedTools, ['read', 'submit_agent_answer', 'write']);
  assert.deepEqual(bound.inherited.allowedTools, ['read', 'run_agent', 'write']);
  // A tool the child's own settings drop is never added back from the parent.
  assert.deepEqual(boundChildToolPolicy(resolved({ allowedTools: ['read'] }), frozenPolicy({ allowedTools: ['read', 'submit_agent_answer'] })).allowedTools, ['read']);
});

test('child MCP sources need both sides: allowlists intersect, disables add up, unconfigured parent sources stay off', () => {
  const bound = boundChildToolPolicy(
    resolved({ sourceConfigs: {
      exa: { enabled: true, enabledTools: ['search', 'crawl', 'answer'], disabledTools: ['answer'] },
      github: { enabled: true },
      only_child: { enabled: true }
    } }),
    frozenPolicy({ sourceConfigs: {
      '*': { enabled: false },
      exa: { enabled: true, enabledTools: ['search', 'answer'], disabledTools: ['crawl'] },
      github: { enabled: true, disabledTools: ['delete_repo'] }
    } })
  );
  assert.deepEqual(bound.sourceConfigs, {
    '*': { enabled: false },
    exa: { enabled: true, enabledTools: ['answer', 'search'], disabledTools: ['answer', 'crawl'] },
    github: { enabled: true, disabledTools: ['delete_repo'] },
    only_child: { enabled: false }
  });
  const allowed = tool => toolAllowedByPolicy(bound, tool);
  assert.equal(allowed(mcp('exa', 'search')), true);
  assert.equal(allowed(mcp('exa', 'answer')), false);
  assert.equal(allowed(mcp('exa', 'crawl')), false);
  assert.equal(allowed(mcp('github', 'list_issues')), true);
  assert.equal(allowed(mcp('github', 'delete_repo')), false);
  assert.equal(allowed(mcp('only_child', 'anything')), false);
  // A source only the parent enables never reaches a child whose own settings leave it off.
  const parentOnly = boundChildToolPolicy(resolved(), frozenPolicy({ sourceConfigs: { exa: { enabled: true } } }));
  assert.equal(toolAllowedByPolicy(parentOnly, mcp('exa', 'search')), false);
});

test('permission settings merge exactly; approvals and tool parameters stay per side', () => {
  const bound = boundChildToolPolicy(
    resolved({
      preset: 'yolo',
      toolConfigs: {
        write: { config: { allowOutsideProjectPaths: true }, autoApproveExecution: true },
        read: { config: { allowOutsideProjectPaths: true } },
        bash: { config: { denyCommands: ['rm -rf'], allowCommands: ['git'], limits: { lines: 10 } }, display: { autoExpand: true } },
        submit_plan: { config: { autoApprove: true } },
        ask_user: { config: { autoApprove: true } },
        run_agent: { config: { maxChildAgentDepth: 4, maxConcurrentAgents: 3 } }
      }
    }),
    frozenPolicy({
      toolConfigs: {
        read: { config: { allowOutsideProjectPaths: false } },
        bash: { config: { denyCommands: ['curl'] }, autoApproveExecution: false },
        submit_plan: { config: { autoApprove: true } },
        run_agent: { config: { maxChildAgentDepth: 2 } }
      }
    })
  );
  assert.equal(bound.preset, 'yolo');
  // write: the parent leaves the path setting to its default, so the child's explicit true falls back to it.
  assert.deepEqual(bound.toolConfigs.write, { config: {}, autoApproveExecution: true });
  assert.deepEqual(bound.toolConfigs.read, { config: { allowOutsideProjectPaths: false } });
  assert.deepEqual(bound.toolConfigs.bash, {
    config: { denyCommands: ['rm -rf', 'curl'], allowCommands: ['git'], limits: { lines: 10 } },
    display: { autoExpand: true }
  });
  assert.deepEqual(bound.toolConfigs.submit_plan, { config: { autoApprove: true } });
  assert.deepEqual(bound.toolConfigs.ask_user, { config: {} });
  assert.deepEqual(bound.toolConfigs.run_agent, { config: { maxChildAgentDepth: 2, maxConcurrentAgents: 3 } });
  // The default child depth (1) caps a parent that allows more.
  assert.equal(boundChildToolPolicy(resolved(), frozenPolicy({ toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3 } } } }))
    .toolConfigs.run_agent.config.maxChildAgentDepth, 1);
});

test('the inherited chain reaches the top-level Turn, nearest first', () => {
  const grandparent = frozenPolicy({ id: 'root', preset: 'custom', toolConfigs: { bash: { config: {}, autoApproveExecution: false } } });
  const parent = boundChildToolPolicy(resolved({ id: 'mid', preset: 'yolo' }), grandparent);
  const child = boundChildToolPolicy(resolved({ id: 'leaf' }), frozenToolPolicyDocument({ toolPolicy: parent }));
  assert.equal(child.inherited.id, 'mid');
  assert.equal(child.inherited.inherited.id, 'root');
  assert.deepEqual(inheritedToolPolicyChain(child).map(layer => layer.preset), ['yolo', 'custom']);
  assert.deepEqual(inheritedToolPolicyChain(resolved()), []);
  // A parent Turn that froze no tool policy could call no tool, so its child keeps only its answer tool.
  assert.deepEqual(boundChildToolPolicy(resolved({ allowedTools: ['read', 'submit_agent_answer'] }), frozenToolPolicyDocument({})).allowedTools,
    ['submit_agent_answer']);
});

test('a skill either side turns off stays off in the child; untouched sources stay on', () => {
  const bound = boundChildSkillPolicy(
    { id: 'skills:child', sourceConfigs: { agents: { enabled: true, disabledSkills: ['lint'] }, claude: { enabled: false } } },
    { id: 'skills:parent', sourceConfigs: { agents: { enabled: true, disabledSkills: ['deploy'] }, global: { enabled: false } } }
  );
  assert.deepEqual(bound.sourceConfigs, {
    agents: { enabled: true, disabledSkills: ['deploy', 'lint'] },
    claude: { enabled: false },
    global: { enabled: false }
  });
  assert.equal(bound.id, 'skills:child');
  assert.deepEqual(bound.inherited, { id: 'skills:parent', sourceConfigs: { agents: { enabled: true, disabledSkills: ['deploy'] }, global: { enabled: false } } });
  const on = (id, source) => isSkillEnabledByPolicy(bound, { id, source });
  assert.deepEqual([on('review', 'agents'), on('deploy', 'agents'), on('lint', 'agents'), on('x', 'claude'), on('y', 'global')], [true, false, false, false, false]);
  // A parent that froze no skill settings had every skill on.
  assert.deepEqual(frozenSkillPolicyDocument({}), { id: null, sourceConfigs: {} });
  assert.deepEqual(boundChildSkillPolicy({ id: null, sourceConfigs: {} }, frozenSkillPolicyDocument({})).sourceConfigs, {});
});

test('a skill the frozen policy turns off can be neither listed nor loaded', async () => {
  const skills = [{ id: 'deploy', slug: 'deploy', name: 'deploy', source: 'agents' }, { id: 'review', slug: 'review', name: 'review', source: 'agents' }];
  const catalog = {
    list: () => skills,
    get: (name, source) => skills.find(skill => skill.name === name && (!source || skill.source === source)),
    async readBody(name) { return `body of ${name}`; },
    async refresh() {}
  };
  const visible = skillCatalogWithinPolicy(catalog, { sourceConfigs: { agents: { enabled: true, disabledSkills: ['deploy'] } } });
  assert.deepEqual(visible.list().map(skill => skill.id), ['review']);
  assert.equal(visible.get('deploy'), undefined);
  assert.equal(visible.get('review').id, 'review');
  assert.equal(await visible.readBody('review', 'agents'), 'body of review');
  await assert.rejects(visible.readBody('deploy', 'agents'), /未找到技能：deploy/);
  assert.equal(skillCatalogWithinPolicy(catalog, undefined).get('deploy').id, 'deploy', 'no frozen skill settings: every skill is on');
});

test('VscodeConfigurationAuthority compiles a child Turn within its parent Turn and leaves top-level Turns unchanged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-tool-boundary-compile-'));
  try {
    const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(root)));
    await saveProvider(configuration);
    const parentAgent = await configuration.mutations.createAgent({ name: 'orchestrator', kind: 'custom' });
    const childAgent = await configuration.mutations.createAgent({ name: 'implementer', kind: 'custom' });
    await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: parentAgent.id,
      allowedTools: ['read', 'run_agent'], sourceConfigs: { exa: { enabled: true, enabledTools: ['search'] } } });
    await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: childAgent.id,
      allowedTools: ['bash', 'read', 'submit_agent_answer', 'write'], sourceConfigs: { exa: { enabled: true }, github: { enabled: true } } });
    await configuration.mutations.setSkillPolicy({ scopeKind: 'agent', scopeId: parentAgent.id, sourceConfigs: { agents: { enabled: true, disabledSkills: ['deploy'] } } });
    await configuration.mutations.setSkillPolicy({ scopeKind: 'agent', scopeId: childAgent.id, sourceConfigs: { claude: { enabled: false } } });
    const compile = async (turnId, agentId, extra = {}) => JSON.parse((await configuration.compile({
      conversationId: `conversation:${turnId}`, turnId, executorAgentId: agentId, intentKind: 'input', ...extra
    })).authoritySnapshot.content);
    const parent = await compile('parent-turn', parentAgent.id);
    assert.equal(parent.toolPolicy.inherited, undefined, 'a top-level Turn carries no inherited bound');
    assert.deepEqual(Object.keys(parent.skillPolicy), ['id', 'sourceConfigs'], 'nor inherited skill settings');
    const unbound = await compile('child-unbound', childAgent.id);
    assert.deepEqual(unbound.toolPolicy.allowedTools, ['bash', 'read', 'submit_agent_answer', 'write']);
    const child = await compile('child-turn', childAgent.id, {
      inheritedToolPolicy: frozenToolPolicyDocument(parent), inheritedSkillPolicy: frozenSkillPolicyDocument(parent)
    });
    assert.deepEqual(child.skillPolicy.sourceConfigs, { agents: { enabled: true, disabledSkills: ['deploy'] }, claude: { enabled: false } });
    assert.deepEqual(child.skillPolicy.inherited, frozenSkillPolicyDocument(parent));
    assert.deepEqual(child.toolPolicy.allowedTools, ['read', 'submit_agent_answer']);
    assert.deepEqual(child.toolPolicy.sourceConfigs, { exa: { enabled: true, enabledTools: ['search'] }, github: { enabled: false } });
    assert.deepEqual(child.toolPolicy.inherited, frozenToolPolicyDocument(parent));
    const preset = JSON.parse((await configuration.compile({ conversationId: 'conversation:preset', turnId: 'preset-turn',
      executorAgentId: childAgent.id, intentKind: 'input', inheritedToolPolicy: frozenToolPolicyDocument(parent) })).executionPreset.content);
    assert.deepEqual(preset.allowedTools, ['read', 'submit_agent_answer'], 'the execution preset shows the bounded list too');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** A child document two levels deep, as `readAuthority` sees it. */
function childDocument({ own = {}, parent = {}, grandparent = {} } = {}) {
  const top = frozenPolicy({ id: 'grandparent', allowedTools: ['bash', 'write'], ...grandparent });
  const mid = boundChildToolPolicy(resolved({ id: 'parent', allowedTools: ['bash', 'write'], ...parent }), top);
  const leaf = boundChildToolPolicy(resolved({ id: 'child', allowedTools: ['bash', 'write'], ...own }), frozenToolPolicyDocument({ toolPolicy: mid }));
  return { toolPolicy: leaf };
}

async function callAuthority(document, tool) {
  const fake = { authorityCache: new Map([['child-turn', Promise.resolve({ snapshotId: 'snapshot:child', document })]]) };
  return ReliableToolDispatcher.prototype.readAuthority.call(fake, 'child-turn', tool);
}

function decide(authority, toolName, args, metadata = {}) {
  return ReliableToolDispatcher.prototype.freezeDecision.call({}, {
    turnId: 'child-turn', modelRequestId: 'request', toolCallId: `${toolName}-call`, toolName, arguments: args,
    definition: { name: toolName, description: toolName, parameters: {}, metadata }
  }, undefined, authority);
}

test('a child call runs, applies changes and submits results on its own only when every ancestor agrees', async () => {
  const writeArgs = { path: 'a.txt', content: 'x' };
  const autoApply = { write: { config: {}, autoApplyChange: true } };
  const agreed = await callAuthority(childDocument({ own: { toolConfigs: autoApply }, parent: { toolConfigs: autoApply }, grandparent: { toolConfigs: autoApply } }), { name: 'write' });
  assert.equal(agreed.inheritedToolConfigs.length, 2);
  assert.deepEqual(decide(agreed, 'write', writeArgs), {
    displayAutoExpand: false, displayAutoOpenDiff: false, executionGate: 'automatic', changeApplyMode: 'automatic',
    changeApplyDelaySeconds: 0, autoSubmitResult: true, schedulingMode: 'serial', schedulingReason: 'frozen_default_serial'
  });
  // Only the child opts in: its ancestors keep the tool's default of manual application.
  const alone = await callAuthority(childDocument({ own: { toolConfigs: autoApply } }), { name: 'write' });
  assert.equal(decide(alone, 'write', writeArgs).changeApplyMode, 'manual');
  // A YOLO child under a grandparent that requires confirmation and manual application.
  const strict = await callAuthority(childDocument({
    own: { preset: 'yolo' },
    grandparent: { toolConfigs: { write: { config: {}, autoApproveExecution: false, autoApplyChange: false, autoSubmitResult: false } } }
  }), { name: 'write' });
  const decision = decide(strict, 'write', writeArgs);
  assert.equal(decision.executionGate, 'approval_required');
  assert.equal(decision.changeApplyMode, 'manual');
  assert.equal(decision.autoSubmitResult, false);
  // A YOLO parent does not loosen the child's own confirmation, and the longest apply delay wins.
  const delayed = await callAuthority(childDocument({
    own: { toolConfigs: { write: { config: {}, autoApproveExecution: false, autoApplyChange: true, autoApplyChangeDelaySeconds: 5 } } },
    parent: { preset: 'yolo' },
    grandparent: { toolConfigs: { write: { config: {}, autoApplyChange: true, autoApplyChangeDelaySeconds: 30 } } }
  }), { name: 'write' });
  const delayedDecision = decide(delayed, 'write', writeArgs);
  assert.equal(delayedDecision.executionGate, 'approval_required');
  assert.equal(delayedDecision.changeApplyMode, 'automatic');
  assert.equal(delayedDecision.changeApplyDelaySeconds, 30);
});

test('child commands pass every ancestor rule: allowlists, denies and read-only auto-approval', async () => {
  const authority = await callAuthority(childDocument({
    own: { toolConfigs: { bash: { config: { autoApproveReadonly: true } } } },
    grandparent: { toolConfigs: { bash: { config: { allowCommands: ['git', 'ls'], autoApproveReadonly: false }, autoApproveExecution: false } } }
  }), { name: 'bash' });
  const bash = command => decide(authority, 'bash', { command, explanation: 'check', foregroundWaitMs: 0 });
  assert.equal(bash('git status').executionGate, 'automatic', 'a command on the ancestor allowlist is approved there');
  const readonly = await callAuthority(childDocument({
    grandparent: { toolConfigs: { bash: { config: { autoApproveReadonly: false }, autoApproveExecution: false } } }
  }), { name: 'bash' });
  assert.equal(decide(readonly, 'bash', { command: 'ls', explanation: 'list', foregroundWaitMs: 0 }).executionGate, 'approval_required',
    'an ancestor that confirms every command also confirms read-only ones');

  const stop = new Error('process would start');
  const rejected = [];
  const dispatcher = {
    dependencies: { host: { async resolveProcessCwd() { throw stop; } } },
    async reject(input, reason) { rejected.push(reason); return { rejected: reason }; }
  };
  const run = (command, target = authority) => ReliableToolDispatcher.prototype.dispatchProcess.call(dispatcher,
    { toolName: 'bash', toolCallId: `bash-${command}`, arguments: { command, explanation: 'check', foregroundWaitMs: 0 } },
    target, new AbortController().signal);
  await assert.rejects(run('git status'), error => error === stop);
  assert.deepEqual(await run('rm -rf build'), { rejected: rejected.at(-1) });
  assert.match(rejected.at(-1), /上级对话冻结的 ToolPolicy 白名单/);
  const denied = await callAuthority(childDocument({ parent: { toolConfigs: { bash: { config: { denyCommands: ['curl'] } } } } }), { name: 'bash' });
  await run('curl example.invalid', denied);
  assert.match(rejected.at(-1), /黑名单拒绝：curl/);
});

test('MCP per-tool settings of every ancestor are found by source identity', async () => {
  const key = 'mcp:exa/search';
  const authority = await callAuthority(childDocument({
    grandparent: { toolConfigs: { [key]: { config: {}, autoApproveExecution: false } } }
  }), mcp('exa', 'search'));
  assert.deepEqual(authority.inheritedToolConfigs.map(layer => layer.toolConfig?.autoApproveExecution), [undefined, false]);
  assert.equal(decide(authority, 'exa_search', {}).executionGate, 'approval_required');
});

test('spawned, continued and user-started child Turns all stay within the parent Turn frozen at spawn and the latest work-environment bound', { timeout: 120000 }, async () => {
  await runtimeFixture(async f => {
    assert.equal((await f.app.agentLoop.runInput(f.input('spawn'))).terminalStatus, 'completed');
    await f.coordinator.waitForIdle();
    const [child] = await f.list('ChildExecution');
    const turns = async () => (await f.list('ChildExecutionTurnLink', { child_execution_id: child.id }))
      .sort((left, right) => Number(left.turn_seq) - Number(right.turn_seq));
    const [spawnTurn] = await turns();
    const spawned = (await f.frozen(spawnTurn.turn_id)).document.toolPolicy;
    assert.deepEqual(spawned.allowedTools, ['read', 'submit_agent_answer']);
    assert.deepEqual(spawned.inherited.allowedTools, ['read', 'run_agent']);
    const childWire = f.wires.find(wire => wire.conversationId === child.child_conversation_id);
    assert.deepEqual(childWire.body.tools.map(tool => tool.function.name).sort(), ['read'], 'bash never reaches the child model');

    // Widening the parent Agent later changes new spawns, not this child's frozen bound.
    await f.configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: f.parentAgent.id,
      allowedTools: ['bash', 'read', 'run_agent'], toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3 } } } });
    assert.equal((await f.app.agentLoop.runInput(f.input('follow-up'))).terminalStatus, 'completed');
    await f.coordinator.waitForIdle();
    await f.app.database.conversationOwners.claim(child.child_conversation_id);
    await f.coordinator.inputFromConversation({ commandId: 'user-in-child', childExecutionId: child.id,
      conversationId: child.child_conversation_id, content: 'run the tests yourself' });
    await f.coordinator.waitForIdle();
    const all = await turns();
    assert.equal(all.length, 3, 'spawn, parent follow-up and user input each ran one child Turn');
    for (const link of all) {
      const { toolPolicy, skillPolicy } = (await f.frozen(link.turn_id)).document;
      assert.deepEqual(toolPolicy.allowedTools, ['read', 'submit_agent_answer'], `child Turn ${link.turn_seq} stays bounded`);
      assert.deepEqual(toolPolicy.inherited, spawned.inherited);
      assert.deepEqual(skillPolicy.sourceConfigs, { agents: { enabled: true, disabledSkills: ['deploy'] } }, 'the parent skill setting reaches every child Turn');
    }
    // The Turn the user started takes the work environments of the child's previous Turn, as a continuation does.
    const [, previous, userTurn] = all;
    const request = f.compileRequests.find(candidate => candidate.turnId === userTurn.turn_id);
    const { enabled, allowedWorkEnvironmentIds, defaultWorkEnvironmentId } = (await f.frozen(previous.turn_id)).document.workEnvironmentPolicy;
    assert.deepEqual(request.inheritedWorkEnvironmentPolicy, { enabled, allowedWorkEnvironmentIds, defaultWorkEnvironmentId });
    assert.deepEqual(request.inheritedToolPolicy, spawned.inherited);
    assert.ok(request.inheritedSkillPolicy, 'the user-started Turn also carries the skill bound');
  }, {
    async send(request, controls, f) {
      let part = { text: 'done' };
      const history = JSON.stringify(request.context);
      const turnInput = request.conversationId !== 'parent' ? undefined
        : history.includes('synthetic input follow-up') ? 'follow-up'
          : history.includes('synthetic input spawn') ? 'spawn' : undefined;
      if (turnInput === 'spawn' && !f.sent.has('spawn')) {
        f.sent.add('spawn');
        part = { id: 'spawn-child', functionCall: { name: 'run_agent', args: { operation: 'spawn', taskName: 'Implement fix', prompt: 'implement the fix' } } };
      }
      if (turnInput === 'follow-up' && !f.sent.has('follow-up')) {
        f.sent.add('follow-up');
        const ref = request.recipe.modelHandleCatalog.entries.find(entry => entry.kind === 'child').ref;
        part = { id: 'follow-child', functionCall: { name: 'run_agent', args: { operation: 'send', childRef: ref, prompt: 'also add a test' } } };
      }
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [part] } });
    }
  });
});

async function saveProvider(configuration) {
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic' }), id: 'child-boundary', provider: 'openai-compatible',
    model: 'synthetic-model', models: [{ id: 'synthetic-model', name: 'synthetic' }], modelConfigs: [], generationConfig: {} };
  await save('llmProviderConfigs', { configs: [provider] });
  await save('llm', { activeProviderConfigId: provider.id });
  return provider;
}

async function runtimeFixture(run, hooks) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-tool-boundary-runtime-'));
  let app, coordinator;
  try {
    const { dryRunLlmProvider } = dist('backend/capabilities/llmProvider.js');
    const { applyFrozenModelProviderConfig } = dist('backend/reliableKernel/llmCapabilityProviderRegistry.js');
    const { LlmEventType } = dist('backend/world/modules/llm/events.js');
    const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
    await saveProvider(configuration);
    const parentAgent = await configuration.mutations.createAgent({ name: 'orchestrator', kind: 'custom' });
    const childAgent = await configuration.mutations.createAgent({ name: 'implementer', kind: 'custom' });
    await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: parentAgent.id,
      allowedTools: ['read', 'run_agent'], toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3 } } } });
    await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: childAgent.id,
      allowedTools: ['bash', 'read', 'submit_agent_answer', 'write'] });
    await configuration.mutations.setSkillPolicy({ scopeKind: 'agent', scopeId: parentAgent.id, sourceConfigs: { agents: { enabled: true, disabledSkills: ['deploy'] } } });
    const authority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    const requests = [], wires = [];
    let f;
    const list = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
    const frozen = async turnId => {
      const [row] = await list('AuthoritySnapshot', { turn_id: turnId });
      return readFrozenTurnAuthority(app.database, app.contentStore, row.id, turnId);
    };
    const compileRequests = [];
    const compiler = { async compile(request) { compileRequests.push(structuredClone(request)); return configuration.compile(request); } };
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: compiler, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        requests.push(request);
        let projected;
        const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
          start(input, emit) { projected = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
        });
        await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
        const effective = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
        const wire = await dryRunLlmProvider(projected, { settings: { ...effective, baseUrl: 'https://example.invalid/v1', apiKey: '' } });
        wires.push({ conversationId: request.conversationId, turnId: request.turnId, body: wire.body });
        return hooks.send(request, controls, f);
      } }; } },
      toolDispatcher: {
        definitions() {
          return ['bash', 'read', 'run_agent', 'write'].map(name => ({ name, description: 'synthetic', parameters: { type: 'object', properties: {} }, metadata: { readonly: name === 'read' } }));
        },
        async dispatch(input) {
          assert.equal(input.toolName, 'run_agent');
          const frozenAuthority = await frozen(input.turnId);
          return coordinator.dispatch(input, undefined, { snapshotId: frozenAuthority.snapshot.id, document: frozenAuthority.document,
            toolConfig: { config: { maxChildAgentDepth: 3 } } });
        }
      }
    });
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime, modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: childAgent.id, agentType: 'worker' }; } },
      // Production wiring (VscodeReliableKernelProductRuntime uses the same adapter).
      modelProfiles: childConversationModelProfiles(configuration.mutations)
    });
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'parent', title: 'Synthetic', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'parent-agent', conversation_id: 'parent', agent_id: parentAgent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    const input = key => ({ source: { kind: 'command', key }, conversationId: 'parent', leaseOwnerId: 'boundary-owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: `synthetic input ${key}` });
    f = { app, configuration, coordinator, parentAgent, childAgent, input, requests, wires, list, frozen, compileRequests, sent: new Set() };
    await run(f);
  } finally {
    if (coordinator) await coordinator.dispose();
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
