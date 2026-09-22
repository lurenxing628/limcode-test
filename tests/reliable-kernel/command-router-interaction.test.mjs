import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';

const root = process.cwd();
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return { window: { async showWarningMessage() {} } };
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const protocol = require(path.join(root, 'dist/extension/shared/protocol.js'));
const { VscodeReliableKernelCommandRouter } = require(path.join(
  root,
  'dist/extension/backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js'
));
const { ConversationForkRejectedError } = require(path.join(
  root,
  'dist/extension/backend/reliableKernel/conversationFork.js'
));
const {
  INTERACTION_ATTENTION_ACTION,
  InteractionAttentionNotifier,
  runtimeCommitNeedsInteractionAttention
} = require(path.join(
  root,
  'dist/extension/backend/application/reliableKernel/interactionAttention.js'
));

test('model profile commit broadcasts only its local scope, never a full configuration snapshot', async () => {
  const posted = [], broadcasts = [];
  let fullReads = 0;
  const result = { scopeKind: 'conversation', scopeId: 'thinking-conversation', authorityId: 'authority', revision: 'revision-2', sequence: 2, profileState: 'overridden', outcome: 'committed' };
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {}, definitionRecords() { return []; }, mcp: { sourceRecords() { return []; } }, skillDefinitions() { return []; }, ruleFiles() { return []; } },
    application: { database: { conversationOwners: passthroughConversationOwners() } },
    configuration: {
      async configurationClientState() { fullReads++; return {}; },
      async providerConfig() {},
      mutations: {
        captureModelProfileRoot() { return { authorityId: 'authority' }; },
        async readModelProfileScope() { return { ...result, outcome: 'observed', sequence: 1 }; },
        async writeModelProfileScope() { return result; }
      }
    }
  }, { broadcast: message => broadcasts.push(message) });
  const view = webview(posted);
  router.handle('scope-client', view, { id: 'read', type: protocol.BridgeMessageType.ModelProfileScopeRead,
    payload: { scopeKind: 'conversation', scopeId: result.scopeId } });
  await eventually(() => posted.length === 1);
  router.handle('scope-client', view, { id: 'thinking', type: protocol.BridgeMessageType.ModelProfileScopeSet,
    payload: { scopeKind: 'conversation', scopeId: result.scopeId, authorityId: 'authority', sessionId: posted[0].payload.sessionId,
      expectedRevision: 'revision-1', operation: 'thinking', providerConfigId: 'p', model: 'o3', thinkingOverride: { kind: 'openai-effort', value: 'high' } } });
  await eventually(() => posted.length === 2 && broadcasts.length === 1);
  assert.equal(fullReads, 0);
  assert.equal(broadcasts[0].type, protocol.BridgeMessageType.ModelProfileScopeSnapshot);
  assert.equal(broadcasts[0].payload.scopeId, result.scopeId);
  assert.equal(broadcasts[0].correlationId, undefined);
  assert.equal(broadcasts[0].payload.sessionId, undefined, 'peer panels cannot reuse the writer session token');
});

test('stale Turn interrupt is idempotently reported as already_terminal', async () => {
  const posted = [];
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    application: { database: { conversationOwners: passthroughConversationOwners() } }
  });
  router.maybeRow = async (domain, id) => {
    assert.equal(domain, 'Turn');
    assert.equal(id, 'turn-deleted');
    return undefined;
  };

  await router.dispatch('stale-turn-client', webview(posted), {
    id: 'interrupt-stale-turn',
    type: protocol.BridgeMessageType.TurnInterrupt,
    channel: 'command',
    payload: {
      conversationId: 'conversation-deleted',
      command: { commandId: 'interrupt-stale-turn' },
      turnId: 'turn-deleted',
      leaseEpoch: 0,
      cascadeChildAgents: true
    }
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, protocol.BridgeMessageType.TurnInterruptResult);
  assert.equal(posted[0].payload.status, 'already_terminal');
  assert.equal(posted[0].payload.cascadeChildAgents, true);
});

test('新输入等待其他设置页面保存确认，而已经提交的输入重放不被新设置阻挡', async () => {
  const posted = [];
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {} }
  });
  const flushes = [];
  router.settingsSaveBarrier.attach('settings-page', {
    async postMessage(message) { flushes.push(message); return true; }
  });
  let replay = false;
  router.list = async (domain) => {
    assert.equal(domain, 'CommandReceipt');
    return replay ? [{ id: 'existing-receipt' }] : [];
  };
  let admissions = 0;
  router.handleTurnInput = async () => { admissions += 1; };
  const input = {
    id: 'input-await-save', type: protocol.BridgeMessageType.TurnStart,
    payload: { conversationId: 'conversation', text: '输入', command: { commandId: 'input-command' } }
  };
  const pending = router.dispatch('chat-page', webview(posted), input);
  await eventually(() => flushes.length === 1);
  assert.equal(admissions, 0);
  await router.dispatch('settings-page', webview(posted), {
    id: 'flush-result', type: protocol.BridgeMessageType.GlobalSettingsFlushResult,
    correlationId: flushes[0].id, payload: { status: 'saved' }
  });
  await pending;
  assert.equal(admissions, 1);
  replay = true;
  await router.dispatch('chat-page', webview(posted), input);
  assert.equal(admissions, 2);
  assert.equal(flushes.length, 1);
});

