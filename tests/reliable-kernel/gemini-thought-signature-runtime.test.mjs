/**
 * Gemini thought signatures through the real kernel: the production provider registry (unified
 * Gemini decoder, stream projection, event batcher, full-request adapter), the agent loop, the
 * Context writer, restart, fork, compression and a mid-conversation provider switch. Only fetch is
 * replaced: it serves scripted Gemini SSE and records the exact wire body of every request.
 *
 * Official rules under test (https://ai.google.dev/gemini-api/docs/thought-signatures):
 * “You must return this signature in the exact part where it was received”; parallel calls carry the
 * signature on the first call only; “Model responses without a function call will return a thought
 * signature inside the last part”, and while streaming “the model may return the thought signature in
 * a part with an empty text content part”.
 */
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
const originalFetch = globalThis.fetch;
after(() => {
  Module._load = originalLoad;
  globalThis.fetch = originalFetch;
});
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const { VscodeReliableKernelApplicationFacade: Facade } = load('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { dryRunLlmProvider } = load('backend/capabilities/llmProvider.js');
const { ReliableLlmProviderRegistry, applyFrozenModelProviderConfig } = load('backend/reliableKernel/llmCapabilityProviderRegistry.js');
const { workEnvironmentIdFromUri } = load('shared/workEnvironmentCatalog.js');

const GEMINI_MODEL = 'gemini-3.7-flash';

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 200
  }))).snapshot;
}

const chunk = (parts, finishReason) => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }]
});

/** The text of the Turn input the request answers (the fixture never reinjects the input). */
function inputText(request) {
  const latest = request.context.filter(item => item.segmentKind === 'message' && item.messageRole === 'user').at(-1);
  if (!latest) return '';
  if (!latest.contentType.startsWith('application/vnd.limcode.message+json')) return latest.content;
  return JSON.parse(latest.content).parts.map(part => part.text ?? '').join('');
}

const answeredTools = request => request.context.some(item => item.segmentKind === 'tool_pair'
  && JSON.parse(item.content).toolCall.toolName === 'lookup'
  && request.context.indexOf(item) > request.context.findLastIndex(entry => entry.segmentKind === 'message' && entry.messageRole === 'user'));

/** Scripted Gemini streams, shaped like the documented signature positions. */
function geminiScript(request) {
  const input = inputText(request);
  if (input === 'start-work' && !answeredTools(request)) {
    return [
      chunk([{ text: 'Planning two lookups.', thought: true }]),
      chunk([
        { functionCall: { name: 'lookup', args: { key: 'a' }, id: 'call_a' }, thoughtSignature: 'SIG_CALLS' },
        { functionCall: { name: 'lookup', args: { key: 'b' }, id: 'call_b' } }
      ]),
      chunk([{ text: '' }], 'STOP')
    ];
  }
  if (input === 'start-work') {
    return [
      chunk([{ text: 'Both looked up.', thought: true }]),
      chunk([{ text: 'Both' }]),
      chunk([{ text: ' values found.' }]),
      chunk([{ text: '', thoughtSignature: 'SIG_EMPTY_TAIL' }], 'STOP')
    ];
  }
  if (input === 'second') {
    return [chunk([{ text: 'Second' }]), chunk([{ text: ' answer.', thoughtSignature: 'SIG_LAST_TEXT' }], 'STOP')];
  }
  const label = input.replace(/[^a-z]/gi, '_').toUpperCase();
  return [chunk([{ text: `Reply to ${input}.` }]), chunk([{ text: '', thoughtSignature: `SIG_${label}` }], 'STOP')];
}

/** Stored replies, as the next request's frozen Context carries them (durations are wall-clock timing). */
const storedModelReplies = request => request.context
  .filter(item => item.segmentKind === 'message' && item.messageRole === 'model')
  .map(item => JSON.parse(item.content).parts.map(({ thoughtDurationMs: _duration, ...part }) => part));

