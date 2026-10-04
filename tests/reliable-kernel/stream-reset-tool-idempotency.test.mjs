import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const kernel = await import(pathToFileURL(path.join(
  root,
  'dist/extension/backend/reliableKernel/index.js'
)).href);
const { emptyConversationContextHandleStateStep } = await import(pathToFileURL(path.join(
  root,
  'dist/extension/backend/reliableKernel/conversationContextHandleState.js'
)).href);

test('StreamReset after a committed tool result never repeats the tool effect or loses its model result', {
  timeout: 60_000
}, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-stream-reset-idempotency-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let app;
  let toolDispatches = 0;
  let mode = 'fail-after-tool';
  let failedRoundRequests = 0;
  let resumedRequest;
  const provider = {
    providerId: 'stream-reset-provider',
    async sendFullRequest(request, controls) {
      if (mode === 'resume') {
        resumedRequest = request;
        await controls.onEvent({
          kind: 'completed',
          streamSeq: '1',
          content: { role: 'model', parts: [{ text: 'resumed safely' }] }
        });
        return;
      }
      if (request.recipe.round === '1') {
        await controls.onEvent({
          kind: 'completed',
          streamSeq: '1',
          content: {
            role: 'model',
            parts: [{
              id: `counter-${request.modelRequestId}`,
              functionCall: { name: 'counter', args: { value: 1 } }
            }]
          }
        });
        return;
      }
      failedRoundRequests += 1;
      throw Object.assign(new Error('StreamReset stream_id:1, error_code:2, remote_reset:True'), {
        code: 'STREAM_RESET'
      });
    }
  };
  try {
    app = await kernel.ReliableKernelApplication.open(authority, dependencies(provider, {
      definitions() {
        return [{
          name: 'counter',
          description: 'Increment one observable counter',
          parameters: {
            type: 'object',
            properties: { value: { type: 'integer' } },
            required: ['value']
          },
          metadata: { readonly: false }
        }];
      },
      async dispatch(input) {
        toolDispatches += 1;
        const settled = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `stream-reset-counter:${input.toolCallId}` },
          toolCallId: input.toolCallId,
          status: 'succeeded',
          detail: { count: toolDispatches }
        });
        return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
      }
    }));
    const conversationId = 'stream-reset-idempotency';
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId,
        title: 'Stream reset idempotency',
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      emptyConversationContextHandleStateStep(conversationId, now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${conversationId}-agent`,
        conversation_id: conversationId,
        agent_id: 'agent-main',
        role: 'default',
        created_at: now,
        updated_at: now
      })
    ]);

    const failed = await app.agentLoop.runInput(turnInput(conversationId, 'first'));
    assert.equal(failed.terminalStatus, 'failed');
    assert.ok(failedRoundRequests >= 1);
    assert.equal(toolDispatches, 1);
    assert.equal((await list(app, 'ToolCall')).length, 1);
    assert.equal((await list(app, 'ToolOutcome')).length, 1);
    assert.equal((await list(app, 'ToolModelResult')).length, 1);

    mode = 'resume';
    const resumed = await app.agentLoop.runInput(turnInput(conversationId, 'resume'));
    assert.equal(resumed.terminalStatus, 'completed');
    assert.equal(toolDispatches, 1, 'a new provider request must not replay the committed tool effect');
    assert.equal((await list(app, 'ToolCall')).length, 1);
    assert.equal((await list(app, 'ToolOutcome')).length, 1);
    assert.equal((await list(app, 'ToolModelResult')).length, 1);
    assert.match(JSON.stringify(resumedRequest.context), /count/);
  } finally {
    if (app) await app.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('同名 GPT 跨渠道隔离签名，切回原渠道保留签名，断流重试不重做工具', {
  timeout: 60_000
}, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-gpt-channel-signatures-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let app;
  let activeChannel = 'gpt-source-channel';
  let toolIssued = false;
  let sourceCompleted = false;
  let interruptions = 0;
  let toolDispatches = 0;
  const fullRequests = [];
  const wireRequests = [];
  const provider = {
    get providerId() { return activeChannel; },
    async sendFullRequest(fullRequest, controls) {
      fullRequests.push(fullRequest);
      const channel = fullRequest.providerId;
      const adapter = new kernel.LlmCapabilityFullRequestAdapter(channel, {
        start(llmRequest, emit) {
          wireRequests.push({ channel, request: structuredClone(llmRequest) });
          const source = channel === 'gpt-source-channel';
          const foreignSignature = source ? 'openai-responses:target-private' : 'openai-responses:source-private';
          if (JSON.stringify(llmRequest.contents).includes(foreignSignature)) {
            emit({ type: 'llm:error', payload: { requestId: llmRequest.id, message: 'The encrypted content could not be verified.' } });
            return;
          }
          if (source && toolIssued && !sourceCompleted && interruptions < 2) {
            interruptions += 1;
            emit({ type: 'llm:thoughtDelta', payload: { requestId: llmRequest.id, text: 'discard interrupted thought' } });
            emit({ type: 'llm:error', payload: {
              requestId: llmRequest.id,
              message: 'Streaming error: peer closed connection without sending complete message body (incomplete chunked read)'
            } });
            return;
          }
          const parts = [{
            text: source ? 'source reasoning summary' : 'target reasoning summary',
            thought: true,
            thoughtSignature: source ? 'openai-responses:source-private' : 'openai-responses:target-private'
          }];
          if (!toolIssued) {
            toolIssued = true;
            parts.push({ id: 'cross-channel-counter', functionCall: { name: 'counter', args: { value: 1 } } });
          } else {
            if (source) sourceCompleted = true;
            parts.push({ text: 'completed without repeating the counter' });
          }
          emit({ type: 'llm:done', payload: { requestId: llmRequest.id, content: { role: 'model', parts } } });
        },
        abort() {}, resolveInvocation() {}, compact() {},
        dryRun() { throw new Error('unused'); },
        dryRunCompact() { throw new Error('unused'); },
        listModels() { return Promise.resolve([]); },
        cancelRetry() {}, dispose() {}
      });
      return adapter.sendFullRequest(fullRequest, controls);
    }
  };
  try {
    app = await kernel.ReliableKernelApplication.open(authority, dependencies(provider, {
      definitions() {
        return [{ name: 'counter', description: 'count once', parameters: { type: 'object' }, metadata: { readonly: false } }];
      },
      async dispatch(input) {
        toolDispatches += 1;
        const settled = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: 'gpt-counter:' + input.toolCallId },
          toolCallId: input.toolCallId, status: 'succeeded', detail: { count: toolDispatches }
        });
        return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
      }
    }, { provider: 'openai-responses', modelId: 'gpt-6-astra' }));
    const conversationId = 'gpt-channel-signatures';
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now
      }),
      emptyConversationContextHandleStateStep(conversationId, now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: conversationId + '-agent', conversation_id: conversationId, agent_id: 'agent-main',
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    assert.equal((await app.agentLoop.runInput(turnInput(conversationId, 'source'))).terminalStatus, 'completed');
    assert.equal(interruptions, 2);
    assert.equal(toolDispatches, 1);
    const sourceMessage = fullRequests[1].context.find((item) => item.messageRole === 'model');
    assert.deepEqual(sourceMessage.modelSource, { providerId: 'gpt-source-channel', modelId: 'gpt-6-astra' });
    for (const capture of wireRequests.slice(1)) {
      assert.match(JSON.stringify(capture.request.contents), /openai-responses:source-private/);
    }
    activeChannel = 'gpt-target-channel';
    assert.equal((await app.agentLoop.runInput(turnInput(conversationId, 'target'))).terminalStatus, 'completed');
    const targetRequest = wireRequests.find((capture) => capture.channel === activeChannel).request;
    assert.doesNotMatch(JSON.stringify(targetRequest.contents), /openai-responses:source-private/);
    assert.match(JSON.stringify(targetRequest.contents), /source reasoning summary/);
    assert.ok(targetRequest.contents.some((content) => content.parts.some((part) => part.functionResponse?.name === 'counter')));
    activeChannel = 'gpt-source-channel';
    assert.equal((await app.agentLoop.runInput(turnInput(conversationId, 'return'))).terminalStatus, 'completed');
    assert.match(JSON.stringify(wireRequests.at(-1).request.contents), /openai-responses:source-private/);
    assert.doesNotMatch(JSON.stringify(wireRequests.at(-1).request.contents), /openai-responses:target-private/);
    assert.equal(fullRequests.at(-1).context.find((item) => item.segmentId === sourceMessage.segmentId).content, sourceMessage.content);
    assert.equal(toolDispatches, 1);
    assert.equal((await list(app, 'ToolCall')).length, 1);
    assert.equal((await list(app, 'ToolOutcome')).length, 1);
    assert.equal((await list(app, 'ToolModelResult')).length, 1);
  } finally {
    if (app) await app.close();
    const target = path.resolve(parent);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('limcode-gpt-channel-signatures-'));
    await fs.rm(target, { recursive: true, force: true });
  }
});

function turnInput(conversationId, suffix) {
  return {
    source: { kind: 'command', key: `stream-reset-input:${suffix}` },
    conversationId,
    leaseOwnerId: 'stream-reset-test',
    hostBootId: `stream-reset-host-${suffix}`,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    content: suffix === 'first' ? 'Run the counter tool.' : 'Continue without rerunning completed tools.'
  };
}

async function list(app, domain) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    orderBy: { column: 'id', direction: 'asc' },
    limit: 100
  }))).snapshot;
}

function dependencies(provider, toolDispatcher, model = { provider: 'openai-compatible', modelId: 'stream-reset-model' }) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: provider.providerId, modelId: model.modelId })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: provider.providerId,
                provider: model.provider,
                modelId: model.modelId,
                retryPolicy: { enabled: true, maxRetries: 2 }
              },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'stream-reset-tools',
                allowedTools: ['counter'],
                preset: 'custom',
                toolConfigs: {},
                sourceConfigs: {}
              },
              systemPrompt: { id: 'stream-reset-prompt', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: {
                id: null,
                enabled: false,
                allowedWorkEnvironmentIds: [],
                defaultWorkEnvironmentId: null
              }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      async callTool() { return null; }
    },
    mcpPolicyGate: {
      async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
    },
    attachmentSettings: {
      async loadGlobalSettings() {
        return {
          section: 'attachments',
          settings: { maxStoredInlineFileMb: 25 },
          filePath: 'settings/attachments.json'
        };
      }
    },
    providers: {
      resolve(providerId) {
        if (providerId !== provider.providerId) throw new Error(`Unexpected provider: ${providerId}`);
        return provider;
      }
    },
    toolDispatcher
  };
}
