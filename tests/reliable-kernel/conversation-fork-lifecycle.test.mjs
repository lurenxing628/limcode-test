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
const { VscodeReliableKernelApplicationFacade: Facade } = load('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
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
        // Match claim-before-open: keep the panel's reference through the whole fake-provider turn.
        await app.database.conversationOwners.retain(conversationId, `fixture-panel:${conversationId}`);
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

for (const role of ['user', 'model']) {
  test(`fork at ${role} boundary continues, reopens, continues again and forks its copied history`, async () => {
    await withForkRuntime(async h => {
      await h.turn('source', 'source-input');
      const command = await h.command('source', `fork-${role}`, role);
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
      assert.equal((await rows(h.app, 'Conversation')).length, 3);
      assert.equal((await rows(h.app, 'MessagePartOfConversation', { conversation_id: 'source' })).length, 2);
    });
  });
}

test('fork copies completed turns only and the running source turn still stops normally', async () => {
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let dispatches = 0;
  await withForkRuntime(async h => {
    await h.turn('source', 'completed-tool-turn');
    const completed = await h.command('source', 'fork-completed-turn');
    const running = await h.start('source', 'running-tool-turn');
    await reachedGate(reached, running, 'its second tool dispatch');
    const [activeTurn] = (await rows(h.app, 'Turn', { conversation_id: 'source' })).filter(turn => turn.status === 'active');
    assert.equal(activeTurn.id, running.input.turnId);
    const activeModel = await h.command('source', 'fork-active-model');
    const activeUser = await h.command('source', 'fork-active-user', 'user');
    const watched = ['Conversation', 'ConversationBranchLink', 'ConversationReuseLink', 'ConversationAttachmentHandleLink',
      'ContextSequenceRoot', 'ContextSegmentSource', 'Message', 'Turn', 'TurnTermination'];
    const before = await Promise.all(watched.map(domain => rows(h.app, domain)));
    for (const command of [activeModel, activeUser]) {
      await assert.rejects(h.facade.forkConversation(command), kernel.ConversationForkRejectedError);
    }
    const rootId = await h.app.context.currentHeadRootId('source');
    const [userSource] = await rows(h.app, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: activeUser.expectedRevisionId
    });
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: 'source', role: 'default' });
    await assert.rejects(h.app.runtime.conversationFork.fork({
      idempotencyKey: 'direct-active-fork', reuseKey: 'direct-active-fork',
      sourceConversationId: 'source', sourceContextRootId: rootId,
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
    const sourceCalls = (await rows(h.app, 'ToolCall')).filter(call => call.turn_id !== running.input.turnId
      && !copiedTurns.some(turn => turn.id === call.turn_id));
    assert.equal(sourceCalls.length, 1);
    const [modelResult] = await rows(h.app, 'ToolModelResult', { tool_call_id: sourceCalls[0].id });
    const [resultSource] = await rows(h.app, 'ContextSegmentSource', { source_kind: 'tool_model_result', source_id: modelResult.id });
    assert.equal((await rows(h.app, 'ContextSegmentSource', { segment_id: resultSource.segment_id, source_kind: 'tool_call' })).length, 2);
    await h.app.agentLoop.appendTerminalToolPairOnce({
      conversationId: 'source', toolCallId: sourceCalls[0].id, toolModelResultId: modelResult.id
    });
    await h.turn('source', 'source-after-stop');
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
});

async function contextSegmentIds(app, rootId) {
  return (await app.context.materializeStructure(rootId)).records.map(record => record.segment.id);
}

/** Every copied Turn owns its frozen authority and every copied request its re-homed projection. */
async function assertOwnedTurnHistory(h, sourceConversationId, targetConversationId) {
  const sourceRequests = (await Promise.all((await rows(h.app, 'Turn', { conversation_id: sourceConversationId }))
    .map(turn => rows(h.app, 'ModelRequest', { turn_id: turn.id })))).flat();
  const copiedTurns = await rows(h.app, 'Turn', { conversation_id: targetConversationId });
  for (const turn of copiedTurns) {
    const authorities = await rows(h.app, 'AuthoritySnapshot', { turn_id: turn.id });
    assert.equal(authorities.length, 1, 'each copied Turn owns exactly one frozen authority');
    for (const request of await rows(h.app, 'ModelRequest', { turn_id: turn.id })) {
      assert.equal(request.authority_snapshot_id, authorities[0].id);
      const [projection] = await rows(h.app, 'ModelContextProjection', { owner_kind: 'model_request', owner_id: request.id });
      assert.ok(projection, `copied request ${request.id} keeps its frozen Context projection`);
      const [root] = await rows(h.app, 'ContextSequenceRoot', { id: projection.root_id });
      assert.equal(root.conversation_id, targetConversationId, 'the projection is re-homed onto the fork history');
      const source = sourceRequests.find(candidate => candidate.recipe_object_id === request.recipe_object_id
        && candidate.request_seq === request.request_seq);
      const [sourceProjection] = await rows(h.app, 'ModelContextProjection', { owner_kind: 'model_request', owner_id: source.id });
      assert.deepEqual(await contextSegmentIds(h.app, projection.root_id), await contextSegmentIds(h.app, sourceProjection.root_id));
    }
  }
  return copiedTurns;
}

test('fork after in-turn automatic compression keeps completed turns, frozen authority and projections', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', `long history ${'以前的重要历史。'.repeat(12000)}`);
    await h.saveCompression({ trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 } });
    const compressedTurn = await h.turn('source', 'after-automatic-compression');
    assert.equal((await rows(h.app, 'ModelRequest', { turn_id: compressedTurn.turnId })).length, 2,
      'the Turn made one compression and one ordinary request');
    assert.equal((await rows(h.app, 'CompressionBlock')).length, 1);
    const fork = await h.facade.forkConversation(await h.command('source', 'fork-after-auto-compression'));
    const copiedTurns = await assertOwnedTurnHistory(h, 'source', fork.conversationId);
    assert.equal(copiedTurns.length, 2);
    for (const turn of copiedTurns) {
      assert.deepEqual((await rows(h.app, 'TurnTermination', { turn_id: turn.id })).map(row => row.terminal_status), ['completed']);
    }
    const copiedAnswer = await h.command(fork.conversationId, 'retry-copied-answer');
    const [answerTurn] = await rows(h.app, 'MessageTurnLink', { message_id: copiedAnswer.messageId, role: 'model' });
    assert.equal((await rows(h.app, 'ModelRequest', { turn_id: answerTurn.turn_id })).length, 2,
      'the copied Turn keeps its compression request');
    // Retrying a copied Turn inherits that Turn's own frozen authority inside the fork.
    await h.turn(fork.conversationId, 'retry-copied-compressed-turn', {
      sourceTurnId: answerTurn.turn_id, target: { kind: 'message', messageId: copiedAnswer.messageId },
      expectedMessageRevisionId: copiedAnswer.expectedRevisionId
    });
    await h.turn(fork.conversationId, 'continue-after-compressed-fork');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /offline summary/);
  }, { compression: true });
});

test('forking a completed message never copies a later turn that compressed its history', async () => {
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let holdReplies = false;
  await withForkRuntime(async h => {
    await h.turn('source', `long history ${'以前的重要历史。'.repeat(12000)}`);
    await h.turn('source', 'completed-before-later-compression');
    const completed = await h.command('source', 'fork-while-later-turn-compressed');
    // A small summary target leaves room for the recent exchange in the uncompressed tail.
    await h.saveCompression({ trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 },
      llmSummary: { targetTokens: 512 } });
    const assertCompletedHistoryOnly = async conversationId => {
      const copiedTurns = await rows(h.app, 'Turn', { conversation_id: conversationId });
      assert.equal(copiedTurns.length, 2, 'only the two completed turns are copied');
      for (const turn of copiedTurns) {
        const terminations = await rows(h.app, 'TurnTermination', { turn_id: turn.id });
        assert.deepEqual(terminations.map(row => [row.terminal_status, row.reason === 'forked_history_snapshot']), [['completed', false]]);
      }
      assert.deepEqual(await rows(h.app, 'CompressionBlock', { conversation_id: conversationId }), [],
        'a compression made after the fork point is not part of the fork');
    };
    holdReplies = true;
    const running = await h.start('source', 'running-turn-compresses-first');
    let ended;
    try {
      await reachedGate(reached, running, 'its model request after compressing');
      const [block] = await rows(h.app, 'CompressionBlock', { conversation_id: 'source' });
      assert.ok(block, 'the running Turn compressed before its model request');
      const [authority] = await rows(h.app, 'AuthoritySnapshot', { id: block.authority_snapshot_id });
      assert.equal(authority.turn_id, running.input.turnId);
      const head = await h.app.context.materializeStructure(await h.app.context.currentHeadRootId('source'));
      const [boundarySource] = await rows(h.app, 'ContextSegmentSource', {
        source_kind: 'message_revision', source_id: completed.expectedRevisionId
      });
      assert.equal(head.records[0].segment.segment_kind, 'compression');
      assert.ok(head.records.some(record => record.segment.id === boundarySource.segment_id),
        'fixture: the completed message sits in the tail of the running Turn\'s compressed head');

      const whileRunning = await h.facade.forkConversation(completed);
      await assertCompletedHistoryOnly(whileRunning.conversationId);
    } finally {
      holdReplies = false;
      release();
      // Never replace a failure of the block above with the running Turn's outcome.
      ended = await bounded(running.done, 'the released Turn to end').catch(error => error);
    }
    if (ended instanceof Error) throw ended;
    assert.equal(ended.terminalStatus, 'completed');
    const afterFinished = await h.facade.forkConversation({ ...completed, command: { commandId: 'fork-after-later-compression-ended' } });
    await assertCompletedHistoryOnly(afterFinished.conversationId);
    // A direct writer caller that selects the later compressed head is refused before any write.
    const headRootId = await h.app.context.currentHeadRootId('source');
    const [boundarySource] = await rows(h.app, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: completed.expectedRevisionId
    });
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: 'source', role: 'default' });
    const conversationsBefore = await rows(h.app, 'Conversation');
    await assert.rejects(h.app.runtime.conversationFork.fork({
      idempotencyKey: 'direct-fork-before-later-compression', reuseKey: 'direct-fork-before-later-compression',
      sourceConversationId: 'source', sourceContextRootId: headRootId,
      sourceContextEndSegmentId: boundarySource.segment_id, sourceMessageRevisionId: completed.expectedRevisionId,
      targetTitle: 'Rejected later compression', targetAgentId: agent.agent_id
    }), error => error instanceof kernel.ConversationForkRejectedError && /after the fork point/.test(error.message));
    assert.deepEqual(await rows(h.app, 'Conversation'), conversationsBefore);
    await h.turn(afterFinished.conversationId, 'continue-uncompressed-fork');
    const context = h.requests.at(-1).context.map(item => item.content).join('\n');
    assert.match(context, /completed-before-later-compression/);
    assert.doesNotMatch(context, /running-turn-compresses-first/);
  }, {
    compression: true,
    async beforeReply() {
      if (!holdReplies) return;
      entered();
      await gate;
    }
  });
});

