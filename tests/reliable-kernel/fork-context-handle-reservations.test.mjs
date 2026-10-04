import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
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
const { stablePhaseFId } = load('backend/reliableKernel/phaseFIdentity.js');

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
  }))).snapshot;
}

async function withForkRuntime(run, {
  withTool = false, toolCallRequests = [1], beforeDispatch, beforeReply, compression = false, failRequests = [], script,
  extraModels = []
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-fork-lifecycle-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(path.join(directory, 'configuration')));
  let configuration = new VscodeConfigurationAuthority(getPaths);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'Offline fork fixture' }),
    id: 'offline-fork-provider', model: 'offline-fork-model',
    models: [{ id: 'offline-fork-model', name: 'Offline model' }, ...extraModels.map(id => ({ id, name: id }))] };
  for (const [section, settings] of [
    ['llmProviderConfigs', { configs: [provider] }],
    ['llm', { activeProviderConfigId: provider.id }]
  ]) {
    const current = await configuration.loadGlobalSettings(section);
    await configuration.saveGlobalSettings(section, settings, current.revision);
  }
  if (withTool) await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read'] });
  const compressionConfig = { ...protocol.createDefaultLlmCompressionConfig('Fork compression'), kind: 'llm_summary',
    fallbacks: [], trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 120000 } };
  const saveCompression = async (patch = {}) => {
    const current = await configuration.loadGlobalSettings('llmCompressionConfigs');
    await configuration.saveGlobalSettings('llmCompressionConfigs', { configs: [{ ...compressionConfig, ...patch }] }, current.revision);
  };
  if (compression) {
    await saveCompression();
    const current = await configuration.loadGlobalSettings('llmCompression');
    await configuration.saveGlobalSettings('llmCompression', {
      defaultConfigId: compressionConfig.id, providerBindings: [], modelBindings: []
    }, current.revision);
  }
  await script?.configure(configuration);
  const agent = await configuration.mutations.createAgent({ name: 'Fork fixture', kind: 'custom' });
  await configuration.mutations.setModelProfile({
    scopeKind: 'conversation', scopeId: 'source', providerConfigId: provider.id,
    provider: provider.provider, model: provider.model
  });
  const folderPath = path.join(directory, 'workspace');
  await fs.mkdir(folderPath);
  const uri = vscode.Uri.file(folderPath).toString();
  const environmentId = workEnvironmentIdFromUri(uri);
  await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
  await configuration.mutations.selectConversationWorkEnvironment('source', environmentId);
  const requests = [];
  let app;
  let facade;
  const open = async () => {
    configuration = new VscodeConfigurationAuthority(getPaths);
    // Reopening a Host must re-establish its local folder presence, as ProductRuntime.open does.
    // Persisted environment records alone do not prove that this window has the folder open.
    await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration,
      ...(compression ? { compressionSettingsAuthority: configuration } : {}),
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
      attachmentSettings: configuration,
      providers: { resolve(providerId) {
        assert.equal(providerId, provider.id);
        return { providerId, async sendFullRequest(request, controls) {
          requests.push(request);
          if (request.recipe?.compressionMethodKind) {
            await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { type: 'compression_result',
              contents: [{ role: 'user', parts: [{ text: `offline summary ${requests.length}` }] }] } });
            return;
          }
          await beforeReply?.(request);
          if (failRequests.includes(requests.length)) throw new Error(`offline provider rejected request ${requests.length}`);
          await controls.onEvent({ kind: 'completed', streamSeq: '1',
            content: { role: 'model', parts: script?.reply(request) ?? (withTool && toolCallRequests.includes(requests.length)
              ? [{ functionCall: { name: 'read', args: { path: 'synthetic-file.txt' } } }]
              : [{ text: `offline reply ${requests.length}` }]) } });
        } };
      } },
      toolDispatcher: {
        definitions() {
          return script?.definitions
            ?? (withTool ? [{ name: 'read', description: 'Synthetic offline probe', parameters: { type: 'object' } }] : []);
        },
        async dispatch(input) {
          assert.equal(withTool || !!script, true, 'only the tool fixtures may dispatch');
          await beforeDispatch?.(input);
          if (script?.dispatch) return script.dispatch(input, { app, configuration, provider });
          const settled = await app.runtime.effects.settleWithoutEffect({
            source: { kind: 'internal', key: `fixture-read:${input.toolCallId}` },
            toolCallId: input.toolCallId, status: 'succeeded',
            detail: script?.detail(input) ?? { text: 'synthetic tool result' }
          });
          return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
        }
      }
    });
    // Exercise the production fork method without starting VS Code watchers/panels. The database,
    // ownership pins, configuration stores, context writer and agent loop remain real.
    facade = Object.create(Facade.prototype);
    facade.product = { application: app, configuration };
    // Deleting a conversation records it beside the merge ledger of this configuration root.
    facade.runtimePlacement = { configurationRootPath: path.join(directory, 'configuration') };
    facade.writeGate = new RuntimeWriteGate();
    facade.historyEntries = [];
    facade.refreshConversationHistory = async () => {};
  };
  try {
    await open();
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'source', title: 'Source fixture', status: 'active', created_at: now, updated_at: now
      }),
      emptyConversationContextHandleStateStep('source', now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'source-agent', conversation_id: 'source', agent_id: agent.id,
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    const harness = {
      get app() { return app; }, get facade() { return facade; },
      get configuration() { return configuration; }, requests, environmentId, saveCompression, provider,
      /** `whileClosed` runs with the Runtime database closed, for example to stage an older data shape. */
      async reopen(whileClosed) { await app.close(); await whileClosed?.(); await open(); },
      async start(conversationId, key, retry, message = {}) {
        const command = {
          source: { kind: 'command', key }, conversationId,
          leaseOwnerId: 'fork-fixture-owner', hostBootId: app.database.hostBootId,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()
        };
        const input = retry
          ? await app.turns.retry({ ...command, ...retry })
          : await app.turns.input({ ...command, content: message.content ?? key,
            ...(message.contentType ? { contentType: message.contentType } : {}) });
        const [lease] = await rows(app, 'ExecutionLease', { turn_id: input.turnId });
        assert.ok(lease);
        const done = kernel.runWithExecutionLeaseFence({
          id: lease.id, conversationId, turnId: input.turnId, ownerId: lease.owner_id,
          hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
        }, () => app.agentLoop.drive(input.turnId));
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
            expectedRevisionId: revision.id, command: { commandId }
          };
        }
        assert.fail('fixture has no matching message');
      }
    };
    await run(harness);
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Waits for a fixture step, failing with the step's name instead of hanging the runner. */
function bounded(promise, step, ms = 30_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms waiting for ${step}.`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** A held Turn reaches its gate, unless it ends first. */
function reachedGate(reached, running, step) {
  return bounded(Promise.race([reached, running.done.then(result => {
    throw new Error(`The running Turn ended (${result.terminalStatus}) before ${step}.`);
  })]), step);
}

function createVscodeStub() {
  class Uri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = path.resolve(fsPath); this.path = this.fsPath.split(path.sep).join('/'); }
    static file(value) { return new Uri(value); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    toString() { return `file://${this.path}`; }
  }
  const FileType = { Unknown: 0, File: 1, Directory: 2 };
  return { Uri, FileType, workspace: { fs: {
    async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
    async readFile(uri) { return fs.readFile(uri.fsPath); },
    async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
    async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(entry => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]); },
    async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
    async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? FileType.Directory : FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }; }
  } } };
}



