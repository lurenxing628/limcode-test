// Real production fork lifecycle probes retained from the former focused suites.
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { createRequire } from 'node:module';

import { after } from 'node:test';

const require = createRequire(import.meta.url);

const Module = require('node:module');

const originalLoad = Module._load;

const vscode = createVscodeStub();

Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};

let sharedRuntime;
after(async () => {
  await sharedRuntime?.close();
  Module._load = originalLoad;
});

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');

const load = file => require(path.join(compiled, file));

const kernel = load('backend/reliableKernel/index.js');

const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');

const { upgradeConversationContextHandles } = load('backend/reliableKernel/conversationContextHandleUpgrade.js');

const { VscodeReliableKernelApplicationFacade: Facade } = load('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');

const { RuntimeWriteGate } = load('backend/application/reliableKernel/runtimeWriteGate.js');

const { ForkContextCandidateProbe } = load('backend/reliableKernel/conversationForkContext.js');

const { prepareChildContextFork } = load('backend/reliableKernel/childContextFork.js');

const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');

const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');

const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');

const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');

const { workEnvironmentIdFromUri } = load('shared/workEnvironmentCatalog.js');

const protocol = load('shared/protocol.js');

const { FORK_CONTEXT_HANDLE_RESERVATION_OWNER_KIND, FORK_CONTEXT_HANDLE_RESERVATION_PURPOSE,
  readForkContextHandleReservationEvidence } = load('backend/reliableKernel/forkContextHandleReservations.js');

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
  }))).snapshot;
}

// Each scenario owns a separate Conversation and policy. The expensive Application/SQLite
// lifecycle is shared, while explicit reopen probes still close and reopen the real Host.
export async function runtime() {
  return sharedRuntime ??= await createForkRuntime();
}