test('a fork keeps a compression only when it precedes the fork point, together with its creation projection', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'compressed-away-input');
    await h.turn('source', 'kept-tail-input');
    const runner = new ReliableConversationRunner(h.app, 'fork-fixture-owner');
    let compressionTurnId;
    try {
      const expectedRootId = await h.app.context.currentHeadRootId('source');
      const compressed = await runner.manualCompression({
        commandId: 'manual-compression-keeps-tail', conversationId: 'source',
        compressSegmentCount: 2, target: { kind: 'current_head', expectedRootId }
      });
      assert.equal(compressed.compression.status, 'compressed');
      compressionTurnId = compressed.turnId;
    } finally { runner.dispose(); }
    const head = await h.app.context.materializeStructure(await h.app.context.currentHeadRootId('source'));
    assert.equal(head.records.length, 3, 'fixture: the manual compression kept the second exchange as its tail');

    // A direct writer caller that cuts the compressed head inside that tail is refused before any write.
    const insideCommand = await h.command('source', 'fork-inside-compression-tail', 'user');
    const [insideSource] = await rows(h.app, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: insideCommand.expectedRevisionId
    });
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: 'source', role: 'default' });
    const conversationsBefore = await rows(h.app, 'Conversation');
    await assert.rejects(h.app.runtime.conversationFork.fork({
      idempotencyKey: 'direct-inside-compression-tail', reuseKey: 'direct-inside-compression-tail',
      sourceConversationId: 'source', sourceContextRootId: await h.app.context.currentHeadRootId('source'),
      sourceContextEndSegmentId: insideSource.segment_id, sourceMessageRevisionId: insideCommand.expectedRevisionId,
      targetTitle: 'Rejected inside compression tail', targetAgentId: agent.agent_id
    }), error => error instanceof kernel.ConversationForkRejectedError && /after the fork point/.test(error.message));
    assert.deepEqual(await rows(h.app, 'Conversation'), conversationsBefore);

    // The user message sits inside the tail that existed when the compression ran: the compression
    // came after it, so the fork keeps the uncompressed prefix and not the maintenance Turn.
    const insideTail = await h.facade.forkConversation(insideCommand);
    assert.deepEqual(await rows(h.app, 'CompressionBlock', { conversation_id: insideTail.conversationId }), []);
    const insideTurns = await rows(h.app, 'Turn', { conversation_id: insideTail.conversationId });
    assert.equal(insideTurns.length, 2, 'the manual compression Turn after the boundary is not copied');
    for (const turn of insideTurns) {
      assert.ok((await rows(h.app, 'MessageTurnLink', { turn_id: turn.id })).length > 0);
    }
    assert.equal((await rows(h.app, 'MessageTurnLink', { turn_id: compressionTurnId })).length, 0);
    await h.turn(insideTail.conversationId, 'continue-inside-tail-fork');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /compressed-away-input/);

    // The whole tail is kept: the compression precedes the cut and is copied with its projection.
    const afterTail = await h.facade.forkConversation(await h.command('source', 'fork-after-compression-tail'));
    const [block] = await rows(h.app, 'CompressionBlock', { conversation_id: afterTail.conversationId });
    assert.ok(block, 'the fork owns the compression that preceded its boundary');
    const [projection] = await rows(h.app, 'ModelContextProjection', { owner_kind: 'compression_block', owner_id: block.id });
    assert.ok(projection, 'the copied block keeps its pre-compression Context projection');
    const [projectionRoot] = await rows(h.app, 'ContextSequenceRoot', { id: projection.root_id });
    assert.equal(projectionRoot.conversation_id, afterTail.conversationId);
    const [authority] = await rows(h.app, 'AuthoritySnapshot', { id: block.authority_snapshot_id });
    assert.deepEqual((await rows(h.app, 'TurnTermination', { turn_id: authority.turn_id })).map(row => row.terminal_status), ['completed']);
    assert.equal((await rows(h.app, 'MessageTurnLink', { turn_id: authority.turn_id })).length, 0,
      'the copied maintenance Turn owns no transcript');
    await h.turn(afterTail.conversationId, 'continue-after-tail-fork');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /offline summary/);
  }, { compression: true });
});

/** The fork's copy of a source Message, found by its immutable content. */
async function copiedMessageCommand(h, conversationId, sourceRevisionId, commandId) {
  const [source] = await rows(h.app, 'MessageRevision', { id: sourceRevisionId });
  for (const member of await rows(h.app, 'MessagePartOfConversation', { conversation_id: conversationId })) {
    const [current] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: member.message_id });
    const [revision] = await rows(h.app, 'MessageRevision', { id: current.revision_id });
    if (revision.role === source.role && revision.content_object_id === source.content_object_id) {
      return { sourceConversationId: conversationId, messageId: member.message_id,
        expectedRevisionId: revision.id, command: { commandId } };
    }
  }
  assert.fail('the fork has no copy of the source message');
}

/** The fork owns exactly one block, re-homed with its creation projection, and the Turn that compressed. */
async function assertOwnedCompression(h, conversationId) {
  const blocks = await rows(h.app, 'CompressionBlock', { conversation_id: conversationId });
  assert.equal(blocks.length, 1, 'the fork owns the compression that precedes its boundary');
  const projections = await rows(h.app, 'ModelContextProjection', { owner_kind: 'compression_block', owner_id: blocks[0].id });
  assert.equal(projections.length, 1, 'the copied block keeps its creation projection');
  const [projectionRoot] = await rows(h.app, 'ContextSequenceRoot', { id: projections[0].root_id });
  assert.equal(projectionRoot.conversation_id, conversationId);
  const [authority] = await rows(h.app, 'AuthoritySnapshot', { id: blocks[0].authority_snapshot_id });
  const [turn] = await rows(h.app, 'Turn', { id: authority.turn_id });
  assert.equal(turn.conversation_id, conversationId);
  assert.deepEqual((await rows(h.app, 'TurnTermination', { turn_id: turn.id })).map(row => row.terminal_status), ['completed'],
    'the compressing Turn keeps its own termination');
  const creation = (await h.app.context.materialize(projections[0].root_id)).segments.map(segment => segment.content).join('\n');
  return { turn, creation };
}

test('deleting the transcript of a turn that auto-compressed keeps every later message forkable', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', `long history ${'以前的重要历史。'.repeat(12000)}`);
    await h.turn('source', 'kept-before-deleted-compression');
    const insideTail = await h.command('source', 'fork-inside-deleted-compression-tail', 'user');
    const tailEnd = await h.command('source', 'fork-at-end-of-deleted-compression-tail');
    await h.saveCompression({ trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 },
      llmSummary: { targetTokens: 512 } });
    const compressing = await h.turn('source', 'deleted-compressing-turn');
    await h.saveCompression({ trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 120000 } });
    const [block] = await rows(h.app, 'CompressionBlock', { conversation_id: 'source' });
    assert.equal((await rows(h.app, 'AuthoritySnapshot', { id: block.authority_snapshot_id }))[0].turn_id, compressing.turnId,
      'fixture: the Turn compressed before its own model request');
    const [input] = (await rows(h.app, 'MessageTurnLink', { turn_id: compressing.turnId })).filter(link => link.role === 'input');
    // Deleting from its user message keeps the summary: the tail before it stays in the Context head.
    await h.app.turns.delete({ source: { kind: 'command', key: 'delete-compressing-turn' }, conversationId: 'source', messageId: input.message_id });
    const head = await h.app.context.materializeStructure(await h.app.context.currentHeadRootId('source'));
    assert.equal(head.records[0].segment.segment_kind, 'compression');
    await h.turn('source', 'after-deleted-compression');

    const fork = await h.facade.forkConversation(await h.command('source', 'fork-after-deleted-compression'));
    const owned = await assertOwnedCompression(h, fork.conversationId);
    assert.deepEqual(await rows(h.app, 'MessageTurnLink', { turn_id: owned.turn.id }), [],
      'the deleted transcript is not copied; the Turn stays as the owner of the compression');
    assert.match(owned.creation, /kept-before-deleted-compression/);
    assert.doesNotMatch(owned.creation, /deleted-compressing-turn/, 'the creation projection holds only the retained history');
    // Its deleted transcript no longer follows the tail, so the compression precedes a cut at the tail's end.
    const atEnd = await h.facade.forkConversation(tailEnd);
    await assertOwnedCompression(h, atEnd.conversationId);
    await h.turn(fork.conversationId, 'continue-after-deleted-compression-fork');
    let context = h.requests.at(-1).context.map(item => item.content).join('\n');
    assert.match(context, /offline summary/);
    assert.doesNotMatch(context, /deleted-compressing-turn/);
    // The fork itself stays forkable after the compression, and inside its creation tail.
    const refork = await h.facade.forkConversation(await h.command(fork.conversationId, 'refork-after-deleted-compression'));
    await assertOwnedCompression(h, refork.conversationId);
    const reforkInside = await h.facade.forkConversation(await copiedMessageCommand(h, fork.conversationId,
      insideTail.expectedRevisionId, 'refork-inside-deleted-compression-tail'));
    assert.deepEqual(await rows(h.app, 'CompressionBlock', { conversation_id: reforkInside.conversationId }), []);

    // A cut inside the tail that existed when the Turn compressed still keeps the uncompressed history.
    const inside = await h.facade.forkConversation(insideTail);
    assert.deepEqual(await rows(h.app, 'CompressionBlock', { conversation_id: inside.conversationId }), []);
    await h.turn(inside.conversationId, 'continue-inside-deleted-compression-tail');
    context = h.requests.at(-1).context.map(item => item.content).join('\n');
    assert.match(context, /以前的重要历史/);
    assert.doesNotMatch(context, /offline summary/);
  }, { compression: true });
});

test('retrying away the only reply of a turn that auto-compressed keeps later messages forkable', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', `long history ${'以前的重要历史。'.repeat(12000)}`);
    const second = await h.turn('source', 'retried-question');
    await h.saveCompression({ trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 },
      llmSummary: { targetTokens: 512 } });
    // A retry Turn owns no user message; this one compresses before its model request.
    const reply = await h.command('source', 'unused');
    const compressing = await h.turn('source', 'retry-compresses', {
      sourceTurnId: second.turnId, target: { kind: 'message', messageId: reply.messageId },
      expectedMessageRevisionId: reply.expectedRevisionId
    });
    await h.saveCompression({ trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 120000 } });
    const [block] = await rows(h.app, 'CompressionBlock', { conversation_id: 'source' });
    assert.equal((await rows(h.app, 'AuthoritySnapshot', { id: block.authority_snapshot_id }))[0].turn_id, compressing.turnId,
      'fixture: the retry Turn compressed');
    assert.deepEqual((await rows(h.app, 'MessageTurnLink', { turn_id: compressing.turnId })).map(link => link.role), ['model']);
    // Retrying its reply again soft-deletes the whole transcript of the Turn that compressed.
    const compressedReply = await h.command('source', 'unused');
    await h.turn('source', 'retry-discards-compressing-reply', {
      sourceTurnId: compressing.turnId, target: { kind: 'message', messageId: compressedReply.messageId },
      expectedMessageRevisionId: compressedReply.expectedRevisionId
    });
    await h.turn('source', 'after-retried-compression');

    const fork = await h.facade.forkConversation(await h.command('source', 'fork-after-retried-compression'));
    await assertOwnedCompression(h, fork.conversationId);
    await h.turn(fork.conversationId, 'continue-after-retried-compression-fork');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /offline summary/);
    const refork = await h.facade.forkConversation(await h.command(fork.conversationId, 'refork-after-retried-compression'));
    await assertOwnedCompression(h, refork.conversationId);
  }, { compression: true });
});

test('a kept compression whose creation history was rewritten mid-way is refused instead of copied without its projection', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'rewritten-compressed-input');
    await h.turn('source', 'rewritten-tail-input');
    const edited = await h.command('source', 'unused', 'user');
    const runner = new ReliableConversationRunner(h.app, 'fork-fixture-owner');
    try {
      const expectedRootId = await h.app.context.currentHeadRootId('source');
      const compressed = await runner.manualCompression({
        commandId: 'manual-compression-before-rewrite', conversationId: 'source',
        compressSegmentCount: 2, target: { kind: 'current_head', expectedRootId }
      });
      assert.equal(compressed.compression.status, 'compressed');
    } finally { runner.dispose(); }
    // Editing in place rewrites the creation tail while its reply stays history after the edit.
    await h.app.turns.edit({
      source: { kind: 'command', key: 'edit-inside-creation-tail' }, conversationId: 'source',
      messageId: edited.messageId, expectedRevisionId: edited.expectedRevisionId,
      content: 'rewritten-tail-edited', deleteFollowing: false
    });
    const before = await rows(h.app, 'Conversation');
    await assert.rejects(h.facade.forkConversation(await h.command('source', 'fork-after-rewritten-creation-tail')),
      error => error instanceof kernel.ConversationForkRejectedError && /history was rewritten/.test(error.message));
    assert.deepEqual(await rows(h.app, 'Conversation'), before);
  }, { compression: true });
});

