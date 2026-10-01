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
const { RuntimeWriteGate } = load('backend/application/reliableKernel/runtimeWriteGate.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { workEnvironmentIdFromUri } = load('shared/workEnvironmentCatalog.js');
const { resolveModelToolArguments } = load('backend/reliableKernel/modelHandleCatalog.js');
const { ConversationAttachmentHandleRegistry } = load('backend/reliableKernel/conversationAttachmentHandles.js');
const { readFrozenConversationAttachmentReservations } = load('backend/reliableKernel/frozenConversationAttachmentHandles.js');
const { projectStoredModelFacingWindow } = load('backend/reliableKernel/modelFacingContextProjection.js');

const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const attachmentMessage = name => ({ content: JSON.stringify({ role: 'user', parts: [
  { text: name }, { inlineData: { mimeType: 'image/png', name, data: IMAGE, storage: 'embedded', status: 'available' } }
] }), contentType: 'application/vnd.limcode.message+json' });

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
  }))).snapshot;
}

async function withRuntime(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-fork-attachment-reservations-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const configurationRoot = path.join(directory, 'configuration');
  const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(configurationRoot));
  let configuration = new VscodeConfigurationAuthority(getPaths);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'Offline attachment fixture' }),
    id: 'attachment-fixture-provider', model: 'attachment-fixture-model',
    models: [{ id: 'attachment-fixture-model', name: 'Offline model' }] };
  for (const [section, settings] of [
    ['llmProviderConfigs', { configs: [provider] }], ['llm', { activeProviderConfigId: provider.id }]
  ]) {
    const current = await configuration.loadGlobalSettings(section);
    await configuration.saveGlobalSettings(section, settings, current.revision);
  }
  await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read'] });
  const agent = await configuration.mutations.createAgent({ name: 'Attachment fixture', kind: 'custom' });
  await configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: 'source',
    providerConfigId: provider.id, provider: provider.provider, model: provider.model });
  const rootPath = path.join(directory, 'workspace');
  await fs.mkdir(rootPath);
  const uri = vscode.Uri.file(rootPath).toString();
  const synchronize = () => configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath, index: 0 }]);
  await synchronize();
  await configuration.mutations.selectConversationWorkEnvironment('source', workEnvironmentIdFromUri(uri));
  const requests = [];
  const dispatches = [];
  let initialRead = true;
  let rejectedRead = false;
  let app;
  let facade;
  const open = async () => {
    configuration = new VscodeConfigurationAuthority(getPaths);
    await synchronize();
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
      providers: { resolve(providerId) {
        return { providerId, async sendFullRequest(request, controls) {
          requests.push(request);
          const parts = initialRead
            ? [{ functionCall: { name: 'read', args: { path: 'old-image.png' } } }]
            : rejectedRead ? [{ functionCall: { name: 'read', args: { attachmentRef: 'F1' } } }]
              : [{ text: 'Offline reply.' }];
          initialRead = false;
          rejectedRead = false;
          await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts } });
        } };
      } },
      toolDispatcher: {
        definitions() { return [{ name: 'read', description: 'Offline image read', parameters: { type: 'object' } }]; },
        async dispatch(input) {
          dispatches.push(input);
          const settled = await app.runtime.effects.settleWithoutEffect({
            source: { kind: 'internal', key: `fixture-image:${input.toolCallId}` },
            toolCallId: input.toolCallId, status: 'succeeded', detail: JSON.parse(attachmentMessage('old-image.png').content)
          });
          return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
        }
      }
    });
    facade = Object.create(Facade.prototype);
    facade.product = { application: app, configuration };
    facade.runtimePlacement = { configurationRootPath: configurationRoot };
    facade.writeGate = new RuntimeWriteGate();
    facade.historyEntries = [];
    facade.refreshConversationHistory = async () => {};
    facade.revealConversationHistoryTop = async () => {};
  };
  try {
    await open();
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'source', title: 'Source fixture',
        status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'source-agent', conversation_id: 'source',
        agent_id: agent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    const h = {
      get app() { return app; }, get facade() { return facade; }, requests, dispatches,
      async reopen() { await app.close(); await open(); },
      requestReadOfOldRef() { rejectedRead = true; },
      async turn(conversationId, key, retry, message = {}) {
        const command = { source: { kind: 'command', key }, conversationId, leaseOwnerId: 'attachment-fixture-owner',
          hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() };
        const input = retry ? await app.turns.retry({ ...command, ...retry })
          : await app.turns.input({ ...command, content: message.content ?? key,
            ...(message.contentType ? { contentType: message.contentType } : {}) });
        const [lease] = await rows(app, 'ExecutionLease', { turn_id: input.turnId });
        const result = await kernel.runWithExecutionLeaseFence({ id: lease.id, conversationId, turnId: input.turnId,
          ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
        }, () => app.agentLoop.drive(input.turnId));
        assert.equal(result.terminalStatus, 'completed');
        return input;
      },
      async command(conversationId, commandId) {
        const members = (await rows(app, 'MessagePartOfConversation', { conversation_id: conversationId }))
          .sort((a, b) => Number(b.message_seq - a.message_seq));
        for (const member of members) {
          const [current] = await rows(app, 'MessageCurrentRevisionLink', { message_id: member.message_id });
          const [revision] = await rows(app, 'MessageRevision', { id: current.revision_id });
          if (revision.role === 'model') return { sourceConversationId: conversationId, messageId: member.message_id,
            expectedRevisionId: revision.id, command: { commandId } };
        }
        assert.fail('No fork boundary');
      },
      async activeAttachments(conversationId) {
        const structure = await app.context.materializeStructure(await app.context.currentHeadRootId(conversationId));
        return (await app.modelProvider.projectAttachmentCatalogState(conversationId,
          structure.records.map(record => ({ segmentId: record.segment.id })))).catalog;
      }
    };
    await run(h);
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function discardedAttachmentFork(h, commandId) {
  const original = await h.turn('source', 'read-old-image');
  const [oldHandle] = await rows(h.app, 'ConversationAttachmentHandleLink', { conversation_id: 'source' });
  assert.equal(oldHandle.handle_seq, 1n);
  const [call] = await rows(h.app, 'ToolCall', { turn_id: original.turnId });
  const [source] = await rows(h.app, 'ToolCallSourceLink', { tool_call_id: call.id });
  const [current] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: source.message_id });
  await h.turn('source', 'retry-image-output', { sourceTurnId: original.turnId,
    target: { kind: 'message', messageId: source.message_id }, expectedMessageRevisionId: current.revision_id });
  await h.turn('source', 'Remember the previously supplied F1 attachment.');
  assert.deepEqual(await h.activeAttachments('source'), []);
  const command = await h.command('source', commandId);
  const fork = await h.facade.forkConversation(command);
  return { oldHandle, fork, command };
}