async function createForkRuntime() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-fork-lifecycle-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(path.join(directory, 'configuration')));
  let configuration = new VscodeConfigurationAuthority(getPaths);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'Offline fork fixture' }),
    id: 'offline-fork-provider', model: 'offline-fork-model',
    models: [{ id: 'offline-fork-model', name: 'Offline model' }] };
  for (const [section, settings] of [
    ['llmProviderConfigs', { configs: [provider] }],
    ['llm', { activeProviderConfigId: provider.id }]
  ]) {
    const current = await configuration.loadGlobalSettings(section);
    await configuration.saveGlobalSettings(section, settings, current.revision);
  }
  const agent = await configuration.mutations.createAgent({ name: 'Fork fixture', kind: 'custom' });
  const folderPath = path.join(directory, 'workspace');
  await fs.mkdir(folderPath);
  const uri = vscode.Uri.file(folderPath).toString();
  const environmentId = workEnvironmentIdFromUri(uri);
  const compressionConfig = { ...protocol.createDefaultLlmCompressionConfig('Fork compression'), kind: 'llm_summary',
    fallbacks: [], trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 120000 } };
  const saveCompression = async (patch = {}) => {
    const current = await configuration.loadGlobalSettings('llmCompressionConfigs');
    await configuration.saveGlobalSettings('llmCompressionConfigs', { configs: [{ ...compressionConfig, ...patch }] }, current.revision);
  };
  const initialCompressionSettings = (await configuration.loadGlobalSettings('llmCompression')).settings;
  let compressionEnabled = false;
  let active;
  let app;
  let facade;
  let sequence = 0;
  const sourceIds = [];
  let opens = 0;
  const open = async () => {
    configuration = new VscodeConfigurationAuthority(getPaths);
    // Reopening a Host must re-establish its local folder presence, as ProductRuntime.open does.
    await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration,
      compressionSettingsAuthority: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
      attachmentSettings: configuration,
      providers: { resolve(providerId) {
        assert.equal(providerId, provider.id);
        return { providerId, async sendFullRequest(request, controls) {
          const { requests, sourceId, withTool, toolCallRequests, beforeReply, failRequests, script } = active;
          requests.push(request);
          if (request.recipe?.compressionMethodKind) {
            await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { type: 'compression_result',
              contents: [{ role: 'user', parts: [{ text: `offline summary ${requests.length}` }] }] } });
            return;
          }
          await beforeReply?.(request);
          if (failRequests.includes(requests.length)) throw new Error(`offline provider rejected request ${requests.length}`);
          await controls.onEvent({ kind: 'completed', streamSeq: '1',
            content: { role: 'model', parts: script?.reply(request, sourceId) ?? (withTool && toolCallRequests.includes(requests.length)
              ? [{ functionCall: { name: 'read', args: { path: 'synthetic-file.txt' } } }]
              : [{ text: `offline reply ${requests.length}` }]) } });
        } };
      } },
      toolDispatcher: {
        definitions() {
          return active?.script?.definitions
            ?? (active?.withTool ? [{ name: 'read', description: 'Synthetic offline probe', parameters: { type: 'object' } }] : []);
        },
        async dispatch(input) {
          const { withTool, script, beforeDispatch } = active;
          assert.equal(withTool || !!script, true, 'only the tool fixtures may dispatch');
          await beforeDispatch?.(input);
          const settled = await app.runtime.effects.settleWithoutEffect({
            source: { kind: 'internal', key: `fixture-read:${input.toolCallId}` },
            toolCallId: input.toolCallId, status: 'succeeded',
            detail: script?.detail(input) ?? { text: 'synthetic tool result' }
          });
          return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
        }
      }
    });
    opens += 1;
    // Exercise the production Facade with real ownership, configuration, Context and agent loop.
    facade = Object.create(Facade.prototype);
    facade.product = { application: app, configuration };
    facade.runtimePlacement = { configurationRootPath: path.join(directory, 'configuration') };
    facade.writeGate = new RuntimeWriteGate();
    facade.historyEntries = [];
    facade.historyRevealEmitter = { fire() {} };
    facade.refreshConversationHistory = async () => {};
  };
  await open();
  return {
    get app() { return app; }, get configuration() { return configuration; }, get opens() { return opens; },
    get sourcePreparations() { return sourceIds.length; },
    async scope(options) {
      const scenarioId = `fork-scenario-${++sequence}`;
      const sourceId = options.sourceId ?? `${scenarioId}-source`;
      if (!options.sourceId) sourceIds.push(sourceId);
      const previous = new Set((await rows(app, 'Conversation')).map(row => row.id));
      previous.delete(sourceId);
      const requests = [];
      active = { ...options, sourceId, requests };
      if (!options.sourceId) {
        await configuration.mutations.setModelProfile({
          scopeKind: 'conversation', scopeId: sourceId, providerConfigId: provider.id,
          provider: provider.provider, model: provider.model
        });
        await configuration.mutations.selectConversationWorkEnvironment(sourceId, environmentId);
      }
      if (options.withTool) await configuration.mutations.setToolPolicy({
        scopeKind: 'conversation', scopeId: sourceId, allowedTools: ['read']
      });
      if (Boolean(options.compression) !== compressionEnabled) {
        if (options.compression) await saveCompression();
        const current = await configuration.loadGlobalSettings('llmCompression');
        await configuration.saveGlobalSettings('llmCompression', options.compression ? {
          defaultConfigId: compressionConfig.id, providerBindings: [], modelBindings: []
        } : initialCompressionSettings, current.revision);
        compressionEnabled = Boolean(options.compression);
      }
      await options.script?.configure(configuration, sourceId);
      if (!options.sourceId) {
        const now = new Date().toISOString();
        await app.database.transaction([
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
            id: sourceId, title: 'Source fixture', status: 'active', created_at: now, updated_at: now
          }),
          emptyConversationContextHandleStateStep(sourceId, now),
          kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
            id: `${sourceId}-agent`, conversation_id: sourceId, agent_id: agent.id,
            role: 'default', created_at: now, updated_at: now
          })
        ]);
      }
      const harness = {
        sourceId, settingsOwners: [...previous, ...sourceIds],
        get app() { return app; }, get facade() { return facade; },
        get configuration() { return configuration; }, requests, environmentId, saveCompression, provider,
        async conversations() { return (await rows(app, 'Conversation')).filter(row => !previous.has(row.id)); },
        async reopen() { await app.close(); await open(); },
        async start(conversationId, key, retry, message = {}) {
          const command = {
            source: { kind: 'command', key: `${scenarioId}:${key}` }, conversationId,
            leaseOwnerId: 'fork-fixture-owner', hostBootId: app.database.hostBootId,
            leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()
          };
          const input = retry
            ? await app.turns.retry({ ...command, ...retry })
            : await app.turns.input({ ...command, content: message.content ?? key,
              ...(message.contentType ? { contentType: message.contentType } : {}) });
          // This bare-application fixture intentionally has no ProductRuntime notification watcher.
          // Pump only its explicit scope-upgrade parking result, using the production target job;
          // all other waits remain observable and never become a fabricated completed Turn.
          const done = (async () => {
            for (;;) {
              const [lease] = await rows(app, 'ExecutionLease', { turn_id: input.turnId });
              assert.ok(lease);
              const result = await kernel.runWithExecutionLeaseFence({
                id: lease.id, conversationId, turnId: input.turnId, ownerId: lease.owner_id,
                hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
              }, () => app.agentLoop.drive(input.turnId));
              if (result.terminalStatus !== 'waiting' || result.waitingContextHandleUpgrade !== true) return result;
              await upgradeConversationContextHandles(app.database, app.contentStore, conversationId);
            }
          })();
          return { input, done };
        },
        async turn(conversationId, key, retry, message) {
          const { input, done } = await harness.start(conversationId, key, retry, message);
          const result = await done;
          assert.equal(result.terminalStatus, 'completed', JSON.stringify(await rows(app, 'TurnTermination', { turn_id: input.turnId })));
          return input;
        },
        async command(conversationId, commandId, role = 'model') {
          const memberships = await rows(app, 'MessagePartOfConversation', { conversation_id: conversationId });
          for (const member of memberships.sort((a, b) => Number(b.message_seq - a.message_seq))) {
            const [current] = await rows(app, 'MessageCurrentRevisionLink', { message_id: member.message_id });
            const [revision] = await rows(app, 'MessageRevision', { id: current.revision_id });
            if (revision.role === role) return {
              sourceConversationId: conversationId, messageId: member.message_id,
              expectedRevisionId: revision.id, command: { commandId: `${scenarioId}:${commandId}` }
            };
          }
          assert.fail('fixture has no matching message');
        }
      };
      return harness;
    },
    async close() { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
  };
}