async function compressHead(h, conversationId, commandId, compressSegmentCount) {
  const runner = new ReliableConversationRunner(h.app, 'fork-fixture-owner');
  try {
    const expectedRootId = await h.app.context.currentHeadRootId(conversationId);
    const compressed = await runner.manualCompression({
      commandId, conversationId, compressSegmentCount, target: { kind: 'current_head', expectedRootId }
    });
    assert.equal(compressed.compression.status, 'compressed');
    return compressed;
  } finally { runner.dispose(); }
}

/**
 * Every block of the Conversation keeps one creation projection on a root the Conversation owns,
 * starting with the block's compressed range. Returns the creation segments of each block.
 */
async function assertOwnedCreationRoots(h, conversationId, count) {
  const blocks = await rows(h.app, 'CompressionBlock', { conversation_id: conversationId });
  assert.equal(blocks.length, count, 'the fork owns every compression that precedes its boundary');
  const creations = [];
  for (const block of blocks) {
    const projections = await rows(h.app, 'ModelContextProjection', { owner_kind: 'compression_block', owner_id: block.id });
    assert.equal(projections.length, 1, 'the copied block keeps its creation projection');
    const [root] = await rows(h.app, 'ContextSequenceRoot', { id: projections[0].root_id });
    assert.equal(root.conversation_id, conversationId, 'the creation projection is re-homed onto the fork');
    const sources = (await rows(h.app, 'CompressionBlockSource', { compression_block_id: block.id }))
      .sort((left, right) => Number(left.position - right.position)).map(source => source.segment_id);
    const { records } = await h.app.context.materializeStructure(root.id);
    assert.deepEqual(records.slice(0, sources.length).map(record => record.segment.id), sources,
      'the creation root starts with the compressed range');
    creations.push({ blockId: block.id, sources, records });
  }
  return creations;
}

for (const rewrite of ['retry', 'delete', 'edit']) {
  test(`stacked compressions followed by a ${rewrite} in the second one's creation tail keep later messages forkable`, async () => {
    await withForkRuntime(async h => {
      await h.turn('source', 'stacked-first');
      await h.turn('source', 'stacked-second');
      const third = await h.turn('source', 'stacked-third');
      await compressHead(h, 'source', 'stacked-compression-1', 2);
      await compressHead(h, 'source', 'stacked-compression-2', 3);
      // The second compression summarized [first summary, second exchange] of the first one's
      // output root, which was written in one step: no root ever held just part of its tail.
      const head = await h.app.context.materializeStructure(await h.app.context.currentHeadRootId('source'));
      assert.deepEqual(head.records.map(record => record.segment.segment_kind), ['compression', 'message', 'message'],
        'fixture: the second compression kept the third exchange as its tail');
      const [thirdInput, thirdReply] = head.records.slice(1).map(record => record.segment.id);
      if (rewrite === 'retry') {
        const reply = await h.command('source', 'unused');
        await h.turn('source', 'stacked-retry', {
          sourceTurnId: third.turnId, target: { kind: 'message', messageId: reply.messageId },
          expectedMessageRevisionId: reply.expectedRevisionId
        });
      } else {
        const [input] = (await rows(h.app, 'MessageTurnLink', { turn_id: third.turnId })).filter(link => link.role === 'input');
        if (rewrite === 'delete') {
          await h.app.turns.delete({ source: { kind: 'command', key: 'stacked-delete' }, conversationId: 'source', messageId: input.message_id });
        } else {
          const [current] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: input.message_id });
          await h.app.turns.edit({
            source: { kind: 'command', key: 'stacked-edit' }, conversationId: 'source', messageId: input.message_id,
            expectedRevisionId: current.revision_id, content: 'stacked-third-edited', deleteFollowing: true
          });
        }
        await h.turn('source', 'stacked-after-rewrite');
      }
      assert.deepEqual((await rows(h.app, 'CompressionBlock', { conversation_id: 'source' })).map(block => block.status),
        ['enabled', 'enabled']);
      const discarded = rewrite === 'retry' ? [thirdReply] : [thirdInput, thirdReply];
      const assertKeptCreationTails = async conversationId => {
        const creations = await assertOwnedCreationRoots(h, conversationId, 2);
        for (const { records } of creations) {
          assert.deepEqual(records.filter(record => discarded.includes(record.segment.id)), [],
            'a creation root holds only the part of its history the fork keeps');
        }
        // The second block's creation root is exactly its kept part: its range, then what is left of its tail.
        const [second] = creations.filter(({ records }) => records[0].segment.segment_kind === 'compression');
        assert.deepEqual(second.records.map(record => record.segment.id),
          [...second.sources, ...(rewrite === 'retry' ? [thirdInput] : [])]);
      };

      await assertForkableAfterRewrite(h, `stacked-${rewrite}`, assertKeptCreationTails, /stacked-first|stacked-second/);
    }, { compression: true });
  });
}

/**
 * The latest user message and the latest reply of the source fork; the fork continues, re-forks,
 * and still forks after its source is deleted. Every fork passes `assertFork`.
 */
async function assertForkableAfterRewrite(h, label, assertFork, compressedAway) {
  const atUser = await h.facade.forkConversation(await h.command('source', `${label}-fork-user`, 'user'));
  await assertFork(atUser.conversationId);
  const fork = await h.facade.forkConversation(await h.command('source', `${label}-fork`));
  await assertFork(fork.conversationId);
  await h.turn(fork.conversationId, `${label}-continue-fork`);
  let context = h.requests.at(-1).context.map(item => item.content).join('\n');
  assert.match(context, /offline summary/);
  assert.doesNotMatch(context, compressedAway);
  const refork = await h.facade.forkConversation(await h.command(fork.conversationId, `${label}-refork`));
  await assertFork(refork.conversationId);

  await h.app.database.conversationOwners.release('source', 'fixture-panel:source');
  assert.deepEqual(await h.facade.deleteConversation('source'), ['source']);
  const orphan = await h.facade.forkConversation(await h.command(fork.conversationId, `${label}-fork-after-delete`));
  await assertFork(orphan.conversationId);
  await h.turn(orphan.conversationId, `${label}-continue-after-delete`);
  context = h.requests.at(-1).context.map(item => item.content).join('\n');
  assert.match(context, /offline summary/);
  assert.match(context, new RegExp(`${label}-continue-fork`));
}

test('an automatic compression that keeps part of a manual compression\'s tail stays forkable after a delete', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'mixed-first');
    await h.turn('source', `mixed-second ${'以前的重要历史。'.repeat(12000)}`);
    const third = await h.turn('source', 'mixed-third');
    await compressHead(h, 'source', 'mixed-manual-compression', 2);
    await h.saveCompression({ trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 },
      llmSummary: { targetTokens: 512 } });
    const automatic = await h.turn('source', 'mixed-fourth');
    await h.saveCompression({ trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 120000 } });
    const [thirdInput] = (await rows(h.app, 'MessageTurnLink', { turn_id: third.turnId })).filter(link => link.role === 'input');
    const [thirdRevision] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: thirdInput.message_id });
    const [thirdSource] = await rows(h.app, 'ContextSegmentSource', { source_kind: 'message_revision', source_id: thirdRevision.revision_id });
    const blocks = await rows(h.app, 'CompressionBlock', { conversation_id: 'source' });
    const authorityTurns = await Promise.all(blocks.map(async block =>
      (await rows(h.app, 'AuthoritySnapshot', { id: block.authority_snapshot_id }))[0].turn_id));
    assert.equal(blocks.length, 2);
    assert.ok(authorityTurns.includes(automatic.turnId), 'fixture: the fourth Turn compressed automatically');
    const head = await h.app.context.materializeStructure(await h.app.context.currentHeadRootId('source'));
    assert.ok(head.records.slice(1).some(record => record.segment.id === thirdSource.segment_id),
      'fixture: the automatic compression kept the third exchange of the manual compression\'s tail');
    // Deleting the third exchange leaves the automatic compression only a part of the manual
    // compression's one-step output root as its kept creation history.
    await h.app.turns.delete({ source: { kind: 'command', key: 'mixed-delete' }, conversationId: 'source', messageId: thirdInput.message_id });
    await h.turn('source', 'mixed-after-delete');
    const assertKeptCreationTails = async conversationId => {
      for (const { records } of await assertOwnedCreationRoots(h, conversationId, 2)) {
        assert.equal(records.some(record => record.segment.id === thirdSource.segment_id), false,
          'a creation root holds only the part of its history the fork keeps');
      }
    };
    await assertForkableAfterRewrite(h, 'mixed', assertKeptCreationTails, /mixed-first|以前的重要历史/);
  }, { compression: true });
});

for (const which of ['inner', 'outer']) {
  test(`a fork over a block that lost its creation projection (${which}) fails its invariant without writing`, async () => {
    await withForkRuntime(async h => {
      await h.turn('source', 'unprojected-first');
      await h.turn('source', 'unprojected-second');
      await h.turn('source', 'unprojected-third');
      await compressHead(h, 'source', 'unprojected-compression-1', 2);
      await compressHead(h, 'source', 'unprojected-compression-2', 3);
      const fork = await h.facade.forkConversation(await h.command('source', 'fork-before-projection-loss'));
      // Every block keeps exactly one creation projection; a missing one is corruption, not an
      // older data shape, so forking over it fails the invariant instead of being classified.
      const [block] = (await assertOwnedCreationRoots(h, fork.conversationId, 2))
        .filter(({ records }) => (records[0].segment.segment_kind === 'compression') === (which === 'outer'));
      const [projection] = await rows(h.app, 'ModelContextProjection', { owner_kind: 'compression_block', owner_id: block.blockId });
      const databasePath = h.app.database.binding.paths.databasePath;
      await h.reopen(() => {
        const database = new Database(databasePath);
        try {
          assert.equal(database.prepare('DELETE FROM model_context_projection WHERE id = ?').run(projection.id).changes, 1);
        } finally { database.close(); }
      });
      const before = await rows(h.app, 'Conversation');
      await assert.rejects(h.facade.forkConversation(await h.command(fork.conversationId, 'fork-without-projection')),
        error => !(error instanceof kernel.ConversationForkRejectedError) && /must have exactly one creation projection/.test(error.message));
      assert.deepEqual(await rows(h.app, 'Conversation'), before);
    }, { compression: true });
  });
}

test('manual compression in a fork without Turns of its own runs under the fork\'s current settings', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'authority-first');
    await h.turn('source', 'authority-second');
    const fork = await h.facade.forkConversation(await h.command('source', 'fork-before-model-change'));
    await h.configuration.mutations.setModelProfile({
      scopeKind: 'conversation', scopeId: fork.conversationId, providerConfigId: h.provider.id,
      provider: h.provider.provider, model: 'offline-fork-second-model'
    });
    // Every Turn of the fork is a copy of source history, frozen with the source's model.
    const compressed = await compressHead(h, fork.conversationId, 'compress-fork-without-own-turns', 2);
    const requests = await rows(h.app, 'ModelRequest', { turn_id: compressed.turnId });
    assert.deepEqual(requests.map(request => request.model_id), ['offline-fork-second-model'],
      'a copied Turn never supplies the authority of new work');
    await h.turn(fork.conversationId, 'after-fork-compression');
    assert.equal(h.requests.at(-1).modelId, 'offline-fork-second-model');
  }, { compression: true, extraModels: ['offline-fork-second-model'] });
});

