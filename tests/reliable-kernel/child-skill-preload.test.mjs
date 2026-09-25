import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
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
  async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs }; }
} } };
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const kernel = load('backend/reliableKernel/index.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { childConversationModelProfiles } = load('backend/reliableKernel/childThinkingInheritance.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');
const { PRELOADED_SKILLS_HEADER } = load('backend/reliableKernel/childExecution.js');
const { childInputWithPreloadedSkills, splitPreloadedSkills } = load('backend/reliableKernel/childSkillPreload.js');
const { readFrozenTurnAuthority } = load('backend/reliableKernel/frozenAuthority.js');
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { VscodeReliableToolHost } = load('backend/application/reliableKernel/VscodeReliableToolHost.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { runAgentTool } = load('backend/world/modules/tools/definitions/runAgent/index.js');
const { isSkillEnabledByPolicy } = load('backend/world/modules/skill/policy.js');
const { lookupSkill } = load('backend/world/modules/skill/skillLookup.js');
const { LlmEventType } = load('backend/world/modules/llm/events.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const call = (id, args) => ({ id, functionCall: { name: 'run_agent', args } });
const answer = text => ({ role: 'model', parts: [{ text }] });
const text = start => JSON.stringify(start.contents);

const skill = (source, name, extra = {}) => ({
  id: `skill:${source}:${name}`, name, slug: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name,
  description: `synthetic ${name}`, source, dir: `/skills/${source}/${name}`, path: `/skills/${source}/${name}/SKILL.md`, ...extra
});
const SKILLS = [
  skill('agents', 'review'),
  // The parent Agent turns this one off: the child's Turn inherits that.
  skill('agents', 'deploy'),
  // The child Agent's own settings turn the whole .claude source off.
  skill('claude', 'lint'),
  skill('agents', 'discord:access', { namespace: 'discord' }),
  skill('agents', 'telegram:access', { namespace: 'telegram' }),
  skill('agents', 'huge'),
  // Fits one preload (under 25K tokens and 256 KB) but not a small child context window.
  skill('agents', 'medium')
];
const BODIES = new Map([
  ['skill:agents:review', 'REVIEW_BODY_7781: run ${CLAUDE_SKILL_DIR}/scripts/check.sh before answering.'],
  ['skill:agents:deploy', 'DEPLOY_BODY_7782'],
  ['skill:claude:lint', 'LINT_BODY_7783'],
  ['skill:agents:discord:access', 'DISCORD_BODY'],
  ['skill:agents:telegram:access', 'TELEGRAM_BODY'],
  ['skill:agents:huge', `HUGE_BODY ${'x'.repeat(300 * 1024)}`],
  ['skill:agents:medium', `MEDIUM_BODY ${'m'.repeat(60 * 1024)}`]
]);

/**
 * Real SQLite, CAS, configuration, tool dispatcher, child scheduler and conversation runner; the
 * external model and the skill directory are synthetic. Skills load through the tool host's own
 * loadSkillsWithinPolicy, as in production.
 */
async function fixture(send, run, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-skill-preload-'));
  const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic skill preload' }), id: 'synthetic-skill-preload',
    provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'gpt-6-astra',
    models: [{ id: 'gpt-6-astra', name: 'synthetic' }], modelConfigs: [], generationConfig: {}, contextWindowTokens: options.contextWindowTokens ?? 200000 };
  const catalog = {
    list: () => SKILLS,
    lookup: (name, source) => lookupSkill(SKILLS, name, source),
    async readBody(record) {
      catalog.reads.push(record.id);
      return { text: BODIES.get(record.id), startLine: 5 };
    },
    async refresh() { catalog.refreshes += 1; },
    reads: [],
    refreshes: 0
  };
  const loads = [];
  const skills = {
    async loadSkillsWithinPolicy(names, policy) {
      loads.push(structuredClone({ names, policy }));
      return VscodeReliableToolHost.prototype.loadSkillsWithinPolicy.call({ skills: catalog }, names, policy);
    }
  };
  let app, coordinator, runner, worker;
  const errors = [], requests = [];
  const f = {
    errors, requests, loads, catalog,
    get app() { return app; }, get coordinator() { return coordinator; }, get worker() { return worker; },
    rows: async (domain, where = {}) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot,
    async until(check, message, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (errors.length) throw errors[0];
        const result = await check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(message);
    },
    async input(commandId) { return runner.input({ conversationId: 'root', commandId, text: commandId }); },
    async idle() {
      await f.until(async () => (await f.rows('Turn', { status: 'active' })).length === 0, 'the runtime did not settle');
      await runner.waitForIdle();
      await coordinator.waitForIdle();
    },
    async frozen(turnId) {
      const [row] = await f.rows('AuthoritySnapshot', { turn_id: turnId });
      return (await readFrozenTurnAuthority(app.database, app.contentStore, row.id, turnId)).document;
    },
    async content(contentObjectId) {
      const [metadata] = await f.rows('ContentObject', { id: contentObjectId });
      return (await app.contentStore.read(metadata)).toString('utf8');
    }
  };
  try {
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    const parent = await configuration.mutations.createAgent({ name: 'Synthetic root', kind: 'custom' });
    worker = await configuration.mutations.createAgent({ name: 'Synthetic worker', kind: 'custom' });
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['run_agent', 'skills'] });
    if (options.workerTools) {
      await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: worker.id, allowedTools: options.workerTools });
    }
    await configuration.mutations.setSkillPolicy({ scopeKind: 'agent', scopeId: parent.id,
      sourceConfigs: { agents: { enabled: true, disabledSkills: ['skill:agents:deploy'] } } });
    await configuration.mutations.setSkillPolicy({ scopeKind: 'agent', scopeId: worker.id,
      sourceConfigs: { claude: { enabled: false } } });
    const rootAuthority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(rootAuthority);
    app = await kernel.ReliableKernelApplication.open(rootAuthority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('External tool calls are forbidden in this fixture.'); } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        let start;
        const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
          start(input, emit) { start = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
        });
        await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
        requests.push({ conversationId: request.conversationId, start });
        let content;
        try {
          content = await send(request, f, start);
        } catch (error) {
          errors.push(error);
          content = answer('Synthetic provider assertion failed.');
        }
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
      } }; } },
      createToolDispatcher: dependencies => new ReliableToolDispatcher({ ...dependencies, effects: dependencies.runtime.effects,
        host: {
          definitions: () => [runAgentTool],
          dispatchSpecial: (_definition, input, authority, signal, admission) => coordinator.dispatch(input, signal, authority, admission),
          cancelTurnWaits: input => coordinator.cancelParentWaits(input),
          quiesce: reason => coordinator.quiesce(reason)
        }
      })
    });
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
      modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: worker.id, agentType: 'worker' }; } },
      modelProfiles: childConversationModelProfiles(configuration.mutations),
      skills,
      deliveryWakeups: app.processDeliveries, ownedProcessCleanup: app.childOwnedProcessCleanup
    });
    runner = new ReliableConversationRunner(app, 'synthetic-skill-preload-owner');
    const now = new Date().toISOString();
    await app.database.transaction([
      repo('Conversation').insert({ id: 'root', title: 'root', status: 'active', created_at: now, updated_at: now }),
      repo('AgentConversationLink').insert({ id: 'root-agent', conversation_id: 'root', agent_id: parent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    await app.recover();
    await run(f);
    assert.deepEqual(errors, []);
  } finally {
    runner?.dispose();
    if (coordinator) await coordinator.dispose();
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('spawn preloads the named skills into the child first input, within the child own Turn skill settings', { timeout: 90000 }, async () => {
  const TASK = 'TASK_4410: review the parser change and report findings.';
  let rootRound = 0, childStart;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (++rootRound === 1) {
        return { role: 'model', parts: [call('spawn-review', { operation: 'spawn', taskName: 'Review parser', prompt: TASK,
          skills: ['review', '$review'], foregroundWaitMs: 0 })] };
      }
      return answer(`Root round ${rootRound}.`);
    }
    childStart ??= start;
    return answer('Child finished the review.');
  }, async f => {
    await f.input('spawn-with-skills');
    await f.until(() => childStart, 'the child never reached its model');
    await f.idle();

    const [child] = await f.rows('ChildExecution');
    assert.ok(child, 'the spawn created a child');
    const [firstLink] = await f.rows('ChildExecutionTurnLink', { child_execution_id: child.id });
    const [inputLink] = await f.rows('MessageTurnLink', { turn_id: firstLink.turn_id, role: 'input' });
    const [current] = await f.rows('MessageCurrentRevisionLink', { message_id: inputLink.message_id });
    const [revision] = await f.rows('MessageRevision', { id: current.revision_id });
    const input = await f.content(revision.content_object_id);
    assert.ok(input.startsWith(`${PRELOADED_SKILLS_HEADER}\n<!-- limcode-preloaded-skills [{"name":"review","length":`), input.slice(0, 300));
    const split = splitPreloadedSkills(input);
    assert.deepEqual(split.skills.map(block => block.name), ['review']);
    assert.ok(split.skills[0].text.startsWith('<skill name="review" source=".agents">'));
    assert.ok(input.includes('REVIEW_BODY_7781: run /skills/agents/review/scripts/check.sh before answering.'),
      'the rendered skill (its directory filled in) is part of the committed first input');
    assert.equal(input.split('<skill name=').length - 1, 1, '"review" and "$review" name one skill, loaded once');
    const prompt = input.slice(input.indexOf(TASK));
    assert.ok(prompt.startsWith(`${TASK}\n\n[Agent answer]`), 'the task prompt follows the skills unchanged');
    assert.ok(input.endsWith(`\n\n${prompt}`));
    assert.ok(text(childStart).includes('REVIEW_BODY_7781'), 'the child model reads the preloaded skill');

    // Loaded once, within exactly the skill settings frozen for the child's first Turn: the
    // parent's disabled skill and the child's own disabled source are both off there.
    assert.equal(f.loads.length, 1);
    assert.deepEqual(f.loads[0].names, ['review', '$review']);
    const frozen = await f.frozen(firstLink.turn_id);
    assert.deepEqual(f.loads[0].policy, { sourceConfigs: frozen.skillPolicy.sourceConfigs });
    assert.equal(isSkillEnabledByPolicy(f.loads[0].policy, { id: 'skill:agents:deploy', source: 'agents' }), false);
    assert.equal(isSkillEnabledByPolicy(f.loads[0].policy, { id: 'skill:claude:lint', source: 'claude' }), false);

    // The spawn intent names the skills; the prompt it stores stays the task alone.
    const [intent] = await f.rows('EffectIntent', { effect_kind: 'subagent_spawn' });
    const request = JSON.parse(await f.content(intent.request_object_id));
    assert.deepEqual(request.skills, ['review', '$review']);
    assert.ok(request.prompt.startsWith(TASK) && !request.prompt.includes('REVIEW_BODY_7781'));

    // Re-dispatching the same ToolCall replays the committed child without reading skills again,
    // even after the skill changed on disk.
    const reads = f.catalog.reads.length;
    BODIES.set('skill:agents:review', 'REVIEW_BODY_CHANGED');
    try {
      const command = {
        sourceToolCallId: request.sourceToolCallId, childAgentId: request.childAgentId, modelFallback: request.modelFallback,
        prompt: request.prompt, forkTurns: request.forkTurns, completionPolicy: request.completionPolicy,
        sourceSettlement: request.sourceSettlement, title: request.title, leaseOwnerId: 'replay-owner',
        leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
        preloadSkills: { names: request.skills, async load() { throw new Error('a replay must not load skills'); } }
      };
      const replayed = await f.app.runtime.children.spawn(command);
      assert.equal(replayed.deduplicated, true);
      assert.equal(replayed.childExecutionId, child.id);
      assert.equal(f.catalog.reads.length, reads);
      await assert.rejects(f.app.runtime.children.spawn({ ...command, preloadSkills: { ...command.preloadSkills, names: ['review'] } }),
        /replayed with different facts/, 'the skill names are part of the spawn identity');
    } finally {
      BODIES.set('skill:agents:review', 'REVIEW_BODY_7781: run ${CLAUDE_SKILL_DIR}/scripts/check.sh before answering.');
    }
  });
});

test('a skill that is unknown, turned off, ambiguous or too large rejects the spawn with the explanation and creates no child', { timeout: 90000 }, async () => {
  const cases = {
    'spawn-parent-off': ['deploy'],
    'spawn-child-off': ['lint'],
    'spawn-unknown': ['nope'],
    'spawn-ambiguous': ['access'],
    'spawn-too-large': ['huge'],
    'spawn-one-bad': ['review', 'deploy']
  };
  let rootRound = 0, answered;
  await fixture(async (request, f, start) => {
    assert.equal(request.conversationId, 'root', 'no child conversation may reach a model');
    if (++rootRound === 1) {
      return { role: 'model', parts: Object.entries(cases).map(([id, skills]) =>
        call(id, { operation: 'spawn', taskName: id, prompt: `task of ${id}`, skills, foregroundWaitMs: 0 })) };
    }
    answered ??= start;
    return answer('Root adjusted the skill names.');
  }, async f => {
    await f.input('spawn-with-bad-skills');
    await f.until(() => answered, 'the parent never saw the failed spawns');
    await f.idle();

    assert.deepEqual(await f.rows('ChildExecution'), [], 'no child was created');
    assert.deepEqual(await f.rows('ChildExecutionParentLink'), []);
    assert.deepEqual(await f.rows('EffectIntent', { effect_kind: 'subagent_spawn' }), []);
    const results = new Map(answered.contents.flatMap(content => content.parts)
      .filter(part => part.functionResponse?.name === 'run_agent')
      .map(part => [part.id, `${part.functionResponse.response.status}: ${part.functionResponse.response.detail?.error}`]));
    assert.deepEqual([...results.keys()].sort(), Object.keys(cases).sort());
    for (const [id, result] of results) assert.match(result, /^failed: /, id);
    assert.match(results.get('spawn-parent-off'), /deploy.*source \.agents.*在当前 Turn 的技能设置里已关闭.*子 Agent 还受派出它的对话的设置限制/);
    assert.match(results.get('spawn-child-off'), /lint.*source \.claude.*在当前 Turn 的技能设置里已关闭/);
    assert.match(results.get('spawn-unknown'), /未找到技能 .*nope.*可用的技能：.*review/);
    assert.doesNotMatch(results.get('spawn-unknown'), /deploy|lint/, 'the available list is the child Turn list');
    assert.match(results.get('spawn-ambiguous'), /access.*对应多个技能：discord:access \(source \.agents\), telegram:access \(source \.agents\)/);
    assert.match(results.get('spawn-too-large'), /预载技能 huge 约 \d+ token，超过单个预载技能的上限 25000 token，没有创建子 Agent/);
    assert.match(results.get('spawn-one-bad'), /deploy.*已关闭/, 'one bad name rejects the whole spawn');
    for (const id of ['spawn-parent-off', 'spawn-child-off', 'spawn-one-bad']) {
      assert.doesNotMatch(results.get(id), /DEPLOY_BODY|LINT_BODY/);
    }
    assert.ok(!f.catalog.reads.includes('skill:agents:deploy') && !f.catalog.reads.includes('skill:claude:lint'),
      'a skill the child Turn turns off is never read');
  });
});

test('task previews show the child task, not the first lines of a preloaded skill', () => {
  const { childInputWithPreloadedSkills, childTaskTextForPreview } = load('backend/reliableKernel/childSkillPreload.js');
  const { renderLoadedSkill } = load('backend/world/modules/skill/skillLookup.js');
  const skillText = name => renderLoadedSkill({ name, source: '.claude', baseDirectory: `/skills/${name}` }, `# ${name}\n\nLong body.`);
  const input = childInputWithPreloadedSkills([skillText('review'), skillText('superpowers:tdd')], 'Review src/app.ts for races.');
  assert.equal(childTaskTextForPreview(input), '[skills: review, superpowers:tdd] Review src/app.ts for races.');
  assert.equal(childTaskTextForPreview('Plain task'), 'Plain task');
});

test('a child without the skills tool, or without room in its context window, gets no preloaded skills', { timeout: 90000 }, async () => {
  for (const [label, options, expected] of [
    ['no-skills-tool', { workerTools: ['read'] }, /子 Agent 的工具设置没有开启 skills 工具，不能给它预载技能；没有创建子 Agent/],
    ['small-window', { contextWindowTokens: 32000 }, /预载的 1 个技能约 \d+ token，超过子 Agent 模型上下文可留给预载的 \d+ token，没有创建子 Agent/]
  ]) {
    let rootRound = 0, answered;
    await fixture(async (request, f, start) => {
      assert.equal(request.conversationId, 'root', `${label}: no child conversation may reach a model`);
      if (++rootRound === 1) {
        return { role: 'model', parts: [call(`spawn-${label}`, { operation: 'spawn', taskName: label, prompt: `task ${label}`,
          skills: [label === 'small-window' ? 'medium' : 'review'], foregroundWaitMs: 0 })] };
      }
      answered ??= start;
      return answer('Root continued without the child.');
    }, async f => {
      await f.input(`spawn-${label}`);
      await f.until(() => answered, `${label}: the parent never saw the failed spawn`);
      await f.idle();
      assert.deepEqual(await f.rows('ChildExecution'), [], `${label}: no child was created`);
      const result = answered.contents.flatMap(content => content.parts)
        .find(part => part.functionResponse?.name === 'run_agent').functionResponse.response;
      assert.equal(result.status, 'failed', label);
      assert.match(result.detail?.error, expected, label);
    }, options);
  }
});

test('preloaded skill blocks are read back by their recorded lengths, whatever their text contains', () => {
  const tricky = '<skill name="writer" source=".claude">\nBase directory for this skill: /s/writer\n\nExample:\n</skill>\n\n<skill name="fake" source="x">\n</skill>';
  const plain = '<skill name="review" source=".agents">\nBase directory for this skill: /s/review\n\nbody\n</skill>';
  const prompt = `${PRELOADED_SKILLS_HEADER}\n\n<skill name="inside-prompt">\n</skill>\n\nDo the task.`;
  const input = childInputWithPreloadedSkills([tricky, plain], prompt);
  const split = splitPreloadedSkills(input);
  assert.deepEqual(split.skills.map(block => block.name), ['writer', 'review']);
  assert.equal(split.skills[0].text, tricky);
  assert.equal(split.skills[1].text, plain);
  assert.equal(split.prompt, prompt, 'a prompt that copies the header is still the prompt');
  assert.equal(splitPreloadedSkills(prompt), undefined, 'the header alone, without the manifest, is not a preload');
  assert.equal(splitPreloadedSkills(input.replace('"length":', '"length":1')), undefined, 'a manifest that does not match is rejected');
});