async function withForkRuntime(run, options = {}) {
  const host = await runtime();
  await run(await host.scope({ withTool: false, toolCallRequests: [1], failRequests: [], ...options }));
}

// The completed transcript is one shared preparation. Each probe gets fresh request counters,
// command identities and targets; edits happen after rollback and acknowledgment replay probes.
let completedSourceId;
async function withCompletedSource(run) {
  const host = await runtime();
  const h = await host.scope({ withTool: false, toolCallRequests: [1], failRequests: [], sourceId: completedSourceId });
  if (!completedSourceId) {
    await h.turn(h.sourceId, 'source-input');
    completedSourceId = h.sourceId;
  }
  await run(h);
}

function bounded(promise, step, ms = 30_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms waiting for ${step}.`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function reachedGate(reached, running, step) {
  return bounded(Promise.race([reached, running.done.then(result => {
    throw new Error(`The running Turn ended (${result.terminalStatus}) before ${step}.`);
  })]), step);
}

async function publicContextRoots(h, conversationId) {
  const roots = await rows(h.app, 'ContextSequenceRoot', { conversation_id: conversationId });
  const [head] = await rows(h.app, 'ConversationContextHeadLink', { conversation_id: conversationId });
  const reservations = await rows(h.app, 'ModelContextProjection', {
    owner_kind: FORK_CONTEXT_HANDLE_RESERVATION_OWNER_KIND, owner_id: conversationId
  });
  assert.equal(reservations.length, 1, 'the fork owns one separately registered address artifact');
  const [reservation] = reservations;
  assert.equal(reservation.purpose, FORK_CONTEXT_HANDLE_RESERVATION_PURPOSE);
  assert.ok(roots.some(root => root.id === reservation.root_id), 'the private root remains retained');
  assert.notEqual(head.root_id, reservation.root_id, 'the address artifact is absent from the model-visible head');
  assert.deepEqual((await rows(h.app, 'ModelContextProjection', { root_id: reservation.root_id })).map(row => row.id),
    [reservation.id], 'no request or compression may project the private address root');
  assert.ok(await readForkContextHandleReservationEvidence(h.app.database, h.app.contentStore, conversationId),
    'the separately scoped artifact must still pass its complete ownership, CAS and coverage validation');
  const privateContext = await h.app.context.materializeStructure(reservation.root_id);
  assert.equal(privateContext.records.length, 1);
  const [record] = privateContext.records;
  assert.equal(record.segment.segment_kind, 'runtime_context');
  assert.deepEqual((await rows(h.app, 'ContextSegmentSource', { segment_id: record.segment.id })).map(row => row.source_kind),
    ['runtime_context'], 'private reservations contain no Message, Tool or Compression transcript provenance');
  return roots.filter(root => root.id !== reservation.root_id);
}

async function strayConversationSettings(configuration, keep) {
  const config = await configuration.configurationClientState();
  const stray = [];
  for (const [key, value] of Object.entries(config)) {
    if (!Array.isArray(value)) continue;
    for (const record of value) {
      const scoped = record?.scopeKind === 'conversation' ? record.scopeId : undefined;
      const owner = scoped ?? (key === 'conversationWorkflowSelections' || key === 'conversationWorkEnvironmentLinks'
        ? record.conversationId : undefined);
      if (owner !== undefined && !keep.includes(owner)) stray.push([key, owner]);
    }
  }
  return stray;
}

async function withSourceSettings(h) {
  await h.configuration.mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: h.sourceId, text: 'source prompt' });
  await h.configuration.mutations.selectConversationWorkflow({ conversationId: h.sourceId, scopeKind: 'global' });
}

async function firstMessageCommand(h, conversationId, commandId) {
  const [first] = (await rows(h.app, 'MessagePartOfConversation', { conversation_id: conversationId }))
    .sort((a, b) => Number(a.message_seq - b.message_seq));
  const [current] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: first.message_id });
  return { sourceConversationId: conversationId, messageId: first.message_id,
    expectedRevisionId: current.revision_id, command: { commandId } };
}

function contextToolNames(request) {
  return request.context.filter(item => item.segmentKind === 'tool_pair').map(item => JSON.parse(item.content).toolCall.toolName);
}

function createVscodeStub() {
  class Uri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = path.resolve(fsPath); this.path = this.fsPath.split(path.sep).join('/'); }
    static file(value) { return new Uri(value); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    toString() { return `file://${this.path}`; }
  }
  const FileType = { Unknown: 0, File: 1, Directory: 2 };
  return { Uri, FileType, window: {}, ProgressLocation: { Notification: 15 }, workspace: { fs: {
    async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
    async readFile(uri) { return fs.readFile(uri.fsPath); },
    async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
    async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(entry => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]); },
    async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
    async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? FileType.Directory : FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }; }
  } } };
}