test('a copied failed turn keeps its termination and its failed request stays retryable in the fork', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'healthy-history');
    const failing = await h.start('source', 'provider-rejects-this-turn');
    assert.equal((await failing.done).terminalStatus, 'failed');
    const [failedRequest] = await rows(h.app, 'ModelRequest', { turn_id: failing.input.turnId });
    assert.equal(failedRequest.terminal_state === 'completed', false);
    const fork = await h.facade.forkConversation(await h.command('source', 'fork-failed-turn', 'user'));
    const copiedTurns = await assertOwnedTurnHistory(h, 'source', fork.conversationId);
    const terminations = (await Promise.all(copiedTurns.map(turn => rows(h.app, 'TurnTermination', { turn_id: turn.id })))).flat();
    assert.deepEqual(terminations.map(row => row.terminal_status).sort(), ['completed', 'failed']);
    assert.ok(terminations.every(row => row.reason !== 'forked_history_snapshot'));
    const failedTurn = copiedTurns.find(turn => terminations.some(row => row.turn_id === turn.id && row.terminal_status === 'failed'));
    const [copiedFailedRequest] = await rows(h.app, 'ModelRequest', { turn_id: failedTurn.id });
    const [projection] = await rows(h.app, 'ModelContextProjection', { owner_kind: 'model_request', owner_id: copiedFailedRequest.id });
    assert.equal(projection.root_id, await h.app.context.currentHeadRootId(fork.conversationId),
      'the failed request froze exactly the fork head, so it can be retried there');
    await h.turn(fork.conversationId, 'retry-copied-failed-request', {
      sourceTurnId: failedTurn.id, target: { kind: 'model_request', modelRequestId: copiedFailedRequest.id }
    });
  }, { failRequests: [2] });
});

test('fork titles come from committed facts and never take part in fork identity', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'first user words name untitled conversations');
    const command = await h.command('source', 'titled-fork');
    const fork = await h.facade.forkConversation(command);
    const title = async id => (await rows(h.app, 'Conversation', { id }))[0].title;
    assert.equal(await title(fork.conversationId), 'Source fixture 分支', 'the durable source title, not the sidebar cache');
    assert.equal(await h.facade.renameConversationTitle(fork.conversationId, 'Renamed fork'), true);
    assert.equal(await h.facade.renameConversationTitle('source', 'Renamed source'), true);
    assert.deepEqual(await h.facade.forkConversation(command), { conversationId: fork.conversationId, deduplicated: true });
    assert.equal(await title(fork.conversationId), 'Renamed fork');

    const rootId = await h.app.context.currentHeadRootId('source');
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: 'source', role: 'default' });
    const direct = { idempotencyKey: 'direct-titled-fork', reuseKey: 'direct-titled-fork', sourceConversationId: 'source',
      sourceContextRootId: rootId, targetAgentId: agent.agent_id };
    const first = await h.app.runtime.conversationFork.fork({ ...direct, targetTitle: 'Initial direct title' });
    await h.facade.renameConversationTitle(first.targetConversationId, 'User renamed direct fork');
    const replay = await h.app.runtime.conversationFork.fork({ ...direct, targetTitle: 'A different computed title' });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.targetConversationId, first.targetConversationId);

    assert.equal(await h.facade.renameConversationTitle('source', '新对话'), true);
    const untitled = await h.facade.forkConversation(await h.command('source', 'untitled-source-fork'));
    const { displayConversationTitleFromText } = load('shared/conversationTitle.js');
    assert.equal(await title(untitled.conversationId),
      `${displayConversationTitleFromText('first user words name untitled conversations')} 分支`,
      'a placeholder source title is displayed from its first user message');
  });
});

test('an early fork has no later source roots without target message provenance', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'first-source-input');
    const command = await h.command('source', 'early-fork', 'user');
    await h.turn('source', 'future-source-input');
    const sourceRoots = await rows(h.app, 'ContextSequenceRoot', { conversation_id: 'source' });
    const fork = await h.facade.forkConversation(command);
    const targetRoots = await rows(h.app, 'ContextSequenceRoot', { conversation_id: fork.conversationId });
    const [head] = await rows(h.app, 'ConversationContextHeadLink', { conversation_id: fork.conversationId });
    const boundary = await h.app.context.materialize(head.root_id);
    for (const root of targetRoots) {
      const context = await h.app.context.materialize(root.id);
      assert.ok(context.segments.length <= boundary.segments.length,
        'target history must not expose source roots after its selected fork boundary');
      assert.doesNotMatch(context.segments.map(segment => segment.content).join('\n'), /future-source-input/);
      await new kernel.ReliableContextTokenEstimator(h.app.database, h.app.contentStore).estimateRoot(root.id);
    }
    assert.deepEqual(await rows(h.app, 'ContextSequenceRoot', { conversation_id: 'source' }), sourceRoots);
  });
});

test('interrupted configuration copy and fork commit resume the same fully configured target after reopen', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'copy-source-input');
    await h.configuration.mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'source', text: 'source prompt' });
    const command = await h.command('source', 'copy-failure');
    const store = load('backend/capabilities/vscodeStorage/recordStore.js');
    const save = store.saveRecordStore;
    let injected = false;
    store.saveRecordStore = async (root, index, records, ...rest) => {
      if (records.some(record => record.workEnvironmentId && record.conversationId !== 'source')) {
        injected = true;
        throw new Error('injected work environment copy failure');
      }
      return save(root, index, records, ...rest);
    };
    try {
      await assert.rejects(h.facade.forkConversation(command), /injected work environment copy failure/);
    } finally {
      store.saveRecordStore = save;
    }
    assert.equal(injected, true);
    assert.equal((await rows(h.app, 'Conversation')).length, 1, 'no branch commits before its settings are copied');
    assert.deepEqual(await rows(h.app, 'ConversationBranchLink'), []);
    let config = await h.configuration.configurationClientState();
    const [modelLink] = config.modelProfileScopeLinks.filter(link => link.scopeKind === 'conversation' && link.scopeId !== 'source');
    assert.ok(modelLink, 'settings copied before the failure stay durable');
    const target = modelLink.scopeId;
    assert.equal(config.conversationWorkEnvironmentLinks.some(link => link.conversationId === target), false);

    // Crash after the copy completed but before the fork transaction commits.
    const database = h.app.database;
    const transaction = database.transaction.bind(database);
    let commitInjected = false;
    database.transaction = async (steps, ...rest) => {
      if (!commitInjected && steps.some(step => step.kind === 'insert' && step.domain === 'Conversation')) {
        commitInjected = true;
        throw new Error('injected fork commit failure');
      }
      return transaction(steps, ...rest);
    };
    try {
      await assert.rejects(h.facade.forkConversation(command), /injected fork commit failure/);
    } finally {
      database.transaction = transaction;
    }
    assert.equal(commitInjected, true);
    assert.equal((await rows(h.app, 'Conversation')).length, 1);
    config = await h.configuration.configurationClientState();
    assert.equal(config.conversationWorkEnvironmentLinks.find(link => link.conversationId === target)?.workEnvironmentId, h.environmentId);

    await h.reopen();
    const replay = await h.facade.forkConversation(command);
    assert.deepEqual(replay, { conversationId: target, deduplicated: false });
    config = await h.configuration.configurationClientState();
    for (const key of ['modelProfileScopeLinks', 'systemPromptScopeLinks']) {
      assert.equal(config[key].filter(link => link.scopeKind === 'conversation' && link.scopeId === target).length, 1, key);
    }
    assert.equal(config.conversationWorkEnvironmentLinks.filter(link => link.conversationId === target).length, 1);
    await h.turn(target, 'recovered-target-input');
    assert.equal((await rows(h.app, 'Conversation')).length, 2);
  });
});

test('lost fork result replays after a source revision change without overwriting target selections', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'revision-source-input');
    await h.configuration.mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'source', text: 'source prompt' });
    const command = await h.command('source', 'lost-result', 'user');
    const first = await h.facade.forkConversation(command);
    await h.configuration.mutations.selectConversationWorkflow({
      conversationId: first.conversationId, scopeKind: 'global'
    });
    // The user resets the copied prompt on the branch; a replay must not refill the empty slot.
    await h.configuration.mutations.clearSystemPrompt('conversation', first.conversationId);
    await h.app.turns.edit({
      source: { kind: 'command', key: 'edit-after-fork' }, conversationId: 'source',
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
    assert.equal((await rows(h.app, 'Conversation')).length, 2);
    await h.turn(first.conversationId, 'unchanged-fork-input');
    assert.doesNotMatch(h.requests.at(-1).context.map(item => item.content).join('\n'), /changed source after/);
  });
});

/** Conversation-scoped settings of every Conversation other than the given ones. */
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

test('permanent fork failures are rejections that leave no target or copied settings', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'rejection-source-input');
    await h.configuration.mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'source', text: 'source prompt' });
    const command = await h.command('source', 'rejection-committed', 'user');
    const first = await h.facade.forkConversation(command);
    const foreign = await h.command(first.conversationId, 'unused', 'user');
    const rejected = pattern => error => error instanceof kernel.ConversationForkRejectedError && pattern.test(error.message);
    const keep = ['source', first.conversationId];
    // Every rejection fires before this attempt copies anything, so each command first gets the
    // settings an interrupted earlier attempt of it copied: the rejection must remove them.
    const stageInterruptedCopy = async commandId => {
      const target = stablePhaseFId('conversation', `conversation-fork:${commandId}`);
      await h.configuration.mutations.copyConversationConfiguration('source', target);
      assert.ok((await strayConversationSettings(h.configuration, keep)).some(([, owner]) => owner === target),
        'fixture: an interrupted attempt of this command copied settings');
    };
    for (const [label, attempt, pattern] of [
      ['missing source', { ...command, sourceConversationId: 'missing-source' }, /不存在/],
      ['missing current revision', { ...command, messageId: 'missing-message' }, /当前 Revision/],
      ['changed revision', { ...command, expectedRevisionId: foreign.expectedRevisionId }, /Revision 已变化/],
      ['foreign message', { ...foreign, sourceConversationId: 'source' }, /不属于当前 Conversation/]
    ]) {
      await stageInterruptedCopy(`rejected-${label}`);
      await assert.rejects(h.facade.forkConversation({ ...attempt, command: { commandId: `rejected-${label}` } }), rejected(pattern), label);
      assert.deepEqual(await strayConversationSettings(h.configuration, keep), [], `${label}: the copied settings are removed`);
    }
    // Replaying the committed command with other facts is a permanent rejection too, and the
    // committed branch keeps its settings.
    await assert.rejects(h.facade.forkConversation({ ...command, expectedRevisionId: foreign.expectedRevisionId }),
      rejected(/different source facts/));
    await assert.rejects(h.facade.forkConversation({ ...command, messageId: foreign.messageId }), rejected(/different source Message/));
    assert.equal((await rows(h.app, 'Conversation')).length, 2);
    const config = await h.configuration.configurationClientState();
    assert.ok(config.systemPromptScopeLinks.some(link => link.scopeKind === 'conversation' && link.scopeId === first.conversationId));
    // A message deleted after the user clicked fork is a permanent rejection, not a generic error.
    await h.turn('source', 'rejection-deleted-input');
    const deleted = await h.command('source', 'rejection-deleted', 'user');
    const rootBeforeDelete = await h.app.context.currentHeadRootId('source');
    await h.app.turns.delete({ source: { kind: 'command', key: 'delete-fork-point' }, conversationId: 'source', messageId: deleted.messageId });
    await stageInterruptedCopy(deleted.command.commandId);
    await assert.rejects(h.facade.forkConversation(deleted), rejected(/已被删除/));
    assert.deepEqual(await strayConversationSettings(h.configuration, keep), [], 'the deleted fork point: the copied settings are removed');
    // The fork writer refuses the deleted fork point itself, also for a caller holding an old root.
    const [deletedSource] = await rows(h.app, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: deleted.expectedRevisionId
    });
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: 'source', role: 'default' });
    await assert.rejects(h.app.runtime.conversationFork.fork({
      idempotencyKey: 'direct-deleted-fork-point', reuseKey: 'direct-deleted-fork-point',
      sourceConversationId: 'source', sourceContextRootId: rootBeforeDelete,
      sourceContextEndSegmentId: deletedSource.segment_id, sourceMessageRevisionId: deleted.expectedRevisionId,
      targetTitle: 'Rejected deleted fork point', targetAgentId: agent.agent_id
    }), rejected(/已被删除/));
    assert.deepEqual(await rows(h.app, 'ConversationReuseLink', { reuse_key: 'direct-deleted-fork-point' }), []);
    assert.equal((await rows(h.app, 'Conversation')).length, 2);
  });
});