/**
 * Isolate the published producer's exact F bug before committing the fork: its snapshot retained
 * handle rows only for copied visible AttachmentLinks. The real fork transaction still copies the
 * immutable Recipes. No committed registry or SQLite row is removed to manufacture the old state.
 */
async function withPublishedAttachmentSnapshot(run) {
  const snapshot = load('backend/reliableKernel/conversationForkSnapshot.js');
  const current = snapshot.prepareConversationForkSnapshot;
  snapshot.prepareConversationForkSnapshot = async (...args) => {
    const plan = await current(...args);
    const visible = new Set(plan.inserts.filter(step => step.kind === 'insert' && step.domain === 'AttachmentLink')
      .map(step => step.row.attachment_id));
    return { ...plan, inserts: plan.inserts.filter(step => step.kind !== 'insert'
      || step.domain !== 'ConversationAttachmentHandleLink' || visible.has(step.row.attachment_id)) };
  };
  try { return await run(); }
  finally { snapshot.prepareConversationForkSnapshot = current; }
}

async function frozenAttachmentEvidence(h, conversationId) {
  const result = [];
  for (const turn of await rows(h.app, 'Turn', { conversation_id: conversationId })) {
    for (const request of await rows(h.app, 'ModelRequest', { turn_id: turn.id })) {
      const [metadata] = await rows(h.app, 'ContentObject', { id: request.recipe_object_id });
      const recipe = JSON.parse((await h.app.contentStore.read(metadata)).toString('utf8'));
      result.push(...(recipe.modelHandleCatalog?.entries.filter(entry => entry.kind === 'attachment') ?? []));
    }
  }
  return result;
}