const role = 'model';
const suffixCount = 24;
const compressed = false;

export const scenario1 = async () => {
    await withCompletedSource(async h => {
      const command = await h.command(h.sourceId, `fork-${role}`, role);
      const result = await h.facade.forkConversation(command);
      const target = result.conversationId;
      assert.equal(result.deduplicated, false);
      const copiedTurns = await rows(h.app, 'Turn', { conversation_id: target });
      assert.ok(copiedTurns.length);
      assert.ok(copiedTurns.every(turn => turn.status === 'terminated'));
      assert.deepEqual(await rows(h.app, 'ExecutionLease', { conversation_id: target }), []);
      const config = await h.configuration.configurationClientState();
      assert.equal(config.conversationWorkEnvironmentLinks.find(link => link.conversationId === target)?.workEnvironmentId, h.environmentId);
      const copiedCommand = await h.command(target, `nested-${role}`, role);
      await h.turn(target, 'target-before-reopen');
      assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /source-input/);
      await h.reopen();
      await h.turn(target, 'target-after-reopen');
      assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /target-before-reopen/);
      const replay = await h.facade.forkConversation(command);
      assert.equal(replay.conversationId, target);
      assert.equal(replay.deduplicated, true);
      const nested = await h.facade.forkConversation(copiedCommand).catch(error => {
        error.message = `forking the target's copied history: ${error.message}`;
        throw error;
      });
      await h.turn(nested.conversationId, 'nested-input');
      assert.equal((await h.conversations()).length, 3);
      assert.equal((await rows(h.app, 'MessagePartOfConversation', { conversation_id: h.sourceId })).length, 2);
    });
  };