test('a fork permanently rejected after an interrupted attempt removes the settings that attempt copied', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'orphan-source-input');
    await h.configuration.mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'source', text: 'source prompt' });
    const command = await h.command('source', 'orphaned-settings', 'user');
    const database = h.app.database;
    const transaction = database.transaction.bind(database);
    let raced = false;
    database.transaction = async (steps, ...rest) => {
      if (!raced && steps.some(step => step.kind === 'insert' && step.domain === 'Conversation')) {
        raced = true;
        await h.app.turns.edit({
          source: { kind: 'command', key: 'edit-races-fork-commit' }, conversationId: 'source',
          messageId: command.messageId, expectedRevisionId: command.expectedRevisionId,
          content: 'source edited between the fork checks and its commit'
        });
      }
      return transaction(steps, ...rest);
    };
    try {
      await assert.rejects(h.facade.forkConversation(command), error => !(error instanceof kernel.ConversationForkRejectedError));
    } finally {
      database.transaction = transaction;
    }
    assert.equal(raced, true);
    assert.notDeepEqual(await strayConversationSettings(h.configuration, ['source']), [],
      'the interrupted attempt copied settings before its commit failed');
    await assert.rejects(h.facade.forkConversation(command), kernel.ConversationForkRejectedError);
    assert.deepEqual(await strayConversationSettings(h.configuration, ['source']), [],
      'a permanently rejected fork leaves no Conversation-layer settings behind');
    assert.equal((await rows(h.app, 'Conversation')).length, 1);
  });
});

async function withSourceSettings(h) {
  await h.configuration.mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'source', text: 'source prompt' });
  await h.configuration.mutations.selectConversationWorkflow({ conversationId: 'source', scopeKind: 'global' });
}

test('a rejection raised after the settings copy removes every copied setting, the workflow selection included', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'late-rejection-input');
    await withSourceSettings(h);
    const command = await h.command('source', 'late-rejection', 'user');
    const database = h.app.database;
    const transaction = database.transaction.bind(database);
    let copied;
    database.transaction = async (steps, ...rest) => {
      if (copied === undefined && steps.some(step => step.kind === 'insert' && step.domain === 'Conversation')) {
        copied = await strayConversationSettings(h.configuration, ['source']);
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
    assert.deepEqual(await strayConversationSettings(h.configuration, ['source']), []);
    assert.equal((await rows(h.app, 'Conversation')).length, 1);
  });
});

test('a fork that fails before its commit point writes no settings', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'early-failure-input');
    await withSourceSettings(h);
    const command = await h.command('source', 'early-failure', 'user');
    const writer = h.app.runtime.conversationFork;
    const database = h.app.database;
    const fork = writer.fork;
    writer.fork = async function (...args) {
      const materialize = database.materializeContext;
      database.materializeContext = async () => { throw new Error('injected fork read failure'); };
      try { return await fork.apply(this, args); } finally { database.materializeContext = materialize; }
    };
    try {
      await assert.rejects(h.facade.forkConversation(command),
        error => !(error instanceof kernel.ConversationForkRejectedError) && /injected fork read failure/.test(error.message));
    } finally {
      writer.fork = fork;
    }
    assert.deepEqual(await strayConversationSettings(h.configuration, ['source']), [],
      'settings are copied only for a fork that passed every check');
    const retried = await h.facade.forkConversation(command);
    const config = await h.configuration.configurationClientState();
    assert.equal(config.conversationWorkflowSelections.find(item => item.conversationId === retried.conversationId)?.scopeKind, 'global');
  });
});

/**
 * Settings an attempt of this fork command copied before its Host died at the commit: a failure the
 * process survives already removes them, so only a crash leaves them for a later rejection.
 */
async function copiedByCrashedAttempt(h, commandId) {
  await h.configuration.mutations.copyConversationConfiguration('source', stablePhaseFId('conversation', `conversation-fork:${commandId}`));
  assert.notDeepEqual(await strayConversationSettings(h.configuration, ['source']), [], 'fixture: the crashed attempt copied settings');
}

test('fork_conversation that fails at its commit removes the settings it copied', async () => {
  const { ReliableConversationLifecycle } = load('backend/application/reliableKernel/conversationLifecycle.js');
  await withForkRuntime(async h => {
    await h.turn('source', 'commit-failure-input');
    await withSourceSettings(h);
    const lifecycle = new ReliableConversationLifecycle({ application: h.app, configuration: h.configuration });
    const database = h.app.database;
    const transaction = database.transaction.bind(database);
    let injected = false;
    database.transaction = async (steps, ...rest) => {
      if (!injected && steps.some(step => step.kind === 'insert' && step.domain === 'Conversation')) {
        injected = true;
        throw new Error('injected fork commit failure');
      }
      return transaction(steps, ...rest);
    };
    try {
      await assert.rejects(lifecycle.forkCompletedHistory({ sourceConversationId: 'source', commandId: 'fork-tool-call-commit-failure' }),
        /^Error: Forking failed\. Nothing was created: injected fork commit failure$/);
    } finally {
      database.transaction = transaction;
    }
    assert.ok(injected);
    assert.deepEqual(await strayConversationSettings(h.configuration, ['source']), [], 'no settings stay behind for the uncreated fork');
  });
});

test('fork_conversation rejected for lack of completed history removes the settings a crashed attempt copied', async () => {
  const { ReliableConversationLifecycle } = load('backend/application/reliableKernel/conversationLifecycle.js');
  await withForkRuntime(async h => {
    await h.turn('source', 'completed-history-input');
    await withSourceSettings(h);
    const lifecycle = new ReliableConversationLifecycle({ application: h.app, configuration: h.configuration });
    const request = { sourceConversationId: 'source', commandId: 'fork-tool-call-interrupted' };
    await copiedByCrashedAttempt(h, request.commandId);
    const first = await h.command('source', 'unused', 'user');
    await h.app.turns.delete({ source: { kind: 'command', key: 'delete-all-history' }, conversationId: 'source', messageId: first.messageId });
    await assert.rejects(lifecycle.forkCompletedHistory(request),
      error => error instanceof kernel.ConversationForkRejectedError && /还没有已完成的轮次/.test(error.message));
    assert.deepEqual(await strayConversationSettings(h.configuration, ['source']), []);
  });
});

test('fork_conversation of a source deleted after a crashed attempt is refused as a missing source', async () => {
  const { ReliableConversationLifecycle } = load('backend/application/reliableKernel/conversationLifecycle.js');
  await withForkRuntime(async h => {
    await h.turn('source', 'deleted-source-history');
    await withSourceSettings(h);
    const lifecycle = new ReliableConversationLifecycle({ application: h.app, configuration: h.configuration });
    const request = { sourceConversationId: 'source', commandId: 'fork-tool-call-source-deleted' };
    await copiedByCrashedAttempt(h, request.commandId);
    await h.app.database.conversationOwners.release('source', 'fixture-panel:source');
    assert.deepEqual((await h.app.conversationDeletion.delete('source')).deletedConversationIds, ['source']);
    await assert.rejects(lifecycle.forkCompletedHistory(request),
      error => error instanceof kernel.ConversationForkRejectedError && /Fork 源 Conversation source 不存在/.test(error.message));
    assert.deepEqual(await strayConversationSettings(h.configuration, ['source']), []);
  });
});

test('a failed settings cleanup is logged and never replaces the permanent rejection', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'cleanup-failure-input');
    const command = await h.command('source', 'cleanup-failure', 'user');
    const mutations = h.configuration.mutations;
    const clear = mutations.clearConversationConfiguration;
    const warn = console.warn;
    const warnings = [];
    mutations.clearConversationConfiguration = async () => { throw new Error('injected settings cleanup failure'); };
    console.warn = (...args) => { warnings.push(args); };
    try {
      await assert.rejects(h.facade.forkConversation({ ...command, sourceConversationId: 'missing-source' }),
        error => error instanceof kernel.ConversationForkRejectedError && /不存在/.test(error.message));
    } finally {
      mutations.clearConversationConfiguration = clear;
      console.warn = warn;
    }
    assert.ok(warnings.some(args => args.some(arg => arg instanceof Error && /injected settings cleanup failure/.test(arg.message))),
      'the cleanup failure is logged');
  });
});

for (const fault of ['before-commit', 'revision-race']) {
  test(`fork ${fault} does not leave a partially created runtime target`, async () => {
    await withForkRuntime(async h => {
      await h.turn('source', 'transaction-source-input');
      const command = await h.command('source', `transaction-${fault}`, 'user');
      const database = h.app.database;
      const transaction = database.transaction.bind(database);
      let injected = false;
      database.transaction = async (steps, ...rest) => {
        if (!injected && steps.some(step => step.kind === 'insert' && step.domain === 'Conversation')) {
          injected = true;
          if (fault === 'before-commit') throw new Error('injected fork transaction failure');
          await h.app.turns.edit({
            source: { kind: 'command', key: 'raced-source-edit' }, conversationId: 'source',
            messageId: command.messageId, expectedRevisionId: command.expectedRevisionId,
            content: 'source changed after fork read before fork commit'
          });
        }
        return transaction(steps, ...rest);
      };
      try {
        await assert.rejects(h.facade.forkConversation(command));
      } finally {
        database.transaction = transaction;
      }
      assert.equal(injected, true, 'the fault must reach the target transaction');
      assert.equal((await rows(h.app, 'Conversation')).length, 1);
      assert.deepEqual(await rows(h.app, 'ConversationBranchLink'), []);
      assert.deepEqual(await rows(h.app, 'ConversationReuseLink'), []);
      if (fault === 'before-commit') {
        const retry = await h.facade.forkConversation(command);
        assert.equal(retry.deduplicated, false);
        await h.turn(retry.conversationId, 'retry-after-transaction-failure');
      } else {
        const refreshed = await h.command('source', 'refreshed-fork', 'user');
        await h.facade.forkConversation(refreshed);
      }
      assert.equal((await rows(h.app, 'Conversation')).length, 2);
    });
  });
}

for (const deleteFollowing of [false, true]) {
  test(`fork after editing an old message (truncate=${deleteFollowing}) keeps only usable history`, async () => {
    await withForkRuntime(async h => {
      await h.turn('source', 'original-user-input');
      const original = await h.command('source', 'original-boundary', 'user');
      await h.turn('source', 'later-user-input');
      await h.app.turns.edit({
        source: { kind: 'command', key: `edit-old-${deleteFollowing}` }, conversationId: 'source',
        messageId: original.messageId, expectedRevisionId: original.expectedRevisionId,
        content: 'edited-user-input', deleteFollowing
      });
      const [current] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: original.messageId });
      const fork = await h.facade.forkConversation({
        ...original, expectedRevisionId: current.revision_id, command: { commandId: `fork-edited-${deleteFollowing}` }
      });
      const estimator = new kernel.ReliableContextTokenEstimator(h.app.database, h.app.contentStore);
      for (const root of await rows(h.app, 'ContextSequenceRoot', { conversation_id: fork.conversationId })) {
        await estimator.estimateRoot(root.id);
      }
      await h.turn(fork.conversationId, 'continued-after-edit-fork');
      const nested = await h.facade.forkConversation(await h.command(fork.conversationId, 'nested-after-edit'));
      await h.turn(nested.conversationId, 'nested-after-edit-input');
      assert.equal((await rows(h.app, 'Conversation')).length, 3);
      assert.ok((await rows(h.app, 'MessageRevision', { id: original.expectedRevisionId })).length,
        'filtering target roots must never remove the original source revision');
    });
  });
}

