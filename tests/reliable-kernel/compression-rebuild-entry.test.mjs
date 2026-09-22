import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { ReliableConversationRunner } = require(path.join(compiledRoot,
  'backend/application/reliableKernel/ReliableConversationRunner.js'));
const protocol = require(path.join(compiledRoot, 'shared/protocol.js'));
const Module = require('node:module');
const originalLoad = Module._load;
let VscodeReliableKernelCommandRouter;
try {
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? {} : originalLoad.call(this, request, parent, isMain);
  };
  ({ VscodeReliableKernelCommandRouter } = require(path.join(compiledRoot,
    'backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js')));
} finally { Module._load = originalLoad; }

const fullTarget = { kind: 'current_head', expectedRootId: 'root-current' };

function routerFixture({ child = false, active = false, replay = null } = {}) {
  const forwarded = [], inspected = [], posted = [], ownership = [];
  const accept = async (input) => {
    forwarded.push(input);
    return { turnId: 'maintenance', compression: { status: 'compressed',
      modelRequestId: 'request', result: { compressionBlockId: 'block' } } };
  };
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {} },
    async ensureCapabilitiesReady() {},
    application: {
      database: { conversationOwners: { async run(id, operation) { ownership.push(id); return operation(); } } },
      context: { async materializeStructure() { return { records: [
        { segment: { id: 'segment-1' } }, { segment: { id: 'segment-2' } }
      ] }; } }
    },
    conversations: { async inspectManualCompression(input) { inspected.push(input); return replay; }, manualCompression: accept },
    childAgents: { manualCompressionFromConversation: accept }
  });
  router.requireRow = async (domain, id) => ({ id, ...(domain === 'ContextSequenceRoot' ? { conversation_id: 'conversation' } : {}) });
  router.childExecutionIdForConversation = async () => child ? 'child-execution' : undefined;
  router.list = async (domain) => {
    if (domain === 'Turn') return active ? [{ id: 'active-turn' }] : [];
    if (domain === 'ConversationContextHeadLink') return [{ root_id: 'root-current' }];
    throw new Error(`Unexpected domain ${domain}`);
  };
  const run = (patch = {}) => router.dispatch('panel', { async postMessage(message) { posted.push(message); return true; } }, {
    id: 'rebuild-ui', type: protocol.BridgeMessageType.CompressionStart,
    payload: { conversationId: 'conversation', command: { commandId: 'rebuild-command' },
      target: fullTarget, sourceReplay: 'immutable_provenance', ...patch }
  });
  return { run, forwarded, inspected, posted, ownership };
}

for (const child of [false, true]) {
  test(`原始记录重建通过现有${child ? '子执行器' : '普通对话'}压缩命令传递完整范围和来源方式`, async () => {
    const fixture = routerFixture({ child });
    await fixture.run();
    assert.deepEqual(fixture.ownership, ['conversation']);
    assert.equal(fixture.inspected[0].sourceReplay, 'immutable_provenance');
    assert.equal(fixture.forwarded.length, 1);
    assert.equal(fixture.forwarded[0].compressSegmentCount, 2);
    assert.deepEqual(fixture.forwarded[0].target, fullTarget);
    assert.equal(fixture.forwarded[0].sourceReplay, 'immutable_provenance');
    assert.equal(fixture.forwarded[0].childExecutionId, child ? 'child-execution' : undefined);
    assert.equal(fixture.posted[0].payload.status, 'accepted');
  });
}

test('重建拒绝错误来源方式、消息前缀和已经变化的根，普通压缩保持原行为', async () => {
  for (const patch of [
    { sourceReplay: 'guess_old_aliases' },
    { target: { kind: 'through_message', messageId: 'message', expectedRevisionId: 'revision' } },
    { target: { kind: 'current_head', expectedRootId: 'root-previous' } }
  ]) {
    const fixture = routerFixture();
    await assert.rejects(fixture.run(patch), /sourceReplay|当前完整上下文|当前上下文已变化/);
    assert.equal(fixture.forwarded.length, 0);
  }
  const ordinary = routerFixture();
  await ordinary.run({ sourceReplay: undefined });
  assert.equal(ordinary.forwarded[0].sourceReplay, undefined);
});