test('fork retains discarded F1 identity without exposing its attachment or routing it to a new image', async () => {
  await withRuntime(async h => {
    const { oldHandle, fork, command } = await discardedAttachmentFork(h, 'fork-reservations');
    const replay = await h.facade.forkConversation(command);
    assert.equal(replay.conversationId, fork.conversationId);
    assert.equal(replay.deduplicated, true);
    const [reservation] = await rows(h.app, 'ConversationAttachmentHandleLink', { conversation_id: fork.conversationId });
    assert.ok(reservation, 'the fork must retain F1 even though its attachment output was discarded');
    assert.equal(reservation.attachment_id, oldHandle.attachment_id);
    assert.equal(reservation.handle_seq, 1n);
    assert.deepEqual(await h.activeAttachments(fork.conversationId), []);
    let frozenOldRef = false;
    for (const turn of await rows(h.app, 'Turn', { conversation_id: fork.conversationId })) {
      for (const request of await rows(h.app, 'ModelRequest', { turn_id: turn.id })) {
        const [metadata] = await rows(h.app, 'ContentObject', { id: request.recipe_object_id });
        const recipe = JSON.parse((await h.app.contentStore.read(metadata)).toString('utf8'));
        frozenOldRef ||= recipe.modelHandleCatalog?.entries.some(entry => entry.ref === 'F1' && entry.target === oldHandle.attachment_id) ?? false;
      }
    }
    assert.equal(frozenOldRef, true, 'the copied historical Recipe still names the old F1');
    await h.turn(fork.conversationId, 'upload-fork-image', undefined, attachmentMessage('new-image.png'));
    const request = h.requests.at(-1);
    const catalog = request.recipe.modelHandleCatalog;
    const [attachment] = catalog.entries.filter(entry => entry.kind === 'attachment');
    assert.equal(attachment.ref, 'F2');
    assert.notEqual(attachment.target, oldHandle.attachment_id);
    assert.deepEqual((await h.activeAttachments(fork.conversationId)).map(entry => entry.name), ['new-image.png']);
    assert.ok(request.context.some(item => item.content.includes('previously supplied F1')));
    assert.throws(() => resolveModelToolArguments('read', { attachmentRef: 'F1' }, catalog), /当前可用/);
    assert.deepEqual(resolveModelToolArguments('read', { attachmentRef: 'F2' }, catalog), { attachmentId: attachment.target });
    const priorDispatches = h.dispatches.length;
    h.requestReadOfOldRef();
    await h.turn(fork.conversationId, 'reject-old-ref-without-dispatch');
    assert.equal(h.dispatches.length, priorDispatches, 'a stale F1 cannot read the new image through the dispatcher');
    assert.deepEqual((await h.app.modelProvider.replay(request.modelRequestId)).recipe.modelHandleCatalog, catalog);
  });
});

test('nested forks keep the attachment watermark after source deletion, reopening and command replay', async () => {
  await withRuntime(async h => {
    const { oldHandle, fork } = await discardedAttachmentFork(h, 'fork-to-delete-source');
    const nestedCommand = await h.command(fork.conversationId, 'nested-reservations');
    const nested = await h.facade.forkConversation(nestedCommand);
    assert.equal((await h.facade.forkConversation(nestedCommand)).conversationId, nested.conversationId);
    assert.deepEqual(await h.activeAttachments(nested.conversationId), []);
    await h.facade.deleteConversation('source');
    await h.facade.deleteConversation(fork.conversationId);
    await h.reopen();
    const [reservation] = await rows(h.app, 'ConversationAttachmentHandleLink', { conversation_id: nested.conversationId });
    assert.ok(reservation, 'nested F1 reservations must survive deleting both sources and reopening');
    assert.equal(reservation.handle_seq, 1n);
    assert.equal(reservation.attachment_id, oldHandle.attachment_id);
    assert.equal((await rows(h.app, 'Attachment', { id: oldHandle.attachment_id })).length, 1,
      'the reserved immutable identity survives deleting its source Conversations');
    assert.deepEqual(await h.activeAttachments(nested.conversationId), []);
    await h.turn(nested.conversationId, 'nested-new-image', undefined, attachmentMessage('nested-image.png'));
    assert.equal(h.requests.at(-1).recipe.modelHandleCatalog.entries.find(entry => entry.kind === 'attachment').ref, 'F2');
    await h.reopen();
    await h.turn(nested.conversationId, 'nested-next-image', undefined, attachmentMessage('third-image.png'));
    assert.deepEqual(h.requests.at(-1).recipe.modelHandleCatalog.entries.filter(entry => entry.kind === 'attachment').map(entry => entry.ref), ['F2', 'F3']);
  });
});