test('forking an unchanged assistant after an earlier user edit selects current transcript context', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'old-user-question');
    const user = await h.command('source', 'user-to-edit', 'user');
    const assistant = await h.command('source', 'assistant-after-edit');
    await h.app.turns.edit({
      source: { kind: 'command', key: 'edit-question-only' }, conversationId: 'source',
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
    for (const root of await rows(h.app, 'ContextSequenceRoot', { conversation_id: fork.conversationId })) {
      await estimator.estimateRoot(root.id);
    }
    await h.turn(fork.conversationId, 'continue-edited-question');
    const context = h.requests.at(-1).context.map(item => item.content).join('\n');
    assert.match(context, /new-user-question/);
    assert.doesNotMatch(context, /old-user-question/);
    const nested = await h.facade.forkConversation(await h.command(fork.conversationId, 'fork-after-edited-question'));
    await h.turn(nested.conversationId, 'nested-edited-question');
  });
});

test('fork after retrying an old turn does not retain the discarded suffix', async () => {
  await withForkRuntime(async h => {
    const first = await h.turn('source', 'retry-original-input');
    const boundary = await h.command('source', 'retry-boundary');
    await h.turn('source', 'discarded-later-input');
    await h.turn('source', 'retry-old-turn', {
      sourceTurnId: first.turnId, target: { kind: 'message', messageId: boundary.messageId },
      expectedMessageRevisionId: boundary.expectedRevisionId
    });
    const fork = await h.facade.forkConversation(await h.command('source', 'fork-after-retry'));
    const estimator = new kernel.ReliableContextTokenEstimator(h.app.database, h.app.contentStore);
    for (const root of await rows(h.app, 'ContextSequenceRoot', { conversation_id: fork.conversationId })) {
      await estimator.estimateRoot(root.id);
    }
    await h.turn(fork.conversationId, 'continue-after-retry');
    assert.doesNotMatch(h.requests.at(-1).context.map(item => item.content).join('\n'), /discarded-later-input/);
  });
});

for (const rewrite of ['retry', 'edit']) {
  test(`a copied turn whose output was discarded by a source ${rewrite} keeps its original termination`, async () => {
    await withForkRuntime(async h => {
      const rewritten = await h.turn('source', `${rewrite}-rewritten-tool-turn`);
      const [call] = await rows(h.app, 'ToolCall', { turn_id: rewritten.turnId });
      const [callSource] = await rows(h.app, 'ToolCallSourceLink', { tool_call_id: call.id });
      const [callCurrent] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: callSource.message_id });
      let command;
      if (rewrite === 'retry') {
        // Retrying from the tool-calling message soft-deletes it, the tool result and the reply.
        await h.turn('source', 'retry-discarded-tool-output', {
          sourceTurnId: rewritten.turnId, target: { kind: 'message', messageId: callSource.message_id },
          expectedMessageRevisionId: callCurrent.revision_id
        });
        command = await h.command('source', 'fork-after-discarding-retry');
      } else {
        await h.turn('source', 'later-turn-discarded-by-edit');
        const user = await firstMessageCommand(h, 'source', 'unused');
        await h.app.turns.edit({
          source: { kind: 'command', key: 'edit-discards-tool-output' }, conversationId: 'source',
          messageId: user.messageId, expectedRevisionId: user.expectedRevisionId,
          content: 'edited-user-input-discards-output', deleteFollowing: true
        });
        command = await firstMessageCommand(h, 'source', 'fork-after-discarding-edit');
      }
      const [sourceTermination] = await rows(h.app, 'TurnTermination', { turn_id: rewritten.turnId });
      assert.equal(sourceTermination.terminal_status, 'completed');
      const fork = await h.facade.forkConversation(command);
      const copiedTurns = await rows(h.app, 'Turn', { conversation_id: fork.conversationId });
      assert.ok(copiedTurns.length >= 1);
      for (const turn of copiedTurns) {
        const terminations = await rows(h.app, 'TurnTermination', { turn_id: turn.id });
        assert.deepEqual(terminations.map(row => [row.terminal_status, row.reason]), [['completed', sourceTermination.reason]],
          'discarded output is not part of the visible transcript, so the copied turn is not interrupted');
      }
      for (const turn of copiedTurns) {
        assert.deepEqual(await rows(h.app, 'ToolCall', { turn_id: turn.id }), [], 'the discarded tool call is not copied');
      }
      await h.turn(fork.conversationId, `continue-after-${rewrite}-fork`);
    }, { withTool: true });
  });
}

test('nested compression keeps reachable pre-compression fork boundaries usable', async () => {
  await withForkRuntime(async h => {
    for (let round = 1; round <= 2; round += 1) {
      const turn = await h.turn('source', `compressed-input-${round}`);
      const [authority] = await rows(h.app, 'AuthoritySnapshot', { turn_id: turn.turnId });
      const rootId = await h.app.context.currentHeadRootId('source');
      const structure = await h.app.context.materializeStructure(rootId);
      await h.app.compression.create({
        conversationId: 'source', headRootId: rootId, authoritySnapshotId: authority.id,
        compressSegmentCount: structure.records.length, title: `Summary ${round}`,
        summary: `Offline summary ${round}`, idempotencyKey: `compression-${round}`
      });
    }
    await h.turn('source', 'after-nested-compression');
    const fork = await h.facade.forkConversation(await h.command('source', 'compressed-fork'));
    const estimator = new kernel.ReliableContextTokenEstimator(h.app.database, h.app.contentStore);
    const roots = await rows(h.app, 'ContextSequenceRoot', { conversation_id: fork.conversationId });
    assert.ok(roots.length > 1, 'do not drop all historical roots to hide provenance errors');
    for (const root of roots) await estimator.estimateRoot(root.id);
    await h.turn(fork.conversationId, 'continue-compressed-fork');
    const [first] = (await rows(h.app, 'MessagePartOfConversation', { conversation_id: fork.conversationId }))
      .sort((a, b) => Number(a.message_seq - b.message_seq));
    const [current] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: first.message_id });
    const nested = await h.facade.forkConversation({
      sourceConversationId: fork.conversationId, messageId: first.message_id,
      expectedRevisionId: current.revision_id, command: { commandId: 'pre-compression-fork' }
    });
    await h.turn(nested.conversationId, 'continue-before-compression');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /compressed-input-1/);
  });
});

test('direct fork rejects an obsolete selected head before committing a target', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'old-direct-question');
    const user = await h.command('source', 'direct-user', 'user');
    const assistant = await h.command('source', 'direct-assistant');
    const rootId = await h.app.context.currentHeadRootId('source');
    const structure = await h.app.context.materializeStructure(rootId);
    await h.app.turns.edit({
      source: { kind: 'command', key: 'direct-edit' }, conversationId: 'source',
      messageId: user.messageId, expectedRevisionId: user.expectedRevisionId,
      content: 'new-direct-question', deleteFollowing: false
    });
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: 'source', role: 'default' });
    await assert.rejects(h.app.runtime.conversationFork.fork({
      idempotencyKey: 'obsolete-direct-fork', reuseKey: 'obsolete-direct-fork',
      sourceConversationId: 'source', sourceContextRootId: rootId,
      sourceContextEndSegmentId: structure.records.at(-1).segment.id,
      sourceMessageRevisionId: assistant.expectedRevisionId,
      expectedCurrentMessageRevisionId: assistant.expectedRevisionId,
      targetTitle: 'Rejected obsolete context', targetAgentId: agent.agent_id
    }), /outside the copied current transcript/);
    assert.equal((await rows(h.app, 'Conversation')).length, 1);
    assert.deepEqual(await rows(h.app, 'ConversationBranchLink'), []);
    assert.deepEqual(await rows(h.app, 'ConversationReuseLink'), []);
    assert.equal((await rows(h.app, 'MessageRevision', { id: user.expectedRevisionId })).length, 1);
  });
});

test('completed synchronous tool history stays forkable in both source and target after sharing', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'use-one-synthetic-tool');
    const sourceCalls = await rows(h.app, 'ToolCall');
    assert.equal(sourceCalls.length, 1);
    const sourceCallId = sourceCalls[0].id;
    const first = await h.facade.forkConversation(await h.command('source', 'tool-first-fork'));
    const [sourceCall] = (await rows(h.app, 'ToolCall')).filter(call => call.id === sourceCallId);
    assert.ok(sourceCall);
    const [callSource] = await rows(h.app, 'ContextSegmentSource', { source_kind: 'tool_call', source_id: sourceCall.id });
    assert.equal((await rows(h.app, 'ContextSegmentSource', { segment_id: callSource.segment_id })).length, 4,
      'the immutable tool segment now has independent source and target pairs');
    await h.turn(first.conversationId, 'continue-with-shared-tool-history');
    const second = await h.facade.forkConversation(await h.command(first.conversationId, 'tool-target-fork'));
    await h.turn(second.conversationId, 'continue-second-tool-fork');
    const sourceAgain = await h.facade.forkConversation(await h.command('source', 'tool-source-again'));
    await h.turn(sourceAgain.conversationId, 'continue-source-tool-fork');
  }, { withTool: true });
});

test('forks keep running, re-forking and child-forking after their tool-history source is deleted', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'deleted-source-tool-turn');
    const first = await h.facade.forkConversation(await h.command('source', 'fork-before-source-delete'));
    await h.app.database.conversationOwners.release('source', 'fixture-panel:source');
    assert.deepEqual(await h.facade.deleteConversation('source'), ['source']);
    const [callSource] = await rows(h.app, 'ContextSegmentSource', { source_kind: 'tool_call' });
    assert.equal((await rows(h.app, 'ContextSegmentSource', { segment_id: callSource.segment_id })).length, 4,
      'the shared immutable tool segment still carries the deleted source provenance');
    await h.turn(first.conversationId, 'fork-after-source-delete');
    const second = await h.facade.forkConversation(await h.command(first.conversationId, 'fork-of-orphaned-fork'));
    await h.turn(second.conversationId, 'second-generation-after-source-delete');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /deleted-source-tool-turn/);
    const [agent] = await rows(h.app, 'AgentConversationLink', { conversation_id: first.conversationId, role: 'default' });
    const now = new Date().toISOString();
    const child = await prepareChildContextFork(h.app.database, h.app.contentStore, {
      sourceConversationId: first.conversationId, targetConversationId: 'orphan-child-probe',
      targetAgentId: agent.agent_id, forkTurns: 'all', now
    });
    assert.ok(child.segments.length >= 3, 'the inherited tool pair and messages remain forkable');
    await h.app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'orphan-child-probe', title: 'Child probe', status: 'active', created_at: now, updated_at: now
      }),
      ...child.steps
    ]);
    const copiedChildCalls = (await rows(h.app, 'ToolCall')).length;
    assert.equal(copiedChildCalls, 3, 'first fork, second fork and child each own one copied ToolCall');
  }, { withTool: true });
});

async function blockStatuses(app, conversationIds) {
  return Object.fromEntries(await Promise.all(conversationIds.map(async conversationId =>
    [conversationId, (await rows(app, 'CompressionBlock', { conversation_id: conversationId })).map(block => block.status)]
  )));
}

async function firstMessageCommand(h, conversationId, commandId) {
  const [first] = (await rows(h.app, 'MessagePartOfConversation', { conversation_id: conversationId }))
    .sort((a, b) => Number(a.message_seq - b.message_seq));
  const [current] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: first.message_id });
  return { sourceConversationId: conversationId, messageId: first.message_id,
    expectedRevisionId: current.revision_id, command: { commandId } };
}

