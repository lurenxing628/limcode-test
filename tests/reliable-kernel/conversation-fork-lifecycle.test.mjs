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
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const { VscodeReliableKernelApplicationFacade: Facade } = load('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
const { ForkContextCandidateProbe } = load('backend/reliableKernel/conversationForkContext.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { workEnvironmentIdFromUri } = load('shared/workEnvironmentCatalog.js');

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
  }))).snapshot;
}

async function withForkRuntime(run, { withTool = false } = {}) {
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
  if (withTool) await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read'] });
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
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
      attachmentSettings: configuration,
      providers: { resolve(providerId) {
        assert.equal(providerId, provider.id);
        return { providerId, async sendFullRequest(request, controls) {
          requests.push(request);
          await controls.onEvent({ kind: 'completed', streamSeq: '1',
            content: { role: 'model', parts: withTool && requests.length === 1
              ? [{ functionCall: { name: 'read', args: { path: 'synthetic-file.txt' } } }]
              : [{ text: `offline reply ${requests.length}` }] } });
        } };
      } },
      toolDispatcher: {
        definitions() { return withTool ? [{ name: 'read', description: 'Synthetic offline probe', parameters: { type: 'object' } }] : []; },
        async dispatch(input) {
          assert.equal(withTool, true, 'only the tool fixture may dispatch');
          const settled = await app.runtime.effects.settleWithoutEffect({
            source: { kind: 'internal', key: `fixture-read:${input.toolCallId}` },
            toolCallId: input.toolCallId, status: 'succeeded', detail: { text: 'synthetic tool result' }
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
      get configuration() { return configuration; }, requests, environmentId,
      async reopen() { await app.close(); await open(); },
      async turn(conversationId, key, retry) {
        // Match claim-before-open: keep the panel's reference through the whole fake-provider turn.
        await app.database.conversationOwners.retain(conversationId, `fixture-panel:${conversationId}`);
        const command = {
          source: { kind: 'command', key }, conversationId,
          leaseOwnerId: 'fork-fixture-owner', hostBootId: app.database.hostBootId,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()
        };
        const input = retry
          ? await app.turns.retry({ ...command, ...retry })
          : await app.turns.input({ ...command, content: key });
        const [lease] = await rows(app, 'ExecutionLease', { turn_id: input.turnId });
        assert.ok(lease);
        const result = await kernel.runWithExecutionLeaseFence({
          id: lease.id, conversationId, turnId: input.turnId, ownerId: lease.owner_id,
          hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
        }, () => app.agentLoop.drive(input.turnId));
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

test('configuration copy interrupted after model selection resumes the same target after reopen', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'copy-source-input');
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
    const [branch] = await rows(h.app, 'ConversationBranchLink');
    const target = branch.target_conversation_id;
    let config = await h.configuration.configurationClientState();
    const modelLink = config.modelProfileScopeLinks.find(link => link.scopeId === target);
    assert.ok(modelLink, 'model copy was durable before the environment copy failed');
    assert.equal(config.conversationWorkEnvironmentLinks.some(link => link.conversationId === target), false);
    await h.reopen();
    const replay = await h.facade.forkConversation(command);
    assert.deepEqual(replay, { conversationId: target, deduplicated: true });
    config = await h.configuration.configurationClientState();
    assert.equal(config.modelProfileScopeLinks.filter(link => link.scopeId === target).length, 1);
    assert.equal(config.conversationWorkEnvironmentLinks.find(link => link.conversationId === target)?.workEnvironmentId, h.environmentId);
    await h.turn(target, 'recovered-target-input');
    assert.equal((await rows(h.app, 'Conversation')).length, 2);
  });
});

test('lost fork result replays after a source revision change without overwriting target selections', async () => {
  await withForkRuntime(async h => {
    await h.turn('source', 'revision-source-input');
    const command = await h.command('source', 'lost-result', 'user');
    const first = await h.facade.forkConversation(command);
    await h.configuration.mutations.selectConversationWorkflow({
      conversationId: first.conversationId, scopeKind: 'global'
    });
    await h.app.turns.edit({
      source: { kind: 'command', key: 'edit-after-fork' }, conversationId: 'source',
      messageId: command.messageId, expectedRevisionId: command.expectedRevisionId,
      content: 'changed source after the fork committed'
    });
    await h.reopen();
    assert.deepEqual(await h.facade.forkConversation(command), { ...first, deduplicated: true });
    const config = await h.configuration.configurationClientState();
    assert.equal(config.conversationWorkflowSelections.find(item => item.conversationId === first.conversationId)?.scopeKind, 'global');
    await assert.rejects(h.facade.forkConversation({ ...command, command: { commandId: 'new-stale-fork' } }), /Revision/);
    assert.equal((await rows(h.app, 'Conversation')).length, 2);
    await h.turn(first.conversationId, 'unchanged-fork-input');
    assert.doesNotMatch(h.requests.at(-1).context.map(item => item.content).join('\n'), /changed source after/);
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