async function withRuntime(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-gemini-signatures-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(path.join(directory, 'configuration')));
  let configuration = new VscodeConfigurationAuthority(getPaths);
  const gemini = {
    ...createDefaultLlmProviderConfig({ name: 'Gemini fixture' }), id: 'gemini-fixture', provider: 'gemini',
    baseUrl: 'https://example.invalid/v1beta', model: GEMINI_MODEL, models: [{ id: GEMINI_MODEL, name: 'Gemini' }],
    apiKey: 'offline-placeholder', stream: true, retryOnError: false, retryMaxAttempts: 0
  };
  const claude = {
    ...createDefaultLlmProviderConfig({ name: 'Claude fixture' }), id: 'claude-fixture', provider: 'claude',
    baseUrl: 'https://example.invalid/v1', model: 'claude-opus-5-5', models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }],
    retryOnError: false, retryMaxAttempts: 0
  };
  for (const [section, settings] of [
    ['llmProviderConfigs', { configs: [gemini, claude] }],
    ['llm', { activeProviderConfigId: gemini.id }]
  ]) {
    const current = await configuration.loadGlobalSettings(section);
    await configuration.saveGlobalSettings(section, settings, current.revision);
  }
  await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['lookup'] });
  const agent = await configuration.mutations.createAgent({ name: 'Gemini fixture', kind: 'custom' });
  const folderPath = path.join(directory, 'workspace');
  await fs.mkdir(folderPath);
  const uri = vscode.Uri.file(folderPath).toString();
  await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
  await configuration.mutations.selectConversationWorkEnvironment('source', workEnvironmentIdFromUri(uri));
  const requests = [];
  let current;
  globalThis.fetch = async (url, init) => {
    assert.ok(current, `unexpected fetch ${url}`);
    assert.match(String(url), new RegExp(`models/${GEMINI_MODEL}:streamGenerateContent`));
    current.wire = JSON.parse(init.body);
    const script = geminiScript(current.request);
    return new Response(script.map(item => `data: ${JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  let app;
  let facade;
  let registry;
  const open = async () => {
    configuration = new VscodeConfigurationAuthority(getPaths);
    await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
    registry = new ReliableLlmProviderRegistry({ loadProviderConfig: providerId => configuration.providerConfig(providerId) });
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
      attachmentSettings: configuration,
      providers: { resolve(providerId) {
        return { providerId, async sendFullRequest(request, controls) {
          const entry = { request };
          requests.push(entry);
          if (providerId === gemini.id) {
            // Production path: registry adapter → capability → unified Gemini format → fetch.
            current = entry;
            try {
              await registry.resolve(providerId).sendFullRequest(request, controls);
            } finally {
              current = undefined;
            }
            return;
          }
          // Other providers: the exact wire body from a dry run, then a scripted reply.
          let start;
          const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
            start(input, emit) { start = structuredClone(input); emit({ type: 'llm:done', payload: { requestId: input.id } }); },
            abort() {}, cancelRetry() {}, dispose() {}
          });
          await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, checkpointed: true, terminal: false }; } });
          const settings = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
          entry.wire = (await dryRunLlmProvider(start, { settings: { ...settings, apiKey: '' } })).body;
          await controls.onEvent({ kind: 'completed', streamSeq: '1', content: {
            role: 'model',
            parts: [{ text: '', thought: true, thoughtSignature: 'claude:CLAUDE_SIG' }, { text: `Claude reply to ${inputText(request)}.` }]
          } });
        } };
      } },
      toolDispatcher: {
        definitions() {
          return [{ name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object', properties: { key: { type: 'string' } } } }];
        },
        async dispatch(input) {
          const settled = await app.runtime.effects.settleWithoutEffect({
            source: { kind: 'internal', key: `fixture:${input.toolCallId}` },
            toolCallId: input.toolCallId, status: 'succeeded', detail: { text: `value of ${input.toolCallId}` }
          });
          return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
        }
      }
    });
    facade = Object.create(Facade.prototype);
    facade.product = { application: app, configuration };
    facade.historyEntries = [];
    facade.refreshConversationHistory = async () => {};
  };
  try {
    await open();
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'source', title: 'Source', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'source-agent', conversation_id: 'source', agent_id: agent.id, role: 'default', created_at: now, updated_at: now
      })
    ]);
    const harness = {
      get app() { return app; }, get facade() { return facade; }, requests, gemini, claude,
      async reopen() { registry.dispose(); await app.close(); await open(); },
      async useModel(conversationId, provider) {
        await configuration.mutations.setModelProfile({
          scopeKind: 'conversation', scopeId: conversationId, providerConfigId: provider.id, provider: provider.provider, model: provider.model
        });
      },
      async turn(conversationId, text) {
        await app.database.conversationOwners.retain(conversationId, `fixture-panel:${conversationId}`);
        const input = await app.turns.input({
          source: { kind: 'command', key: `${conversationId}:${text}:${requests.length}` }, conversationId,
          leaseOwnerId: 'gemini-fixture-owner', hostBootId: app.database.hostBootId,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: text
        });
        const [lease] = await rows(app, 'ExecutionLease', { turn_id: input.turnId });
        const result = await kernel.runWithExecutionLeaseFence({
          id: lease.id, conversationId, turnId: input.turnId, ownerId: lease.owner_id,
          hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
        }, () => app.agentLoop.drive(input.turnId)).catch(error => ({ terminalStatus: 'failed', error }));
        assert.equal(result.terminalStatus, 'completed',
          JSON.stringify({ result: String(result.error?.stack ?? result.error ?? ''), termination: await rows(app, 'TurnTermination', { turn_id: input.turnId }) }));
        return input;
      },
      async lastMessage(conversationId, role) {
        const memberships = await rows(app, 'MessagePartOfConversation', { conversation_id: conversationId });
        for (const member of memberships.sort((a, b) => Number(b.message_seq - a.message_seq))) {
          const [link] = await rows(app, 'MessageCurrentRevisionLink', { message_id: member.message_id });
          const [revision] = await rows(app, 'MessageRevision', { id: link.revision_id });
          if (revision.role === role) return { sourceConversationId: conversationId, messageId: member.message_id, expectedRevisionId: revision.id };
        }
        assert.fail('no such message');
      }
    };
    await run(harness);
  } finally {
    registry?.dispose();
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** The parallel call reply: the signature on the first call only, and no thought part carrying it. */
const CALLS_REPLY_STORED = [
  { text: 'Planning two lookups.', thought: true },
  { id: 'call_a', functionCall: { name: 'lookup', args: { key: 'a' } }, thoughtSignature: 'gemini:SIG_CALLS' },
  { id: 'call_b', functionCall: { name: 'lookup', args: { key: 'b' } } }
];
const CALLS_REPLY_WIRE = {
  role: 'model',
  parts: [
    { text: 'Planning two lookups.', thought: true },
    { functionCall: { name: 'lookup', args: { key: 'a' }, id: 'call_a' }, thoughtSignature: 'SIG_CALLS' },
    { functionCall: { name: 'lookup', args: { key: 'b' }, id: 'call_b' } }
  ]
};
/** The streamed text reply: the empty signed part it ended with stays its own, last part. */
const TEXT_REPLY_STORED = [
  { text: 'Both looked up.', thought: true },
  { text: 'Both values found.' },
  { text: '', thoughtSignature: 'gemini:SIG_EMPTY_TAIL' }
];
const TEXT_REPLY_WIRE = {
  role: 'model',
  parts: [{ text: 'Both looked up.', thought: true }, { text: 'Both values found.' }, { text: '', thoughtSignature: 'SIG_EMPTY_TAIL' }]
};
/** A signature on the last non-empty fragment stays on that fragment. */
const SIGNED_FRAGMENT_STORED = [{ text: 'Second' }, { text: ' answer.', thoughtSignature: 'gemini:SIG_LAST_TEXT' }];
const SIGNED_FRAGMENT_WIRE = { role: 'model', parts: [{ text: 'Second' }, { text: ' answer.', thoughtSignature: 'SIG_LAST_TEXT' }] };

const modelContents = wire => wire.contents.filter(content => content.role === 'model');

function assertPrefix(previous, next, label) {
  assert.deepEqual(next.wire.contents.slice(0, previous.wire.contents.length), previous.wire.contents,
    `${label}: the previous request must be an exact prefix`);
}

test('Gemini signatures stay in the part they arrived on through the kernel, restart, fork, a provider switch and compression', { timeout: 180_000 }, async () => {
  await withRuntime(async h => {
    await h.turn('source', 'start-work');
    assert.equal(h.requests.length, 2, 'one call round and one text reply');
    const [callRound, textRound] = h.requests;
    assert.deepEqual(storedModelReplies(textRound.request), [CALLS_REPLY_STORED]);
    assert.deepEqual(modelContents(textRound.wire), [CALLS_REPLY_WIRE]);
    const responses = textRound.wire.contents.at(-1);
    assert.deepEqual(responses.parts.map(part => part.functionResponse?.id), ['call_a', 'call_b'], 'both responses follow the calls');
    assertPrefix(callRound, textRound, 'tool round');

    await h.turn('source', 'second');
    const second = h.requests.at(-1);
    assert.deepEqual(storedModelReplies(second.request), [CALLS_REPLY_STORED, TEXT_REPLY_STORED]);
    assert.deepEqual(modelContents(second.wire), [CALLS_REPLY_WIRE, TEXT_REPLY_WIRE]);

    await h.turn('source', 'third');
    const third = h.requests.at(-1);
    assert.deepEqual(storedModelReplies(third.request).at(-1), SIGNED_FRAGMENT_STORED);
    assert.deepEqual(modelContents(third.wire).at(-1), SIGNED_FRAGMENT_WIRE);
    assertPrefix(second, third, 'next Turn');
    // No thought part anywhere carries a signature: Gemini signed only calls and text parts.
    for (const content of third.wire.contents) {
      for (const part of content.parts) assert.equal(part.thought === true && 'thoughtSignature' in part, false, JSON.stringify(part));
    }

    await h.reopen();
    await h.turn('source', 'after-restart');
    const afterRestart = h.requests.at(-1);
    assertPrefix(third, afterRestart, 'after restart');
    assert.deepEqual(modelContents(afterRestart.wire).at(-1), { role: 'model', parts: [{ text: 'Reply to third.' }, { text: '', thoughtSignature: 'SIG_THIRD' }] });

    const fork = await h.facade.forkConversation({ ...(await h.lastMessage('source', 'model')), command: { commandId: 'fork-gemini-signatures' } });
    await h.turn(fork.conversationId, 'in-fork');
    const inFork = h.requests.at(-1);
    assertPrefix(afterRestart, inFork, 'fork');
    assert.deepEqual(modelContents(inFork.wire).slice(0, 3), [CALLS_REPLY_WIRE, TEXT_REPLY_WIRE, SIGNED_FRAGMENT_WIRE]);

    // Another provider sees the Gemini replies as plain text and calls: no Gemini signature, no empty
    // block and no thinking block made from a Gemini part.
    await h.useModel('source', h.claude);
    await h.turn('source', 'on-claude');
    const onClaude = h.requests.at(-1);
    assert.equal(onClaude.request.providerId, h.claude.id);
    assert.doesNotMatch(JSON.stringify(onClaude.wire), /SIG_|"thinking"|"text":""/);
    assert.deepEqual(onClaude.wire.messages.filter(message => message.role === 'assistant').map(message => message.content.map(block =>
      block.type === 'text' ? `text:${block.text}` : `${block.type}:${block.name}`)), [
      ['tool_use:lookup', 'tool_use:lookup'],
      ['text:Both values found.'],
      ['text:Second', 'text: answer.'],
      ['text:Reply to third.'],
      ['text:Reply to after-restart.']
    ]);

    // Back on Gemini: the Gemini history before the switch is re-sent verbatim, the Claude-signed
    // thought of the Claude reply is dropped and its text follows as an ordinary model part.
    await h.useModel('source', h.gemini);
    await h.turn('source', 'back-on-gemini');
    const back = h.requests.at(-1);
    assertPrefix(afterRestart, back, 'back on Gemini');
    assert.deepEqual(modelContents(back.wire).slice(-2), [
      { role: 'model', parts: [{ text: 'Reply to after-restart.' }, { text: '', thoughtSignature: 'SIG_AFTER_RESTART' }] },
      { role: 'model', parts: [{ text: 'Claude reply to on-claude.' }] }
    ]);

    // Compress everything before the 'second' Turn; the kept tail is re-sent verbatim, signatures in place.
    const rootId = await h.app.context.currentHeadRootId('source');
    const [turn] = (await rows(h.app, 'Turn', { conversation_id: 'source' })).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const [snapshot] = await rows(h.app, 'AuthoritySnapshot', { turn_id: turn.id });
    const keptFrom = back.request.context.findIndex(item => item.segmentKind === 'message' && item.messageRole === 'user'
      && inputText({ context: [item] }) === 'second');
    assert.ok(keptFrom > 0);
    await h.app.compression.create({
      conversationId: 'source', headRootId: rootId, authoritySnapshotId: snapshot.id,
      compressSegmentCount: keptFrom, title: 'Gemini summary', summary: 'Synthetic summary of the lookups',
      idempotencyKey: 'gemini-signature-compression'
    });
    await h.turn('source', 'after-compression');
    const afterCompression = h.requests.at(-1);
    const compressedWire = JSON.stringify(afterCompression.wire.contents);
    assert.match(compressedWire, /Synthetic summary of the lookups/);
    assert.doesNotMatch(compressedWire, /SIG_CALLS|SIG_EMPTY_TAIL/, 'the compressed replies went with the summary');
    const secondAt = afterCompression.wire.contents.findIndex(content => content.role === 'user' && JSON.stringify(content) === JSON.stringify({ role: 'user', parts: [{ text: 'second' }] }));
    const backSecondAt = back.wire.contents.findIndex(content => content.role === 'user' && JSON.stringify(content) === JSON.stringify({ role: 'user', parts: [{ text: 'second' }] }));
    assert.ok(secondAt > 0 && backSecondAt > 0);
    assert.deepEqual(afterCompression.wire.contents.slice(secondAt, secondAt + back.wire.contents.length - backSecondAt),
      back.wire.contents.slice(backSecondAt), 'the kept tail is verbatim');
    assert.deepEqual(modelContents(afterCompression.wire)[0], SIGNED_FRAGMENT_WIRE);
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
    async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? FileType.Directory : FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }; }
  } } };
}