const { buildModelHandleCatalog, modelHandleTarget, resolveModelToolArguments,
  CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION } = load('backend/reliableKernel/modelHandleCatalog.js');
const { readConversationContextHandleCatalog } = load('backend/reliableKernel/conversationChildHandles.js');
const { prepareForkContextHandleReservations, readForkContextHandleReservationCatalog,
  assertForkContextHandleReservations } = load('backend/reliableKernel/forkContextHandleReservations.js');

function allTargets(prefix) {
  return { kind: 'agent_collaboration', processId: `${prefix}-process`, nextOutputHandle: `rk-process-output:${prefix}-cursor`,
    workEnvironmentId: `work-env-${prefix}`, answerBridgeId: `${prefix}-child`, conversationId: `${prefix}-conversation`,
    messageId: `${prefix}-message`, conversationMessageId: `${prefix}-conversation-message`, channelId: `${prefix}-channel`,
    threadId: `${prefix}-thread`, postId: `${prefix}-post` };
}
const identity = catalog => catalog.entries.map(({ kind, ref, target }) => ({ kind, ref, target }))
  .sort((left, right) => left.ref.localeCompare(right.ref));

test('fork excludes discarded branch bindings while copied occurrences survive nested forks and source deletion', async () => {
  let sourceCalled = false;
  let forkCalled = false;
  await withForkRuntime(async h => {
    h.facade.revealConversationHistoryTop = async () => {};
    await h.turn('source', 'first-input-no-handles');
    const original = await h.command('source', 'original-user', 'user');
    await h.turn('source', 'later-input-with-handles');
    const sourceCatalog = await readConversationContextHandleCatalog(h.app.database, h.app.contentStore, 'source');
    assert.deepEqual(sourceCatalog.entries.map(entry => entry.kind).sort(),
      ['process','cursor','workEnvironment','child','conversation','collaborationMessage','conversationMessage','boardChannel','boardThread','boardPost'].sort());
    await h.app.turns.edit({ source: { kind: 'command', key: 'discard-handle-suffix' }, conversationId: 'source',
      messageId: original.messageId, expectedRevisionId: original.expectedRevisionId,
      content: 'Edited retained prefix without historical bindings.', deleteFollowing: true });
    const [current] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: original.messageId });
    const command = { ...original, expectedRevisionId: current.revision_id, command: { commandId: 'fork-context-reservations' } };
    const fork = await h.facade.forkConversation(command);
    const inherited = await readConversationContextHandleCatalog(h.app.database, h.app.contentStore, fork.conversationId);
    assert.deepEqual(identity(inherited), []);
    const privateCatalog = await readForkContextHandleReservationCatalog(h.app.database, h.app.contentStore, fork.conversationId);
    assert.deepEqual(identity(privateCatalog), []);
    assert.equal((await h.facade.forkConversation(command)).deduplicated, true);
    const materialized = await h.app.context.materialize(await h.app.context.currentHeadRootId(fork.conversationId));
    assert.ok(materialized.segments.some(segment => segment.content.toString('utf8').includes('Edited retained prefix')));
    assert.ok(materialized.segments.every(segment => !segment.content.toString('utf8').includes('old-process')));
    assert.ok(materialized.segments.every(segment => !segment.content.toString('utf8').includes('fork-context-handle-reservations')));
    await h.turn(fork.conversationId, 'fork-new-handles');
    const next = h.requests.at(-1).recipe.modelHandleCatalog;
    assert.equal((await h.facade.forkConversation(command)).deduplicated, true, 'current head changes do not alter the original fork identity');
    for (const old of sourceCatalog.entries) {
      assert.equal(next.entries.some(entry => entry.kind === old.kind && entry.target === old.target), false,
        `${old.ref} from the discarded branch must not regain an active binding`);
    }
    assert.ok(next.entries.some(entry => entry.kind === 'process' && entry.target === 'new-process'));
    assert.equal((await rows(h.app, 'ProcessCompletionSourceLink', { conversation_id: fork.conversationId })).length, 0);
    assert.deepEqual(await rows(h.app, 'ChildExecution'), [], 'reserving A1 does not create child ownership');
    assert.deepEqual(h.requests.at(-1).recipe.tools.map(tool => tool.name), ['read']);
    const beforeNested = await readConversationContextHandleCatalog(h.app.database, h.app.contentStore, fork.conversationId);
    const nestedCommand = await h.command(fork.conversationId, 'nested-context-reservations');
    const nested = await h.facade.forkConversation(nestedCommand);
    assert.equal((await h.facade.forkConversation(nestedCommand)).deduplicated, true);
    assert.deepEqual(identity(await readConversationContextHandleCatalog(h.app.database, h.app.contentStore, nested.conversationId)), identity(beforeNested));
    await h.facade.deleteConversation('source');
    await h.facade.deleteConversation(fork.conversationId);
    await h.reopen();
    assert.deepEqual(identity(await readConversationContextHandleCatalog(h.app.database, h.app.contentStore, nested.conversationId)), identity(beforeNested));
    await h.turn(nested.conversationId, 'nested-continues-after-source-deletion');
    assert.ok(h.requests.at(-1).recipe.modelHandleCatalog.entries.some(entry => entry.kind === 'process' && entry.target === 'new-process'));
  }, { script: {
    async configure(configuration) { await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read'] }); },
    definitions: [{ name: 'read', description: 'Synthetic Context identity fixture', parameters: { type: 'object' } }],
    reply(request) {
      if (request.conversationId === 'source' && request.context.some(item => item.content.includes('later-input-with-handles')) && !sourceCalled) {
        sourceCalled = true;
        return [{ functionCall: { name: 'read', args: { path: 'old-targets.txt' } } }];
      }
      if (request.conversationId !== 'source' && !forkCalled) {
        forkCalled = true;
        return [{ functionCall: { name: 'read', args: { path: 'new-targets.txt' } } }];
      }
      return [{ text: 'Offline reply.' }];
    },
    detail() { return allTargets(forkCalled ? 'new' : 'old'); }
  } });
});