export const scenario2 = async () => {
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let dispatches = 0;
  await withForkRuntime(async h => {
    await h.turn(h.sourceId, 'completed-tool-turn');
    const completed = await h.command(h.sourceId, 'fork-completed-turn');
    const running = await h.start(h.sourceId, 'running-tool-turn');
    await reachedGate(reached, running, 'its second tool dispatch');
    const [activeTurn] = (await rows(h.app, 'Turn', { conversation_id: h.sourceId })).filter(turn => turn.status === 'active');
    assert.equal(activeTurn.id, running.input.turnId);
    const activeModel = await h.command(h.sourceId, 'fork-active-model');
    const activeUser = await h.command(h.sourceId, 'fork-active-user', 'user');
    const watched = ['Conversation', 'ConversationBranchLink', 'ConversationReuseLink', 'ConversationAttachmentHandleLink',
      'ContextSequenceRoot', 'ContextSegmentSource', 'Message', 'Turn', 'TurnTermination'];
    const before = await Promise.all(watched.map(domain => rows(h.app, domain)));
    for (const command of [activeModel, activeUser]) {
      await assert.rejects(h.facade.forkConversation(command), kernel.ConversationForkRejectedError);
    }
    const rootId = await h.app.context.currentHeadRootId(h.sourceId);
    const [userSource] = await rows(h.app, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: activeUser.expectedRevisionId
    });
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: h.sourceId, role: 'default' });
    await assert.rejects(h.app.runtime.conversationFork.fork({
      idempotencyKey: 'direct-active-fork', reuseKey: 'direct-active-fork',
      sourceConversationId: h.sourceId, sourceContextRootId: rootId,
      sourceContextEndSegmentId: userSource.segment_id,
      sourceMessageRevisionId: activeUser.expectedRevisionId,
      targetTitle: 'Rejected active turn', targetAgentId: agent.agent_id
    }), kernel.ConversationForkRejectedError);
    assert.deepEqual(await Promise.all(watched.map(domain => rows(h.app, domain))), before,
      'a rejected fork must not write targets, handles, native results or Context');

    const fork = await h.facade.forkConversation(completed);
    await h.app.turns.interrupt({
      source: { kind: 'command', key: 'stop-running-after-fork' },
      turnId: running.input.turnId, reason: 'fixture stop after forking completed history'
    });
    release();
    const stopped = await bounded(running.done, 'the stopped Turn to end');
    assert.equal(stopped.terminalStatus, 'interrupted');
    const copiedTurns = await rows(h.app, 'Turn', { conversation_id: fork.conversationId });
    assert.equal(copiedTurns.length, 1);
    assert.ok(copiedTurns.every(turn => turn.status === 'terminated'));
    assert.deepEqual((await rows(h.app, 'TurnTermination', { turn_id: copiedTurns[0].id })).map(row => row.terminal_status), ['completed']);
    assert.doesNotMatch(JSON.stringify(await rows(h.app, 'Message')), /running-tool-turn/);

    // Completed tool-pair segments are shared with the fork; closing the source pair again is a no-op.
    const sourceTurnIds = new Set((await rows(h.app, 'Turn', { conversation_id: h.sourceId })).map(turn => turn.id));
    const sourceCalls = (await rows(h.app, 'ToolCall')).filter(call => sourceTurnIds.has(call.turn_id)
      && call.turn_id !== running.input.turnId);
    assert.equal(sourceCalls.length, 1);
    const [modelResult] = await rows(h.app, 'ToolModelResult', { tool_call_id: sourceCalls[0].id });
    const [resultSource] = await rows(h.app, 'ContextSegmentSource', { source_kind: 'tool_model_result', source_id: modelResult.id });
    assert.equal((await rows(h.app, 'ContextSegmentSource', { segment_id: resultSource.segment_id, source_kind: 'tool_call' })).length, 2);
    await h.app.agentLoop.appendTerminalToolPairOnce({
      conversationId: h.sourceId, toolCallId: sourceCalls[0].id, toolModelResultId: modelResult.id
    });
    await h.turn(h.sourceId, 'source-after-stop');
    await h.turn(fork.conversationId, 'fork-after-source-stop');
  }, {
    withTool: true,
    toolCallRequests: [1, 3],
    async beforeDispatch() {
      dispatches += 1;
      if (dispatches !== 2) return;
      entered();
      await gate;
    }
  });
};

export const scenario3 = async () => {
  await withCompletedSource(async h => {
    const user = await h.command(h.sourceId, 'user-to-edit', 'user');
    const assistant = await h.command(h.sourceId, 'assistant-after-edit');
    await h.app.turns.edit({
      source: { kind: 'command', key: 'edit-question-only' }, conversationId: h.sourceId,
      messageId: user.messageId, expectedRevisionId: user.expectedRevisionId,
      content: 'new-user-question', deleteFollowing: false
    });
    const fork = await h.facade.forkConversation(assistant);
    const [edited] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: user.messageId });
    const [editedRevision] = await rows(h.app, 'MessageRevision', { id: edited.revision_id });
    const [firstMember] = (await rows(h.app, 'MessagePartOfConversation', { conversation_id: fork.conversationId }))
      .sort((a, b) => Number(a.message_seq - b.message_seq));
    const [copiedCurrent] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: firstMember.message_id });
    const [copiedRevision] = await rows(h.app, 'MessageRevision', { id: copiedCurrent.revision_id });
    assert.equal(copiedRevision.content_object_id, editedRevision.content_object_id,
      'the target visible revision must agree with the current content sent to the provider');
    const estimator = new kernel.ReliableContextTokenEstimator(h.app.database, h.app.contentStore);
    for (const root of await publicContextRoots(h, fork.conversationId)) {
      await estimator.estimateRoot(root.id);
    }
    await h.turn(fork.conversationId, 'continue-edited-question');
    const context = h.requests.at(-1).context.map(item => item.content).join('\n');
    assert.match(context, /new-user-question/);
    assert.doesNotMatch(context, /source-input|changed source after the fork committed/);
    const nested = await h.facade.forkConversation(await h.command(fork.conversationId, 'fork-after-edited-question'));
    await h.turn(nested.conversationId, 'nested-edited-question');
  });
};