test('已经开始的手动压缩查询结果不重新等待设置页面', async () => {
  const posted = [];
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {} },
    application: { database: { conversationOwners: passthroughConversationOwners() } },
    conversations: { async inspectManualCompression() { return { turnId: 'maintenance', inProgress: true }; } }
  });
  router.requireRow = async () => ({ id: 'conversation' });
  router.settingsSaveBarrier.attach('settings-page', {
    async postMessage() { assert.fail('重放不得等待新设置'); }
  });
  await router.dispatch('chat', webview(posted), {
    id: 'manual-query', type: protocol.BridgeMessageType.CompressionStart,
    payload: { conversationId: 'conversation', command: { commandId: 'manual' }, target: { kind: 'current_head', expectedRootId: 'root' } }
  });
  assert.equal(posted[0].payload.status, 'in_progress');
});

test('stale Conversation settings request returns scoped error without throwing', async () => {
  const posted = [];
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} }
  });
  router.readConversationSettings = async () => undefined;

  await router.dispatch('stale-conversation-client', webview(posted), {
    id: 'get-stale-conversation-settings',
    type: protocol.BridgeMessageType.ConversationSettingsGet,
    channel: 'command',
    payload: { conversationId: 'conversation-deleted', section: 'common' }
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, protocol.BridgeMessageType.Error);
  assert.equal(posted[0].payload.code, 'stale_conversation');
  assert.equal(posted[0].payload.conversationId, 'conversation-deleted');
});

test('failed global settings read preserves section scope for Webview loading state', async () => {
  const posted = [];
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    configuration: {
      async loadGlobalSettings(section) {
        assert.equal(section, 'llmCompressionConfigs');
        throw new TypeError('Compression trigger uses removed fields.');
      }
    }
  });

  router.handle('settings-client', webview(posted), {
    id: 'get-invalid-compression-settings',
    type: protocol.BridgeMessageType.GlobalSettingsGet,
    channel: 'command',
    payload: { section: 'llmCompressionConfigs' }
  });

  await eventually(() => posted.length === 1);
  assert.equal(posted[0].type, protocol.BridgeMessageType.Error);
  assert.deepEqual(posted[0].scope, {
    kind: 'settings',
    level: 'global',
    id: 'llmCompressionConfigs'
  });
  assert.equal(posted[0].payload.requestType, protocol.BridgeMessageType.GlobalSettingsGet);
});


test('fork errors mark permanent rejections so the Webview drops instead of replaying them', async () => {
  const fork = {
    sourceConversationId: 'fork-source', messageId: 'fork-message', expectedRevisionId: 'fork-revision',
    command: { commandId: 'fork-command', expectedVersion: 0, issuedAt: 1 }
  };
  for (const [failure, code] of [
    [new ConversationForkRejectedError('分支点所在回合仍在运行。'), 'fork_rejected'],
    [new Error('history refresh failed after commit'), undefined]
  ]) {
    const posted = [];
    const router = new VscodeReliableKernelCommandRouter({
      debugCapture: { setListener() {} },
      toolHost: { setStateChangeListener() {} }
    }, { async forkConversation() { throw failure; } });
    router.handle('fork-client', webview(posted), {
      id: `fork-request-${code ?? 'failed'}`,
      type: protocol.BridgeMessageType.ConversationFork,
      channel: 'command',
      payload: fork
    });
    await eventually(() => posted.length === 1);
    assert.equal(posted[0].type, protocol.BridgeMessageType.Error);
    assert.equal(posted[0].correlationId, `fork-request-${code ?? 'failed'}`);
    assert.equal(posted[0].payload.requestType, protocol.BridgeMessageType.ConversationFork);
    assert.equal(posted[0].payload.message, failure.message);
    assert.equal(posted[0].payload.code, code);
  }
});