test('isolated fork reservation artifact preserves retired addresses, checks its scope, and cannot become the visible head', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'source-for-private-artifact');
    const target = 'private-reservation-target';
    const now = new Date().toISOString();
    const catalog = { ...buildModelHandleCatalog([allTargets('reserved')]),
      identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, retiredRefs: ['O9','P9','W9'] };
    const prepared = await prepareForkContextHandleReservations({ database: h.app.database, contentStore: h.app.contentStore,
      sourceConversationId: 'source', targetConversationId: target, targetContextRootId: 'private-visible-empty-root',
      rootShape: { rootNodeId: null, tailNodeId: null, tailSegmentCount: 0n, segmentCount: 0n },
      catalog, coveredRecipeObjectIds: [], now });
    await h.app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: target, title: 'Private reservation fixture', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('ConversationBranchLink').insert({ id: 'private-branch', target_conversation_id: target,
        source_conversation_id: 'source', source_message_revision_id: null, created_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({ id: 'private-visible-empty-root',
        conversation_id: target, root_node_id: null, tail_node_id: null, tail_segment_count: 0n,
        segment_count: 0n, estimated_tokens: 0n, created_at: now }, { column: 'root_seq', scope: { conversation_id: target } }),
      kernel.DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').insert({ id: 'private-visible-head',
        conversation_id: target, root_id: 'private-visible-empty-root', updated_at: now }),
      ...prepared.steps
    ]);
    const read = await readForkContextHandleReservationCatalog(h.app.database, h.app.contentStore, target);
    assert.deepEqual(read, catalog);
    assert.deepEqual((await h.app.context.materialize('private-visible-empty-root')).segments, []);
    await assertForkContextHandleReservations(h.app.database, h.app.contentStore, target, 'source');
    await assert.rejects(assertForkContextHandleReservations(h.app.database, h.app.contentStore, target, 'other-source'), /bound/);
    await assert.rejects(assertForkContextHandleReservations(h.app.database, h.app.contentStore, 'missing-target', 'source'), /missing/);
    const next = buildModelHandleCatalog([allTargets('following')], read);
    assert.equal(modelHandleTarget(next, 'process', 'P10'), 'following-process');
    assert.equal(modelHandleTarget(next, 'cursor', 'O10'), 'rk-process-output:following-cursor');
    assert.equal(modelHandleTarget(next, 'workEnvironment', 'W10'), 'work-env-following');
    assert.throws(() => resolveModelToolArguments('bash', { mode: 'kill', processRef: 'P9' }, read), /失效/);
    await h.reopen();
    assert.deepEqual(await readForkContextHandleReservationCatalog(h.app.database, h.app.contentStore, target), catalog);
    const [projection] = await rows(h.app, 'ModelContextProjection', { owner_kind: 'conversation_handle_catalog', owner_id: target });
    await h.app.database.transaction([kernel.DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').update('private-visible-head',
      { root_id: projection.root_id })]);
    await assert.rejects(readForkContextHandleReservationCatalog(h.app.database, h.app.contentStore, target), /isolated/);
  });
});