test('a fork owns its compression blocks and keeps running, re-forking and child-forking after the source is deleted', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'manual-compressed-input-1');
    await h.turn('source', 'manual-compressed-input-2');
    const runner = new ReliableConversationRunner(h.app, 'fork-fixture-owner');
    let compressionTurnId;
    try {
      const expectedRootId = await h.app.context.currentHeadRootId('source');
      const structure = await h.app.context.materializeStructure(expectedRootId);
      const compressed = await runner.manualCompression({
        commandId: 'manual-compression-before-fork', conversationId: 'source',
        compressSegmentCount: structure.records.length, target: { kind: 'current_head', expectedRootId }
      });
      assert.equal(compressed.compression.status, 'compressed');
      compressionTurnId = compressed.turnId;
    } finally { runner.dispose(); }
    assert.equal((await rows(h.app, 'MessageTurnLink', { turn_id: compressionTurnId })).length, 0);
    await h.turn('source', 'after-manual-compression');
    const fork = await h.facade.forkConversation(await h.command('source', 'fork-compressed-source'));
    const [sourceBlock] = await rows(h.app, 'CompressionBlock', { conversation_id: 'source' });
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

    await h.app.database.conversationOwners.release('source', 'fixture-panel:source');
    assert.deepEqual(await h.facade.deleteConversation('source'), ['source']);
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
});

test('editing inside an inherited compressed range disables only that conversation\'s own block', async () => {
  await withForkRuntime(async h => {
    const turn = await h.turn('source', 'shared-compressed-question');
    await h.turn('source', 'shared-compressed-follow-up');
    const [authority] = await rows(h.app, 'AuthoritySnapshot', { turn_id: turn.turnId });
    const rootId = await h.app.context.currentHeadRootId('source');
    const structure = await h.app.context.materializeStructure(rootId);
    await h.app.compression.create({
      conversationId: 'source', headRootId: rootId, authoritySnapshotId: authority.id,
      compressSegmentCount: structure.records.length, title: 'Shared summary',
      summary: 'Offline shared summary', idempotencyKey: 'shared-compression'
    });
    await h.turn('source', 'after-shared-compression');
    const first = await h.facade.forkConversation(await h.command('source', 'first-compressed-fork'));
    const second = await h.facade.forkConversation(await h.command('source', 'second-compressed-fork'));
    const conversations = ['source', first.conversationId, second.conversationId];
    assert.deepEqual(Object.values(await blockStatuses(h.app, conversations)), [['enabled'], ['enabled'], ['enabled']]);

    const edited = await firstMessageCommand(h, first.conversationId, 'unused');
    await h.app.turns.edit({
      source: { kind: 'command', key: 'edit-inside-fork-compression' }, conversationId: first.conversationId,
      messageId: edited.messageId, expectedRevisionId: edited.expectedRevisionId, content: 'edited inside the fork'
    });
    assert.deepEqual(await blockStatuses(h.app, conversations), {
      source: ['enabled'], [first.conversationId]: ['disabled'], [second.conversationId]: ['enabled']
    });

    const sourceFirst = await firstMessageCommand(h, 'source', 'unused');
    await h.app.turns.edit({
      source: { kind: 'command', key: 'edit-inside-source-compression' }, conversationId: 'source',
      messageId: sourceFirst.messageId, expectedRevisionId: sourceFirst.expectedRevisionId, content: 'edited inside the source'
    });
    assert.deepEqual(await blockStatuses(h.app, conversations), {
      source: ['disabled'], [first.conversationId]: ['disabled'], [second.conversationId]: ['enabled']
    });
    await h.turn(second.conversationId, 'untouched-fork-keeps-its-summary');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /Offline shared summary/);
    await h.turn(first.conversationId, 'edited-fork-continues');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /edited inside the fork/);
  });
});

async function compressWholeHead(h, conversationId, authorityTurnId, title, summary, idempotencyKey) {
  const [authority] = await rows(h.app, 'AuthoritySnapshot', { turn_id: authorityTurnId });
  const headRootId = await h.app.context.currentHeadRootId(conversationId);
  const structure = await h.app.context.materializeStructure(headRootId);
  return h.app.compression.create({
    conversationId, headRootId, authoritySnapshotId: authority.id,
    compressSegmentCount: structure.records.length, title, summary, idempotencyKey
  });
}

test('compression management acts only on the fork\'s own block, before and after its source is deleted', async () => {
  await withForkRuntime(async h => {
    const turn = await h.turn('source', 'managed-compressed-question');
    await h.turn('source', 'managed-compressed-follow-up');
    await compressWholeHead(h, 'source', turn.turnId, 'Managed summary', 'Offline managed summary', 'managed-compression');
    await h.turn('source', 'after-managed-compression');
    const first = (await h.facade.forkConversation(await h.command('source', 'managed-first-fork'))).conversationId;
    const second = (await h.facade.forkConversation(await h.command('source', 'managed-second-fork'))).conversationId;
    const ownBlock = async conversationId => {
      const blocks = (await rows(h.app, 'CompressionBlock', { conversation_id: conversationId })).filter(block => block.status === 'enabled');
      assert.equal(blocks.length, 1);
      return blocks[0];
    };
    const statuses = async () => Object.fromEntries(Object.entries(await blockStatuses(h.app, ['source', first, second]))
      .map(([conversationId, values]) => [conversationId, [...values].sort()]));
    const replaceOwnBlock = async (conversationId, summary) => h.app.compression.replace({
      conversationId, previousBlockId: (await ownBlock(conversationId)).id,
      expectedHeadRootId: await h.app.context.currentHeadRootId(conversationId), previousStatus: 'disabled',
      idempotencyKey: `replace-${summary}`, title: summary, summary
    });

    const firstBlock = await ownBlock(first);
    await h.app.compression.updateStatus(firstBlock.id, 'disabled');
    assert.deepEqual(await statuses(), { source: ['enabled'], [first]: ['disabled'], [second]: ['enabled'] });
    await h.app.compression.updateStatus(firstBlock.id, 'enabled');
    await replaceOwnBlock(first, 'Replaced first fork summary');
    assert.deepEqual(await statuses(), { source: ['enabled'], [first]: ['disabled', 'enabled'], [second]: ['enabled'] });
    await h.turn(first, 'after-first-fork-replacement');
    let context = h.requests.at(-1).context.map(item => item.content).join('\n');
    assert.match(context, /Replaced first fork summary/);
    assert.doesNotMatch(context, /Offline managed summary/);
    await h.turn('source', 'source-keeps-its-summary');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /Offline managed summary/);

    await h.app.database.conversationOwners.release('source', 'fixture-panel:source');
    assert.deepEqual(await h.facade.deleteConversation('source'), ['source']);
    const afterDelete = async () => Object.fromEntries(Object.entries(await statuses()).filter(([id]) => id !== 'source'));
    const secondBlock = await ownBlock(second);
    await h.app.compression.updateStatus(secondBlock.id, 'disabled');
    assert.deepEqual(await afterDelete(), { [first]: ['disabled', 'enabled'], [second]: ['disabled'] });
    await h.app.compression.updateStatus(secondBlock.id, 'enabled');
    await replaceOwnBlock(second, 'Replaced orphaned fork summary');
    await h.turn(second, 'after-orphaned-fork-replacement');
    context = h.requests.at(-1).context.map(item => item.content).join('\n');
    assert.match(context, /Replaced orphaned fork summary/);
    assert.doesNotMatch(context, /Replaced first fork summary|Offline managed summary/);

    // Editing inside the inherited compressed range of the orphaned fork disables only its blocks.
    const edited = await firstMessageCommand(h, second, 'unused');
    await h.app.turns.edit({
      source: { kind: 'command', key: 'edit-inside-orphaned-fork-compression' }, conversationId: second,
      messageId: edited.messageId, expectedRevisionId: edited.expectedRevisionId, content: 'edited inside the orphaned fork'
    });
    assert.deepEqual(await afterDelete(), { [first]: ['disabled', 'enabled'], [second]: ['disabled', 'disabled'] });
    await h.turn(second, 'edited-orphaned-fork-continues');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /edited inside the orphaned fork/);
    await h.turn(first, 'first-fork-unaffected');
    assert.match(h.requests.at(-1).context.map(item => item.content).join('\n'), /Replaced first fork summary/);
  });
});

test('the attachment catalog of a compressed fork reads only its own block, also after the source is deleted', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await withForkRuntime(async h => {
    const turn = await h.turn('source', 'attachment-history', undefined, {
      content: JSON.stringify({ role: 'user', parts: [{ text: 'attachment-history' }, {
        inlineData: { mimeType: 'image/png', name: 'fork-attachment.png', data: png, storage: 'embedded', status: 'available' }
      }] }),
      contentType: 'application/vnd.limcode.message+json'
    });
    await h.turn('source', 'attachment-follow-up');
    const compressed = await compressWholeHead(h, 'source', turn.turnId, 'Attachment summary', 'Offline attachment summary', 'attachment-compression');
    await h.turn('source', 'after-attachment-compression');
    const first = (await h.facade.forkConversation(await h.command('source', 'attachment-first-fork'))).conversationId;
    const second = (await h.facade.forkConversation(await h.command(first, 'attachment-second-fork'))).conversationId;
    assert.equal((await rows(h.app, 'ContextSegmentSource', { segment_id: compressed.summarySegmentId })).length, 3,
      'the shared summary segment carries one block source per Conversation');
    const catalog = async conversationId => {
      const structure = await h.app.context.materializeStructure(await h.app.context.currentHeadRootId(conversationId));
      assert.equal(structure.records[0].segment.id, compressed.summarySegmentId);
      const state = await h.app.modelProvider.projectAttachmentCatalogState(
        conversationId, structure.records.map(record => ({ segmentId: record.segment.id }))
      );
      return state.catalog.map(entry => entry.name);
    };
    for (const conversationId of ['source', first, second]) {
      assert.deepEqual(await catalog(conversationId), ['fork-attachment.png'], conversationId);
    }
    await h.app.database.conversationOwners.release('source', 'fixture-panel:source');
    assert.deepEqual(await h.facade.deleteConversation('source'), ['source']);
    for (const conversationId of [first, second]) {
      assert.deepEqual(await catalog(conversationId), ['fork-attachment.png'], `${conversationId} after the source is deleted`);
    }
    await h.turn(second, 'attachment-fork-continues');
  });
});

/** Tool names of the tool pairs already in a model request's Context, in order. */
function contextToolNames(request) {
  return request.context.filter(item => item.segmentKind === 'tool_pair').map(item => JSON.parse(item.content).toolCall.toolName);
}