test('durable Interaction result is posted before a stalled Agent resume completes', async () => {
  const posted = [];
  const resume = deferred();
  const resumedConversations = [];
  const product = {
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    application: {
      database: { conversationOwners: passthroughConversationOwners() },
      interactions: {
        async resolvePlanReview(input) {
          assert.equal(input.source.key, 'interaction:interaction-request:accept:fixed-interaction-command');
          return { won: true };
        }
      }
    },
    childAgents: {
      async resume(turnId) {
        assert.equal(turnId, 'owner-turn');
        return resume.promise;
      }
    },
    conversations: {
      resume(conversationId, turnId) {
        resumedConversations.push({ conversationId, turnId });
      }
    }
  };
  const router = new VscodeReliableKernelCommandRouter(product);
  router.requireRow = async (domain, id) => {
    assert.equal(domain, 'InteractionRequest');
    assert.equal(id, 'interaction-request');
    return { id, request_kind: 'plan_review', status: 'pending' };
  };
  router.list = async (domain, where, limit) => {
    assert.deepEqual(where, { request_id: 'interaction-request' });
    assert.equal(limit, 2);
    if (domain === 'InteractionOwnerLink') return [{ request_id: 'interaction-request', turn_id: 'owner-turn' }];
    if (domain === 'InteractionToolCallLink') return [{ request_id: 'interaction-request', tool_call_id: 'plan-tool' }];
    throw new Error(`Unexpected list domain ${domain}`);
  };

  await router.dispatch('interaction-client', webview(posted), {
    id: 'fixed-interaction-command',
    type: protocol.BridgeMessageType.InteractionResolve,
    channel: 'command',
    payload: {
      conversationId: 'conversation-one',
      interactionRequestId: 'interaction-request',
      interactionRevision: 1,
      ownerTurnId: 'owner-turn',
      decision: 'accept',
      response: { planProposalId: 'plan-proposal', executionTarget: 'current_conversation' }
    }
  });

  assert.equal(posted.length, 1, 'the direct durable receipt must not await resume');
  assert.equal(posted[0].type, protocol.BridgeMessageType.InteractionResult);
  assert.equal(posted[0].correlationId, 'fixed-interaction-command');
  assert.deepEqual(posted[0].payload, {
    requestType: 'plan_review',
    conversationId: 'conversation-one',
    targetId: 'interaction-request',
    status: 'committed'
  });
  assert.deepEqual(resumedConversations, []);

  resume.resolve(false);
  await eventually(() => resumedConversations.length === 1);
  assert.deepEqual(resumedConversations, [{ conversationId: 'conversation-one', turnId: 'owner-turn' }]);
});

test('pending ASK and Plan interactions notify once and open the selected conversation', async () => {
  const notifications = [];
  const opened = [];
  const notifier = new InteractionAttentionNotifier({
    showInformationMessage(message, action) {
      notifications.push({ message, action });
      return Promise.resolve(message.includes('问题等待回答') ? action : undefined);
    },
    openConversation(request) {
      opened.push(request);
      return Promise.resolve();
    }
  });
  const pending = [
    attention('ask-one', 'ask_user', 'conversation-ask', 'ASK 对话', 1),
    attention('ask-two', 'ask_user', 'conversation-ask', 'ASK 对话', 2),
    attention('plan-one', 'plan_review', 'conversation-plan', 'Plan 对话', 3)
  ];

  notifier.synchronize(pending);
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((entry) => entry.action), [
    INTERACTION_ATTENTION_ACTION,
    INTERACTION_ATTENTION_ACTION
  ]);
  assert.match(notifications[0].message, /2 个问题等待回答/);
  assert.match(notifications[1].message, /Plan 等待审批/);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(opened, [{
    conversationId: 'conversation-ask',
    conversationTitle: 'ASK 对话'
  }]);

  notifier.synchronize(pending);
  assert.equal(notifications.length, 2, 'repeated pending facts must not show duplicate notifications');
});

test('a replacement ASK request starts a new notification episode', () => {
  const notifications = [];
  const notifier = new InteractionAttentionNotifier({
    showInformationMessage(message) {
      notifications.push(message);
      return Promise.resolve(undefined);
    },
    openConversation() {
      return Promise.resolve();
    }
  });

  notifier.synchronize([attention('ask-first', 'ask_user', 'conversation-one', '同一对话', 1)]);
  notifier.synchronize([attention('ask-second', 'ask_user', 'conversation-one', '同一对话', 2)]);
  notifier.synchronize([attention('ask-second', 'ask_user', 'conversation-one', '同一对话', 2)]);

  assert.equal(notifications.length, 2);
});

test('Interaction commit domains trigger an attention refresh', () => {
  for (const domain of ['InteractionRequest', 'InteractionOwnerLink', 'InteractionToolCallLink']) {
    assert.equal(runtimeCommitNeedsInteractionAttention({
      changes: [{ domain, kind: 'upsert', id: domain }]
    }), true);
  }
  assert.equal(runtimeCommitNeedsInteractionAttention({
    changes: [{ domain: 'ToolCall', kind: 'upsert', id: 'tool-call' }]
  }), false);
});

function attention(requestId, kind, conversationId, conversationTitle, createdAt) {
  return { requestId, kind, conversationId, conversationTitle, createdAt };
}

function webview(posted) {
  return {
    async postMessage(message) {
      posted.push(message);
      return true;
    }
  };
}

/** The mandatory RuntimeDatabase owner manager reduced to its command-run contract. */
function passthroughConversationOwners() {
  return {
    async run(conversationId, operation) {
      return operation();
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Interaction resume');
}