test('重建复用busy和已存在命令查询，不重复派发', async () => {
  const busy = routerFixture({ active: true });
  await busy.run();
  assert.equal(busy.posted[0].payload.status, 'busy');
  assert.equal(busy.forwarded.length, 0);
  const replay = routerFixture({ replay: { turnId: 'maintenance', deduplicated: true, inProgress: true } });
  await replay.run({ target: { kind: 'current_head', expectedRootId: 'root-before-completion' } });
  assert.equal(replay.posted[0].payload.status, 'in_progress');
  assert.equal(replay.inspected[0].sourceReplay, 'immutable_provenance');
  assert.equal(replay.forwarded.length, 0);
});

function dependencies() {
  return {
    authorityCompiler: { async compile(request) { return {
      turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: 'provider', modelId: 'model' }) },
      authoritySnapshot: { content: JSON.stringify({
        kind: 'effective-turn-authority', turnId: request.turnId, executorAgentId: request.executorAgentId,
        modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000,
          tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
        model: { providerConfigId: 'provider', modelId: 'model' },
        policies: { toolPolicyId: 'tools', systemPromptId: 'prompt' }
      }) }
    }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments',
      settings: { maxStoredInlineFileMb: 25 }, filePath: 'attachments.json' }; } },
    providers: { resolve() { throw new Error('Admission test must not call a provider.'); } },
    toolDispatcher: { definitions() { return []; }, async dispatch() { throw new Error('Unexpected tool.'); } }
  };
}

test('重建方式持久保存到维护Turn，重启回放保留身份且拒绝同command切换方式', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-rebuild-entry-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  let app, runner;
  try {
    await kernel.initializeEmptyRuntimeRoot(authority);
    app = await kernel.ReliableKernelApplication.open(authority, dependencies());
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'conversation', title: 'fixture', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'agent-link', conversation_id: 'conversation', agent_id: 'agent', role: 'default', created_at: now, updated_at: now })
    ]);
    const history = await app.turns.input({ source: { kind: 'command', key: 'history' }, conversationId: 'conversation',
      leaseOwnerId: 'owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(),
      content: '不可变原始记录' });
    await app.turns.terminal({ source: { kind: 'internal', key: 'history-terminal' }, turnId: history.turnId,
      terminalStatus: 'completed', reason: 'fixture' });
    const [head] = (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
      where: { conversation_id: 'conversation' }, orderBy: { column: 'id', direction: 'asc' }, limit: 10
    }))).snapshot;
    const input = { commandId: 'persisted-rebuild', conversationId: 'conversation', compressSegmentCount: 1,
      target: { kind: 'current_head', expectedRootId: head.root_id }, sourceReplay: 'immutable_provenance' };
    runner = new ReliableConversationRunner(app, 'owner');
    await assert.rejects(runner.admitManualCompression({ ...input, compressSegmentCount: 2 }), /完整上下文/);
    await assert.rejects(runner.admitManualCompression({ ...input, sourceReplay: 'unknown' }), /sourceReplay/);
    const admitted = await runner.admitManualCompression(input);
    assert.equal(admitted.admitted, true);
    const descriptor = await runner.readRuntimeMaintenanceDescriptor({ conversationId: input.conversationId, turnId: admitted.turnId });
    assert.equal(descriptor.sourceReplay, 'immutable_provenance', 'writer normalization must retain the selection');
    assert.deepEqual(descriptor.target, input.target);
    await assert.rejects(runner.inspectManualCompression({ ...input, sourceReplay: undefined }), /不同的冻结目标或原始记录重建方式/);
    const drive = await runner.readManualCompressionDrive({ conversationId: input.conversationId, turnId: admitted.turnId });
    assert.equal(drive.descriptor.sourceReplay, 'immutable_provenance');
    assert.equal(drive.compressSegmentCount, 1);

    // The underlying writer identity also distinguishes modes before the runner inspection layer.
    await assert.rejects(app.turns.runtimeContinuation({ source: { kind: 'internal', key: descriptor.commandSourceKey },
      conversationId: input.conversationId, sourceTurnId: history.turnId,
      leaseOwnerId: 'owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(),
      maintenance: { ...descriptor, sourceReplay: undefined }
    }), /CommandReceipt.*does not contain retry result facts/);
    runner.dispose(); runner = undefined;
    await app.close(); app = undefined;
    app = await kernel.ReliableKernelApplication.open(authority, dependencies());
    runner = new ReliableConversationRunner(app, 'owner-after-restart');
    const replay = await runner.inspectManualCompression(input);
    assert.equal(replay.turnId, admitted.turnId);
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.inProgress, true);
    await assert.rejects(runner.inspectManualCompression({ ...input, sourceReplay: undefined }), /原始记录重建方式/);
  } finally {
    runner?.dispose();
    if (app) await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});