export const scenario4 = async () => {
  await withForkRuntime(async h => {
    await h.turn(h.sourceId, 'manual-compressed-input-1');
    const runner = new ReliableConversationRunner(h.app, 'fork-fixture-owner');
    let compressionTurnId;
    try {
      const expectedRootId = await h.app.context.currentHeadRootId(h.sourceId);
      const structure = await h.app.context.materializeStructure(expectedRootId);
      const compressed = await runner.manualCompression({
        commandId: 'manual-compression-before-fork', conversationId: h.sourceId,
        compressSegmentCount: structure.records.length, target: { kind: 'current_head', expectedRootId }
      });
      assert.equal(compressed.compression.status, 'compressed');
      compressionTurnId = compressed.turnId;
    } finally { runner.dispose(); }
    assert.equal((await rows(h.app, 'MessageTurnLink', { turn_id: compressionTurnId })).length, 0);
    await h.turn(h.sourceId, 'after-manual-compression');
    const fork = await h.facade.forkConversation(await h.command(h.sourceId, 'fork-compressed-source'));
    const [sourceBlock] = await rows(h.app, 'CompressionBlock', { conversation_id: h.sourceId });
    const [forkBlock] = await rows(h.app, 'CompressionBlock', { conversation_id: fork.conversationId });
    assert.ok(forkBlock, 'the fork owns a copy of the reachable compression block');
    assert.notEqual(forkBlock.id, sourceBlock.id);
    assert.equal(forkBlock.summary_object_id, sourceBlock.summary_object_id);
    assert.equal(forkBlock.created_at, sourceBlock.created_at);
    const [forkAuthority] = await rows(h.app, 'AuthoritySnapshot', { id: forkBlock.authority_snapshot_id });
    const [forkAuthorityTurn] = await rows(h.app, 'Turn', { id: forkAuthority.turn_id });
    assert.equal(forkAuthorityTurn.conversation_id, fork.conversationId,
      'the copied block freezes the authority of the copied manual compression Turn');
    assert.deepEqual((await rows(h.app, 'TurnTermination', { turn_id: forkAuthorityTurn.id })).map(row => row.terminal_status), ['completed']);
    assert.equal((await rows(h.app, 'ModelRequest', { turn_id: forkAuthorityTurn.id })).length,
      (await rows(h.app, 'ModelRequest', { turn_id: compressionTurnId })).length);
    const [summarySource] = await rows(h.app, 'ContextSegmentSource', { source_kind: 'compression_block', source_id: forkBlock.id });
    const [sourceSummary] = await rows(h.app, 'ContextSegmentSource', { source_kind: 'compression_block', source_id: sourceBlock.id });
    assert.equal(summarySource.segment_id, sourceSummary.segment_id, 'the immutable summary segment stays shared');
    const feed = (await h.app.database.clientProjectionSnapshot(fork.conversationId)).snapshot.activeConversationWindow;
    assert.deepEqual(feed.compressionBlocks.map(block => block.id), [forkBlock.id]);
    const forkMessageIds = (await rows(h.app, 'MessagePartOfConversation', { conversation_id: fork.conversationId })).map(row => row.message_id);
    assert.ok(forkMessageIds.includes(feed.compressionBlocks[0].anchor_message_id));

    assert.deepEqual(await h.facade.deleteConversation(h.sourceId), [h.sourceId]);
    assert.deepEqual(await rows(h.app, 'CompressionBlock', { id: sourceBlock.id }), []);
    await h.turn(fork.conversationId, 'fork-after-compressed-source-delete');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /offline summary/);
    const second = await h.facade.forkConversation(await h.command(fork.conversationId, 'refork-after-delete'));
    await h.turn(second.conversationId, 'second-generation-after-compressed-delete');
    const early = await h.facade.forkConversation(await firstMessageCommand(h, fork.conversationId, 'pre-compression-refork'));
    await h.turn(early.conversationId, 'continue-before-inherited-compression');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /manual-compressed-input-1/);
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: fork.conversationId, role: 'default' });
    const now = new Date().toISOString();
    const child = await prepareChildContextFork(h.app.database, h.app.contentStore, {
      sourceConversationId: fork.conversationId, targetConversationId: 'compressed-child-probe',
      targetAgentId: agent.agent_id, forkTurns: 'all', now
    });
    assert.ok(child.segments.length >= 4, 'the inherited compressed history is expanded for the child');
    await h.app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'compressed-child-probe', title: 'Child probe', status: 'active', created_at: now, updated_at: now
      }),
      ...child.steps
    ]);
  }, { compression: true });
};

export const scenario5 = async () => {
  await withCompletedSource(async h => {
    await withSourceSettings(h);
    const command = await h.command(h.sourceId, 'late-rejection', 'user');
    const database = h.app.database;
    const transaction = database.transaction.bind(database);
    let copied;
    database.transaction = async (steps, ...rest) => {
      if (copied === undefined && steps.some(step => step.kind === 'insert' && step.domain === 'Conversation')) {
        copied = await strayConversationSettings(h.configuration, h.settingsOwners);
        throw new kernel.ConversationForkRejectedError('injected rejection at the fork commit');
      }
      return transaction(steps, ...rest);
    };
    try {
      await assert.rejects(h.facade.forkConversation(command), /injected rejection at the fork commit/);
    } finally {
      database.transaction = transaction;
    }
    assert.ok(copied.some(([key]) => key === 'conversationWorkflowSelections') && copied.some(([key]) => key === 'systemPromptScopeLinks'),
      'fixture: the settings, the workflow selection included, were copied before the commit');
    assert.deepEqual(await strayConversationSettings(h.configuration, h.settingsOwners), []);
    assert.equal((await h.conversations()).length, 1);
  });
};