test('fork keeps its selected immutable scope when an unrelated suffix is appended before commit', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'before-concurrent-frontier');
    const rootId = await h.app.context.currentHeadRootId('source');
    const before = await h.app.context.materializeStructure(rootId);
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: 'source', role: 'default' });
    const fork = await h.app.runtime.conversationFork.fork({ idempotencyKey: 'frontier-race', reuseKey: 'frontier-race',
      sourceConversationId: 'source', sourceContextRootId: rootId, targetConversationId: 'frontier-race-target',
      targetAgentId: agent.agent_id, targetTitle: 'Frozen selected scope'
    }, { beforeCommit: () => h.turn('source', 'concurrent-new-request') });
    assert.notEqual(await h.app.context.currentHeadRootId('source'), rootId);
    const copied = await h.app.context.materializeStructure(fork.targetRootId);
    assert.deepEqual(copied.records.map(record => record.segment.id), before.records.map(record => record.segment.id));
    assert.equal((await rows(h.app, 'Conversation', { id: 'frontier-race-target' })).length, 1);
    assert.equal((await rows(h.app, 'ModelContextProjection', {
      owner_kind: 'conversation_handle_catalog', owner_id: 'frontier-race-target'
    })).length, 1);
  });
});


test('child fork freezes source reservations and replay verifies the child origin and parent relation', async () => {
  let suppliedOld = false;
  let spawned = false;
  let childRead = false;
  let spawnCommand;
  let spawnFailure;
  await withForkRuntime(async h => {
    await h.turn('source', 'first-child-fork-input');
    await h.turn('source', 'supply-old-child-fork-handles');
    const sourceCatalog = await readConversationContextHandleCatalog(h.app.database, h.app.contentStore, 'source');
    await h.turn('source', 'spawn-with-reservations');
    const [child] = await rows(h.app, 'ChildExecution');
    assert.ok(child, spawnFailure?.stack ?? `Child was not created; tool executions: ${JSON.stringify(
      await rows(h.app, 'ToolExecution'), (_key, value) => typeof value === 'bigint' ? String(value) : value)}`);
    const evidence = await readForkContextHandleReservationCatalog(h.app.database, h.app.contentStore, child.child_conversation_id);
    for (const old of sourceCatalog.entries) assert.equal(modelHandleTarget(evidence, old.kind, old.ref), old.target);
    assert.equal((await h.app.runtime.children.spawn(spawnCommand)).deduplicated, true);
    const [turnLink] = await rows(h.app, 'ChildExecutionTurnLink', { child_execution_id: child.id });
    const [lease] = await rows(h.app, 'ExecutionLease', { turn_id: turnLink.turn_id });
    await h.app.database.conversationOwners.claim(child.child_conversation_id);
    const result = await kernel.runWithExecutionLeaseFence({ id: lease.id, conversationId: child.child_conversation_id,
      turnId: turnLink.turn_id, ownerId: lease.owner_id, hostBootId: lease.host_boot_id,
      generation: BigInt(lease.generation) }, () => h.app.agentLoop.drive(turnLink.turn_id));
    assert.equal(result.terminalStatus, 'completed');
    const childCatalog = h.requests.filter(request => request.conversationId === child.child_conversation_id).at(-1).recipe.modelHandleCatalog;
    assert.equal(modelHandleTarget(childCatalog, 'process', 'P1'), 'old-process');
    assert.equal(modelHandleTarget(childCatalog, 'process', 'P2'), 'child-own-process');
    assert.deepEqual(await rows(h.app, 'ProcessCompletionSourceLink', { conversation_id: child.child_conversation_id }), []);
    const [parent] = await rows(h.app, 'ChildExecutionParentLink', { child_execution_id: child.id });
    const db = new Database(h.app.database.binding.paths.databasePath);
    try { db.prepare('UPDATE child_execution_parent_link SET source_tool_call_id = ? WHERE id = ?').run('different-source-call', parent.id); }
    finally { db.close(); }
    await assert.rejects(readForkContextHandleReservationCatalog(h.app.database, h.app.contentStore, child.child_conversation_id), /parent\/Turn\/ToolCall/);
  }, { script: {
    async configure(configuration) { await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read', 'run_agent'] }); },
    definitions: [
      { name: 'read', description: 'Synthetic process observations', parameters: { type: 'object' } },
      { name: 'run_agent', description: 'Spawn the child fixture', parameters: { type: 'object' } }
    ],
    reply(request) {
      if (request.conversationId === 'source') {
        if (request.context.some(item => item.content.includes('supply-old-child-fork-handles')) && !suppliedOld) {
          suppliedOld = true;
          return [{ functionCall: { name: 'read', args: { path: 'old-process.txt' } } }];
        }
        if (request.context.some(item => item.content.includes('spawn-with-reservations')) && !spawned) {
          spawned = true;
          return [{ functionCall: { name: 'run_agent', args: { operation: 'spawn', prompt: 'Read retained P1; own process uses a fresh address.' } } }];
        }
      } else if (!childRead) {
        childRead = true;
        return [{ functionCall: { name: 'read', args: { path: 'child-own-process.txt' } } }];
      }
      return [{ text: 'Offline child reply.' }];
    },
    async dispatch(input, { app, provider }) {
      if (input.toolName === 'run_agent') {
        const [agent] = await rows(app, 'AgentConversationLink', { conversation_id: 'source', role: 'default' });
        spawnCommand = { sourceToolCallId: input.toolCallId, childAgentId: agent.agent_id,
          modelFallback: { providerConfigId: provider.id, model: provider.model }, prompt: 'Read retained P1; own process uses a fresh address.',
          forkTurns: 'all', completionPolicy: 'background', sourceSettlement: 'child_handle',
          leaseOwnerId: 'child-reservation-fixture', leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() };
        const created = await app.runtime.children.spawn(spawnCommand).catch(error => {
          spawnFailure = error;
          throw error;
        });
        assert.equal(await app.runtime.children.claimSpawnDispatch(created.effectIntentId), true);
        const receipt = await app.runtime.children.recordSpawnReceipt({ sourceKey: `local-child-reservation:${created.attemptId}`,
          attemptId: created.attemptId, outcome: 'succeeded', detail: { adapter: 'reliable-local-agent-loop' } });
        await app.runtime.children.reconcileSpawnReceipt(receipt.effectReceiptId);
        return app.runtime.effects.readTerminalResult(input.toolCallId, true);
      }
      const settled = await app.runtime.effects.settleWithoutEffect({ source: { kind: 'internal', key: `child-identity:${input.toolCallId}` },
        toolCallId: input.toolCallId, status: 'succeeded', detail: childRead ? { processId: 'child-own-process' } : allTargets('old') });
      return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
    }
  } });
});

test('direct fork command replay checks its immutable creation root after the target continues and the source is deleted', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'direct-replay-source');
    const boundary = await h.command('source', 'unused-direct-replay-boundary');
    const [segment] = await rows(h.app, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: boundary.expectedRevisionId
    });
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: 'source', role: 'default' });
    const command = { idempotencyKey: 'continued-direct-fork', reuseKey: 'continued-direct-fork', sourceConversationId: 'source',
      sourceContextRootId: await h.app.context.currentHeadRootId('source'), sourceContextEndSegmentId: segment.segment_id,
      sourceMessageRevisionId: boundary.expectedRevisionId, expectedCurrentMessageRevisionId: boundary.expectedRevisionId,
      targetAgentId: agent.agent_id, targetTitle: 'Direct replay fixture' };
    const first = await h.app.runtime.conversationFork.fork(command);
    await h.turn(first.targetConversationId, 'continued-direct-target');
    assert.notEqual(await h.app.context.currentHeadRootId(first.targetConversationId), first.targetRootId);
    const replay = await h.app.runtime.conversationFork.fork(command);
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.targetRootId, first.targetRootId);
    await h.facade.deleteConversation('source');
    await h.reopen();
    assert.equal((await h.app.runtime.conversationFork.fork(command)).targetConversationId, first.targetConversationId);
  });
});