test('published forks recover known frozen F reservations before an empty ensure and preserve read-only peek', async () => {
  await withRuntime(async h => {
    const { oldHandle, fork } = await withPublishedAttachmentSnapshot(() => discardedAttachmentFork(h, 'published-fork-upgrade'));
    assert.deepEqual(await rows(h.app, 'ConversationAttachmentHandleLink', { conversation_id: fork.conversationId }), [],
      'the published snapshot omitted an address whose output was retried away');
    assert.ok((await frozenAttachmentEvidence(h, fork.conversationId)).some(entry => entry.ref === 'F1'
      && entry.target === oldHandle.attachment_id), 'the actual copied Recipe still freezes the missing F1 identity');
    await h.reopen();
    const registry = new ConversationAttachmentHandleRegistry(h.app.database, { contentStore: h.app.contentStore });
    assert.deepEqual(await registry.peek(fork.conversationId, []), { entries: [] });
    assert.deepEqual(await rows(h.app, 'ConversationAttachmentHandleLink', { conversation_id: fork.conversationId }), [],
      'read-only prediction must not repair the address registry');
    await h.turn('source', 'source-peek-image', undefined, attachmentMessage('peek-image.png'));
    const sourceVisible = await h.activeAttachments('source');
    assert.equal((await registry.peek(fork.conversationId, sourceVisible)).entries[0].ref, 'F2');
    assert.deepEqual(await rows(h.app, 'ConversationAttachmentHandleLink', { conversation_id: fork.conversationId }), []);
    assert.deepEqual(await registry.ensure(fork.conversationId, []), { entries: [] });
    const [recovered] = await rows(h.app, 'ConversationAttachmentHandleLink', { conversation_id: fork.conversationId });
    assert.equal(recovered.handle_seq, 1n);
    assert.equal(recovered.attachment_id, oldHandle.attachment_id);
    assert.deepEqual(await h.activeAttachments(fork.conversationId), [], 'restoring an address grants no attachment visibility');
    await h.turn(fork.conversationId, 'upgrade-new-image', undefined, attachmentMessage('upgrade-new-image.png'));
    const catalog = h.requests.at(-1).recipe.modelHandleCatalog;
    const [newAttachment] = catalog.entries.filter(entry => entry.kind === 'attachment');
    assert.equal(newAttachment.ref, 'F2');
    assert.notEqual(newAttachment.target, oldHandle.attachment_id);
    assert.throws(() => resolveModelToolArguments('read', { attachmentRef: 'F1' }, catalog), /当前可用/);
    assert.deepEqual(resolveModelToolArguments('read', { attachmentRef: 'F2' }, catalog), { attachmentId: newAttachment.target });
  });
});

test('reforking a published fork restores its missing addresses without requiring a new model turn', async () => {
  await withRuntime(async h => {
    const { oldHandle, fork } = await withPublishedAttachmentSnapshot(() => discardedAttachmentFork(h, 'published-source-fork'));
    await h.reopen();
    const command = await h.command(fork.conversationId, 'current-refork-of-published');
    const nested = await h.facade.forkConversation(command);
    for (const conversationId of [fork.conversationId, nested.conversationId]) {
      const [reservation] = await rows(h.app, 'ConversationAttachmentHandleLink', { conversation_id: conversationId });
      assert.equal(reservation.handle_seq, 1n);
      assert.equal(reservation.attachment_id, oldHandle.attachment_id);
      assert.deepEqual(await h.activeAttachments(conversationId), []);
    }
    await h.facade.deleteConversation('source');
    await h.facade.deleteConversation(fork.conversationId);
    await h.reopen();
    await h.turn(nested.conversationId, 'refork-new-image', undefined, attachmentMessage('refork-new-image.png'));
    assert.equal(h.requests.at(-1).recipe.modelHandleCatalog.entries.find(entry => entry.kind === 'attachment').ref, 'F2');
    assert.equal((await h.facade.forkConversation(command)).conversationId, nested.conversationId);
  });
});