export const scenario6 = async () => {
  await withCompletedSource(async h => {
    await h.configuration.mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: h.sourceId, text: 'source prompt' });
    const command = await h.command(h.sourceId, 'lost-result', 'user');
    const first = await h.facade.forkConversation(command);
    await h.configuration.mutations.selectConversationWorkflow({
      conversationId: first.conversationId, scopeKind: 'global'
    });
    // The user resets the copied prompt on the branch; a replay must not refill the empty slot.
    await h.configuration.mutations.clearSystemPrompt('conversation', first.conversationId);
    await h.app.turns.edit({
      source: { kind: 'command', key: 'edit-after-fork' }, conversationId: h.sourceId,
      messageId: command.messageId, expectedRevisionId: command.expectedRevisionId,
      content: 'changed source after the fork committed'
    });
    await h.reopen();
    assert.deepEqual(await h.facade.forkConversation(command), { ...first, deduplicated: true });
    const config = await h.configuration.configurationClientState();
    assert.equal(config.conversationWorkflowSelections.find(item => item.conversationId === first.conversationId)?.scopeKind, 'global');
    assert.equal(config.systemPromptScopeLinks.some(link => link.scopeKind === 'conversation' && link.scopeId === first.conversationId), false);
    await assert.rejects(h.facade.forkConversation({ ...command, command: { commandId: 'new-stale-fork' } }),
      error => error instanceof kernel.ConversationForkRejectedError && /Revision/.test(error.message));
    assert.equal((await h.conversations()).length, 2);
    await h.turn(first.conversationId, 'unchanged-fork-input');
    assert.doesNotMatch(h.requests.at(-1).context.map(item => item.content).join('\n'), /changed source after/);
  });
};

export const scenario7 = async () => {
  const planPolicy = { mode: 'before_mutation', allowReadonlyBeforeApproval: false, requireForToolRiskLevels: ['write'] };
  await withForkRuntime(async h => {
    await h.turn(h.sourceId, 'plan-source-input');
    const [originalPlan] = await rows(h.app, 'ToolCall', { tool_name: 'submit_plan' });
    assert.ok(originalPlan);
    const first = await h.facade.forkConversation(await h.command(h.sourceId, 'plan-first-fork'));
    const second = await h.facade.forkConversation(await h.command(first.conversationId, 'plan-second-fork'));
    const [copiedTurn] = await rows(h.app, 'Turn', { conversation_id: second.conversationId });
    const [copiedPlan] = await rows(h.app, 'ToolCall', { turn_id: copiedTurn.id, tool_name: 'submit_plan' });
    assert.notEqual(copiedPlan.id, originalPlan.id, 'the second fork owns its own copied ToolCall');
    const boundary = await h.command(second.conversationId, 'plan-retry-boundary');
    const retry = await h.turn(second.conversationId, 'plan-retry-in-nested-fork', {
      sourceTurnId: copiedTurn.id, target: { kind: 'message', messageId: boundary.messageId },
      expectedMessageRevisionId: boundary.expectedRevisionId
    });
    const [snapshot] = await rows(h.app, 'AuthoritySnapshot', { turn_id: retry.turnId });
    const { readFrozenTurnAuthority } = load('backend/reliableKernel/frozenAuthority.js');
    const authority = await readFrozenTurnAuthority(h.app.database, h.app.contentStore, snapshot.id, retry.turnId);
    assert.equal(authority.document.retryLineage.inheritedPlanApprovalToolCallId, copiedPlan.id);
    assert.equal(authority.document.planReviewPolicy.mode, planPolicy.mode);
    const [mutation] = await rows(h.app, 'ToolCall', { turn_id: retry.turnId, tool_name: 'read' });
    assert.ok(mutation, 'the retried turn issued a gated tool call');
    const gate = new kernel.FrozenAuthorityMcpPolicyGate(h.app.database, h.app.contentStore);
    assert.deepEqual(await gate.authorize({ toolCallId: mutation.id, serverId: 'fixture-mcp', toolName: 'read', riskLevel: 'write' }),
      { toolPolicyAllowed: true, planReviewAllowed: true });
    const review = input => kernel.authorizeFrozenPlanReview({
      database: h.app.database, contentStore: h.app.contentStore, turnId: retry.turnId,
      beforeCallSeq: mutation.call_seq, riskLevel: 'write', ...input
    });
    assert.deepEqual(await review({ authorityDocument: authority.document }), { allowed: true });
    const { retryLineage, ...withoutLineage } = authority.document;
    assert.equal((await review({ authorityDocument: withoutLineage })).allowed, false,
      'the nested fork is authorized by the inherited approval, not by an unrelated fact');
  }, { script: {
    async configure(configuration, sourceId) {
      await configuration.mutations.setToolPolicy({ scopeKind: 'conversation', scopeId: sourceId, allowedTools: ['read', 'submit_plan'], sourceConfigs: { 'fixture-mcp': { enabled: true } } });
      await configuration.mutations.setPlanReviewPolicy({ scopeKind: 'conversation', scopeId: sourceId, ...planPolicy });
    },
    definitions: [
      { name: 'submit_plan', description: 'Synthetic plan', parameters: { type: 'object' } },
      { name: 'read', description: 'Synthetic offline probe', parameters: { type: 'object' } }
    ],
    // Scripted by the Context each request already holds, so extra model requests cannot shift it.
    reply(request, sourceId) {
      const called = contextToolNames(request);
      if (request.conversationId === sourceId) {
        return called.includes('submit_plan') ? undefined : [{ functionCall: { name: 'submit_plan', args: { plan: 'fork plan' } } }];
      }
      return called.includes('read') ? undefined : [{ functionCall: { name: 'read', args: { path: 'synthetic-file.txt' } } }];
    },
    detail(input) {
      return input.toolName === 'submit_plan'
        ? { kind: 'submit_plan.result', proposalId: 'fork-plan', status: 'approved', executionTarget: 'current_conversation' }
        : { text: 'synthetic tool result' };
    }
  } });
};