test('a plan approved in the source still authorizes a retry in a fork of a fork', async () => {
  const planPolicy = { mode: 'before_mutation', allowReadonlyBeforeApproval: false, requireForToolRiskLevels: ['write'] };
  await withForkRuntime(async h => {
    await h.turn('source', 'plan-source-input');
    const [originalPlan] = await rows(h.app, 'ToolCall', { tool_name: 'submit_plan' });
    assert.ok(originalPlan);
    const first = await h.facade.forkConversation(await h.command('source', 'plan-first-fork'));
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
    async configure(configuration) {
      await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read', 'submit_plan'], sourceConfigs: { 'fixture-mcp': { enabled: true } } });
      await configuration.mutations.setPlanReviewPolicy({ scopeKind: 'global', ...planPolicy });
    },
    definitions: [
      { name: 'submit_plan', description: 'Synthetic plan', parameters: { type: 'object' } },
      { name: 'read', description: 'Synthetic offline probe', parameters: { type: 'object' } }
    ],
    // Scripted by the Context each request already holds, so extra model requests cannot shift it.
    reply(request) {
      const called = contextToolNames(request);
      if (request.conversationId === 'source') {
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
});

async function currentTaskItems(app, conversationId) {
  const window = (await app.database.clientProjectionSnapshot(conversationId)).snapshot.activeConversationWindow;
  return {
    current: window.currentTaskList?.items.map(item => [item.title, item.status]) ?? null,
    cards: window.taskList.map(card => [card.outcome, card.detail_on_demand, card.items?.map(item => [item.title, item.status]) ?? null])
  };
}

test('forks keep the task panel and the approved plan of copied tool calls, also after the source is deleted', async () => {
  const planPolicy = { mode: 'before_mutation', allowReadonlyBeforeApproval: false, requireForToolRiskLevels: ['write'] };
  const taskList = { mode: 'rewrite', items: [{ title: 'Fork task A', status: 'pending' }, { title: 'Fork task B', status: 'pending' }] };
  // Completing every task lets the turn end instead of being reminded of unfinished work.
  const update = { kind: 'task_list.operation', mode: 'update',
    items: [{ title: 'Fork task A', status: 'completed' }, { title: 'Fork task B', status: 'completed' }] };
  await withForkRuntime(async h => {
    await h.turn('source', 'task-source-input');
    const expected = {
      current: [['Fork task A', 'completed'], ['Fork task B', 'completed']],
      cards: [['succeeded', false, [['Fork task A', 'completed'], ['Fork task B', 'completed']]]]
    };
    assert.deepEqual(await currentTaskItems(h.app, 'source'), expected);
    const fork = await h.facade.forkConversation(await h.command('source', 'task-first-fork'));
    const nested = await h.facade.forkConversation(await h.command(fork.conversationId, 'task-nested-fork'));
    for (const conversationId of [fork.conversationId, nested.conversationId]) {
      assert.deepEqual(await currentTaskItems(h.app, conversationId), expected, 'copied task calls keep the task panel');
    }

    await h.app.database.conversationOwners.release('source', 'fixture-panel:source');
    assert.deepEqual(await h.facade.deleteConversation('source'), ['source']);
    for (const conversationId of [fork.conversationId, nested.conversationId]) {
      assert.deepEqual(await currentTaskItems(h.app, conversationId), expected, 'copied identity survives deleting the source');
    }

    const [copiedTurn] = await rows(h.app, 'Turn', { conversation_id: nested.conversationId });
    const [copiedPlan] = await rows(h.app, 'ToolCall', { turn_id: copiedTurn.id, tool_name: 'submit_plan' });
    const boundary = await h.command(nested.conversationId, 'task-retry-boundary');
    const retry = await h.turn(nested.conversationId, 'plan-retry-after-source-delete', {
      sourceTurnId: copiedTurn.id, target: { kind: 'message', messageId: boundary.messageId },
      expectedMessageRevisionId: boundary.expectedRevisionId
    });
    const [snapshot] = await rows(h.app, 'AuthoritySnapshot', { turn_id: retry.turnId });
    const { readFrozenTurnAuthority } = load('backend/reliableKernel/frozenAuthority.js');
    const authority = await readFrozenTurnAuthority(h.app.database, h.app.contentStore, snapshot.id, retry.turnId);
    assert.equal(authority.document.retryLineage.inheritedPlanApprovalToolCallId, copiedPlan.id);
    const [mutation] = await rows(h.app, 'ToolCall', { turn_id: retry.turnId, tool_name: 'read' });
    assert.ok(mutation, 'the retried turn issued a gated tool call');
    const gate = new kernel.FrozenAuthorityMcpPolicyGate(h.app.database, h.app.contentStore);
    assert.deepEqual(await gate.authorize({ toolCallId: mutation.id, serverId: 'fixture-mcp', toolName: 'read', riskLevel: 'write' }),
      { toolPolicyAllowed: true, planReviewAllowed: true });
    assert.deepEqual((await currentTaskItems(h.app, nested.conversationId)).current, expected.current);
  }, { script: {
    async configure(configuration) {
      await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read', 'submit_plan', 'update_task_list'], sourceConfigs: { 'fixture-mcp': { enabled: true } } });
      await configuration.mutations.setPlanReviewPolicy({ scopeKind: 'global', ...planPolicy });
    },
    definitions: [
      { name: 'submit_plan', description: 'Synthetic plan', parameters: { type: 'object' } },
      { name: 'update_task_list', description: 'Synthetic task list', parameters: { type: 'object' } },
      { name: 'read', description: 'Synthetic offline probe', parameters: { type: 'object' } }
    ],
    // Scripted by the Context each request already holds, so extra model requests cannot shift it.
    reply(request) {
      const called = contextToolNames(request);
      if (request.conversationId === 'source') {
        if (!called.includes('submit_plan')) return [{ functionCall: { name: 'submit_plan', args: { plan: 'task plan', taskList } } }];
        if (!called.includes('update_task_list')) return [{ functionCall: { name: 'update_task_list', args: update } }];
        return undefined;
      }
      return called.includes('read') ? undefined : [{ functionCall: { name: 'read', args: { path: 'synthetic-file.txt' } } }];
    },
    detail(input) {
      if (input.toolName === 'submit_plan') {
        return { kind: 'submit_plan.result', proposalId: 'task-plan', status: 'approved', executionTarget: 'current_conversation' };
      }
      if (input.toolName === 'update_task_list') return { kind: 'task-list', operation: update };
      return { text: 'synthetic tool result' };
    }
  } });
});

for (const fault of ['revision', 'duplicate']) {
  test(`tool prefix validation still rejects ${fault} provenance inside the same conversation`, async () => {
    await withForkRuntime(async h => {
      await h.turn('source', 'validate-synthetic-tool');
      const rootId = await h.app.context.currentHeadRootId('source');
      const database = h.app.database;
      const snapshot = database.snapshot.bind(database);
      let injected = false;
      database.snapshot = async (reads, ...rest) => {
        const result = await snapshot(reads, ...rest);
        return { ...result, snapshot: result.snapshot.map((value, index) => {
          if (reads[index].domain !== 'ContextSegmentSource' || !Array.isArray(value)
            || !value.some(row => row.source_kind === 'tool_model_result')) return value;
          injected = true;
          return fault === 'duplicate' ? [...value, value[0]] : value.map(row => row.source_kind === 'tool_model_result'
            ? { ...row, source_revision: BigInt(row.source_revision) + 1n } : row);
        }) };
      };
      try {
        await assert.rejects(h.app.context.assertNativeContextClosed(rootId), /source|duplicate|unique/i);
        assert.equal(injected, true);
      } finally {
        database.snapshot = snapshot;
      }
    }, { withTool: true });
  });
}

for (const compressed of [false, true]) {
for (const suffixCount of [32, 128]) {
  test(`early fork history selection stays linear across ${suffixCount} later roots (compressed=${compressed})`, async t => {
    await withForkRuntime(async h => {
      const turn = await h.turn('source', 'scale-boundary');
      const command = await h.command('source', `scale-fork-${suffixCount}`, 'user');
      if (compressed) {
        const [authority] = await rows(h.app, 'AuthoritySnapshot', { turn_id: turn.turnId });
        const rootId = await h.app.context.currentHeadRootId('source');
        const structure = await h.app.context.materializeStructure(rootId);
        await h.app.compression.create({
          conversationId: 'source', headRootId: rootId, authoritySnapshotId: authority.id,
          compressSegmentCount: structure.records.length, title: 'Scale summary',
          summary: 'Synthetic compressed history', idempotencyKey: 'scale-compression'
        });
      }
      for (let index = 0; index < suffixCount; index += 1) {
        await h.app.context.appendContent({
          conversationId: 'source', segmentKind: 'system',
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
  });
}
}

test('an early fork never reads the compressed roots of a later compression', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', `long history ${'以前的重要历史。'.repeat(12000)}`);
    await h.turn('source', 'early-boundary-before-compression');
    const early = await h.command('source', 'early-fork-before-later-compression');
    await h.saveCompression({ trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 },
      llmSummary: { targetTokens: 512 } });
    await h.turn('source', 'later-compressing-turn');
    await h.saveCompression({ trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 120000 } });
    for (let index = 0; index < 4; index += 1) await h.turn('source', `later-turn-${index}`);
    const compressedRoots = new Set();
    for (const root of await rows(h.app, 'ContextSequenceRoot', { conversation_id: 'source' })) {
      if ((await h.app.context.materializeStructure(root.id)).records[0].segment.segment_kind === 'compression') compressedRoots.add(root.id);
    }
    assert.ok(compressedRoots.size >= 8, 'fixture: every later root keeps the boundary in its compressed tail');
    const database = h.app.database;
    const materialize = database.materializeContext.bind(database);
    const read = [];
    database.materializeContext = async (rootId, ...rest) => { read.push(rootId); return materialize(rootId, ...rest); };
    let fork;
    try {
      fork = await h.facade.forkConversation(early);
    } finally {
      database.materializeContext = materialize;
    }
    assert.deepEqual(read.filter(rootId => compressedRoots.has(rootId)), [],
      'a compression whose Turn follows the cut is rejected from its summary alone');
    assert.deepEqual(await rows(h.app, 'CompressionBlock', { conversation_id: fork.conversationId }), []);
  }, { compression: true });
});

test('candidate probe excludes an actual compressed tail ancestor outside its visible window', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'hidden-boundary');
    const command = await h.command('source', 'hidden-boundary-fork', 'user');
    const [source] = await rows(h.app, 'ContextSegmentSource', { source_kind: 'message_revision', source_id: command.expectedRevisionId });
    const turn = await h.turn('source', 'visible-tail');
    const [authority] = await rows(h.app, 'AuthoritySnapshot', { turn_id: turn.turnId });
    await h.app.compression.create({
      conversationId: 'source', headRootId: await h.app.context.currentHeadRootId('source'),
      authoritySnapshotId: authority.id, compressSegmentCount: 2, title: 'Hidden boundary',
      summary: 'Compressed first exchange', idempotencyKey: 'hidden-boundary-compression'
    });
    const rootId = await h.app.context.currentHeadRootId('source');
    const structure = await h.app.context.materializeStructure(rootId);
    assert.equal(structure.root.tail_segment_count, 2n);
    assert.equal(structure.records.length, 3);
    assert.ok(!structure.records.some(record => record.segment.id === source.segment_id));
    const physical = [];
    let cursor = structure.root.tail_node_id;
    while (cursor !== null) {
      const [node] = await rows(h.app, 'ContextSequenceNode', { id: cursor });
      physical.push(node.segment_id);
      cursor = node.parent_node_id;
    }
    assert.ok(physical.indexOf(source.segment_id) >= Number(structure.root.tail_segment_count),
      'fixture must actually cross the compressed tail truncation, not use an unrelated chain');
    const targets = new Set([source.segment_id]);
    const hidden = new ForkContextCandidateProbe(h.app.database, targets);
    targets.clear();
    targets.add(physical[0]);
    assert.equal(await hidden.mayContain(structure.root), false, 'target set is fixed per probe, and hidden ancestry is not visible');
    assert.equal(await new ForkContextCandidateProbe(h.app.database, targets).mayContain(structure.root), true);
    const target = await h.facade.forkConversation(command);
    await h.turn(target.conversationId, 'after-hidden-boundary-fork');
  });
});

test('candidate probe rejects missing nodes, cycles and malformed windows instead of negative-caching them', async () => {
  const ordinary = { root_node_id: 'tip', tail_node_id: null, segment_count: 1n, tail_segment_count: 0n };
  const makeProbe = nodes => new ForkContextCandidateProbe({
    async snapshot(reads) {
      return { snapshot: reads.map(read => read.domain === 'ContextSequenceNode'
        ? nodes.get(read.id) ?? null : { segment_kind: read.id === 'summary' ? 'compression' : 'system' }) };
    }
  }, new Set(['not-present']));
  const valid = new Map([['tip', { segment_id: 'suffix', parent_node_id: null }]]);
  await assert.rejects(makeProbe(new Map()).mayContain(ordinary), /missing/);
  await assert.rejects(makeProbe(new Map([['tip', { segment_id: 'suffix', parent_node_id: 'tip' }]])).mayContain(ordinary), /cycle/);
  for (const count of [-1n, 0n, 2n, 1, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
    await assert.rejects(makeProbe(valid).mayContain({ ...ordinary, segment_count: count }), /count|chain/);
  }
  const compressed = new Map([...valid, ['summary-node', { segment_id: 'summary', parent_node_id: null }]]);
  await assert.rejects(makeProbe(compressed).mayContain({ ...ordinary,
    root_node_id: 'summary-node', tail_node_id: 'tip', tail_segment_count: 2n, segment_count: 3n
  }), /chain\/count/);
  await assert.rejects(makeProbe(compressed).mayContain({ ...ordinary,
    root_node_id: 'summary-node', tail_node_id: 'tip', tail_segment_count: 1n, segment_count: 3n
  }), /window/);
});

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