test('frozen F recovery accepts legal minimal handle entries without optional attachment metadata', async () => {
  await withRuntime(async h => {
    const provider = h.app.modelProvider;
    const create = provider.createModelRequest;
    provider.createModelRequest = function (command) {
      const catalog = command.recipe.modelHandleCatalog;
      return create.call(this, { ...command, recipe: { ...command.recipe,
        modelHandleCatalog: { ...catalog, entries: catalog.entries.map(entry => entry.kind === 'attachment'
          ? { kind: entry.kind, ref: entry.ref, target: entry.target } : entry) } } });
    };
    let result;
    try { result = await withPublishedAttachmentSnapshot(() => discardedAttachmentFork(h, 'minimal-frozen-fork')); }
    finally { provider.createModelRequest = create; }
    const { oldHandle, fork } = result;
    await h.reopen();
    const frozen = await readFrozenConversationAttachmentReservations(h.app.database, h.app.contentStore, fork.conversationId);
    assert.deepEqual(frozen.entries, [{ kind: 'attachment', ref: 'F1', target: oldHandle.attachment_id }]);
    const registry = new ConversationAttachmentHandleRegistry(h.app.database, { contentStore: h.app.contentStore });
    assert.deepEqual(await registry.ensure(fork.conversationId, []), { entries: [] });
    const [recovered] = await rows(h.app, 'ConversationAttachmentHandleLink', { conversation_id: fork.conversationId });
    assert.equal(recovered.handle_seq, 1n);
    assert.equal(recovered.attachment_id, oldHandle.attachment_id);
    await h.turn(fork.conversationId, 'minimal-frozen-new-image', undefined, attachmentMessage('minimal-new-image.png'));
    assert.equal(h.requests.at(-1).recipe.modelHandleCatalog.entries.find(entry => entry.kind === 'attachment').ref, 'F2');
  });
});

test('ordinary JSON attachmentId data cannot mint a hidden F alias or corrupt the next image address', async () => {
  await withRuntime(async h => {
    const { oldHandle, fork } = await discardedAttachmentFork(h, 'raw-candidate-fork');
    await h.turn(fork.conversationId, 'candidate-new-image', undefined, attachmentMessage('candidate-new-image.png'));
    const [newAttachment] = h.requests.at(-1).recipe.modelHandleCatalog.entries.filter(entry => entry.kind === 'attachment');
    assert.equal(newAttachment.ref, 'F2');
    await h.turn(fork.conversationId, 'raw-attachment-id-data', undefined,
      { content: JSON.stringify({ attachmentId: oldHandle.attachment_id, label: 'metadata only' }) });
    const rawRequest = h.requests.at(-1);
    const catalog = rawRequest.recipe.modelHandleCatalog;
    assert.deepEqual(catalog.entries.filter(entry => entry.kind === 'attachment').map(entry => [entry.ref, entry.target]),
      [['F2', newAttachment.target]]);
    assert.throws(() => resolveModelToolArguments('read', { attachmentRef: 'F1' }, catalog), /当前可用/);
    assert.throws(() => resolveModelToolArguments('read', { attachmentRef: 'F3' }, catalog), /当前可用/);
    assert.deepEqual(resolveModelToolArguments('read', { attachmentRef: 'F2' }, catalog), { attachmentId: newAttachment.target });
    const registryRows = await rows(h.app, 'ConversationAttachmentHandleLink', { conversation_id: fork.conversationId });
    assert.deepEqual(registryRows.map(row => [row.handle_seq, row.attachment_id]).sort((a, b) => Number(a[0] - b[0])),
      [[1n, oldHandle.attachment_id], [2n, newAttachment.target]]);
    assert.deepEqual((await h.activeAttachments(fork.conversationId)).map(entry => entry.name), ['candidate-new-image.png']);
    const projected = projectStoredModelFacingWindow(rawRequest.context, rawRequest.attachmentCatalogState,
      rawRequest.recipe.modelHandleCatalog);
    assert.ok(!JSON.stringify(projected).includes('"attachmentId":"F3"'), 'pure current-contract projection cannot invent F3');
    await h.reopen();
    await h.turn(fork.conversationId, 'candidate-third-image', undefined, attachmentMessage('candidate-third-image.png'));
    const attachments = h.requests.at(-1).recipe.modelHandleCatalog.entries.filter(entry => entry.kind === 'attachment');
    assert.deepEqual(attachments.map(entry => entry.ref), ['F2', 'F3']);
    const third = attachments.find(entry => entry.ref === 'F3');
    assert.notEqual(third.target, oldHandle.attachment_id);
    assert.notEqual(third.target, newAttachment.target);
    const evidence = await readFrozenConversationAttachmentReservations(h.app.database, h.app.contentStore, fork.conversationId);
    assert.equal(evidence.entries.find(entry => entry.ref === 'F3').target, third.target);
    await h.turn(fork.conversationId, 'candidate-after-third-image');
  });
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
    async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? FileType.Directory : FileType.File,
      ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }; }
  } } };
}