export const scenario8 = async t => {
    await withForkRuntime(async h => {
      const turn = await h.turn(h.sourceId, 'scale-boundary');
      const command = await h.command(h.sourceId, `scale-fork-${suffixCount}`, 'user');
      if (compressed) {
        const [authority] = await rows(h.app, 'AuthoritySnapshot', { turn_id: turn.turnId });
        const rootId = await h.app.context.currentHeadRootId(h.sourceId);
        const structure = await h.app.context.materializeStructure(rootId);
        await h.app.compression.create({
          conversationId: h.sourceId, headRootId: rootId, authoritySnapshotId: authority.id,
          compressSegmentCount: structure.records.length, title: 'Scale summary',
          summary: 'Synthetic compressed history', idempotencyKey: 'scale-compression'
        });
      }
      for (let index = 0; index < suffixCount; index += 1) {
        await h.app.context.appendContent({
          conversationId: h.sourceId, segmentKind: 'system',
          source: { sourceKind: 'system', sourceId: `scale-${index}`, sourceRevision: 0n },
          content: `synthetic suffix ${index}`, contentType: 'text/plain'
        });
      }
      const database = h.app.database;
      const materialize = database.materializeContext.bind(database);
      const snapshot = database.snapshot.bind(database);
      const mayContain = ForkContextCandidateProbe.prototype.mayContain;
      let candidateMetrics;
      ForkContextCandidateProbe.prototype.mayContain = async function (...args) {
        try { return await mayContain.apply(this, args); }
        finally { candidateMetrics = this.metrics; }
      };
      let nodeReads = 0;
      database.snapshot = async (reads, ...rest) => {
        nodeReads += reads.filter(read => read.domain === 'ContextSequenceNode').length;
        return snapshot(reads, ...rest);
      };
      let materializedRecords = 0;
      let materializations = 0;
      database.materializeContext = async (...args) => {
        const result = await materialize(...args);
        materializations += 1;
        materializedRecords += result.snapshot.records.length;
        return result;
      };
      const start = performance.now();
      try {
        await h.facade.forkConversation(command);
      } finally {
        database.materializeContext = materialize;
        database.snapshot = snapshot;
        ForkContextCandidateProbe.prototype.mayContain = mayContain;
      }
      t.diagnostic(JSON.stringify({ compressed, suffixCount, materializations, materializedRecords, nodeReads, candidateMetrics, elapsedMs: Math.round(performance.now() - start) }));
      assert.ok(candidateMetrics.nodeReads <= suffixCount + 3, 'candidate probe reads each distinct physical node once');
      assert.equal(candidateMetrics.cacheStates, candidateMetrics.nodeReads, 'one state per node, not per (node, remaining)');
      assert.ok(candidateMetrics.windowChecks <= 2 * (suffixCount + 3), 'constant work per semantic window');
      assert.ok(candidateMetrics.segmentReads <= suffixCount + 3);
      assert.ok(nodeReads <= 4 * (suffixCount + 2), 'shared parent chains must be memoized');
      assert.ok(materializedRecords <= 12 * (suffixCount + 2),
        'history selection must not materialize every growing source root');
    });
  };
