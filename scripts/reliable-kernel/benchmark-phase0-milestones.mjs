import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(import.meta.url);
const compiledRootInput = option('compiled-root') ?? process.env.LIMCODE_COMPILED_ROOT;
const compiledRoot = compiledRootInput
  ? path.resolve(root, compiledRootInput)
  : path.join(root, 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { emptyConversationContextHandleStateStep } = require(path.join(compiledRoot, 'backend/reliableKernel/conversationContextHandleState.js'));
const { RuntimePerformanceMetricCollector } = require(path.join(
  compiledRoot,
  'backend/reliableKernel/runtimePerformanceMetrics.js'
));
const { MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT } = require(path.join(
  compiledRoot,
  'backend/reliableKernel/databaseWorkerProtocol.js'
));
const {
  createLlmStreamEventBatcher,
  LLM_STREAM_EVENT_AGGREGATION_INTERVAL_MS
} = require(path.join(compiledRoot, 'backend/capabilities/llmStreamEventBatcher.js'));
const { LlmEventType } = require(path.join(compiledRoot, 'backend/world/modules/llm/events.js'));

const samples = positiveInteger(option('samples') ?? '3', 'samples');
const mode = option('mode') ?? 'all';
const outputPath = option('output');
if (!['all', 'provider', 'process', 'feed'].includes(mode)) {
  throw new TypeError('mode must be all, provider, process, or feed.');
}

const result = {
  kind: 'limcode-phase0-milestone-benchmark',
  samples,
  existingAggregation: inspectExistingLlmAggregation(),
  checkpointCapacity: MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT
};

if (mode === 'all' || mode === 'provider') {
  result.provider = await benchmarkProviderEvents(samples);
  result.providerCapacityBoundary = await benchmarkOutputItemDoneAtCapacity(samples);
}
if (mode === 'all' || mode === 'process') result.process = await benchmarkShortProcesses(samples);
if (mode === 'all' || mode === 'feed') result.clientFeed = await benchmarkClientFeed(samples);

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) await fs.writeFile(path.resolve(root, outputPath), serialized, 'utf8');
process.stdout.write(serialized);

async function benchmarkProviderEvents(sampleCount) {
  const output = [];
  for (const eventCount of [1, 10, 33, 100]) {
    const measurements = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      measurements.push(await withApp(`phase0-provider-${eventCount}-${sample}`, async (app, scope) => {
        const request = await createRequest(app, scope, `events-${eventCount}-${sample}`);
        const collector = new RuntimePerformanceMetricCollector();
        const detach = app.database.attachPerformanceMetrics(collector);
        const eventResults = [];
        const startedAt = performance.now();
        try {
          await app.modelProvider.dispatch(request.modelRequestId, {
            providerId: 'phase0-provider',
            async sendFullRequest(_fullRequest, controls) {
              for (let index = 1; index <= eventCount; index += 1) {
                eventResults.push(await controls.onEvent({
                  kind: 'output_delta',
                  streamSeq: String(index),
                  content: { type: 'synthetic_delta' }
                }));
              }
              eventResults.push(await controls.onEvent({
                kind: 'completed',
                streamSeq: String(eventCount + 1),
                content: { type: 'synthetic_terminal' }
              }));
            }
          });
        } finally {
          detach();
        }
        const elapsedMs = performance.now() - startedAt;
        const events = collector.snapshot().events;
        const providerEvents = events.filter((event) => event.kind === 'provider.stream_event');
        const checkpointRows = await list(app, 'ModelStreamCheckpoint', {
          model_request_id: request.modelRequestId
        });
        return {
          elapsedMs,
          inputNonterminalEvents: eventCount,
          observedStreamEvents: providerEvents.length,
          checkpointedEvents: providerEvents.filter((event) => event.checkpointed).length,
          durableStreamTransactions: providerEvents.reduce((sum, event) => sum + event.transactionCount, 0),
          modelStreamWorkerTransactions: events.filter((event) =>
            event.kind === 'database.request'
            && event.phase === 'finished'
            && event.requestKind === 'modelStreamEvent'
          ).length,
          retainedCheckpointRows: checkpointRows.length,
          capacityDrops: eventResults.filter((entry) => entry.ignoredReason === 'checkpoint-capacity').length,
          contextMaterializeCalls: events.filter((event) => event.kind === 'context.materialize').length,
          runtimeDatabaseRequests: events.filter((event) =>
            event.kind === 'database.request' && event.phase === 'finished'
          ).length
        };
      }));
    }
    output.push({
      eventCount,
      measurements,
      elapsedMs: distribution(measurements.map((entry) => entry.elapsedMs))
    });
  }
  return output;
}

async function benchmarkOutputItemDoneAtCapacity(sampleCount) {
  const measurements = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    measurements.push(await withApp(`phase0-provider-item-done-${sample}`, async (app, scope) => {
      const request = await createRequest(app, scope, `item-done-${sample}`);
      const collector = new RuntimePerformanceMetricCollector();
      const detach = app.database.attachPerformanceMetrics(collector);
      let itemDone;
      try {
        await app.modelProvider.dispatch(request.modelRequestId, {
          providerId: 'phase0-provider',
          async sendFullRequest(_fullRequest, controls) {
            await controls.onEvent({
              kind: 'output_delta',
              streamSeq: '1',
              content: { type: 'synthetic_delta' }
            });
            for (let index = 1; index < MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT; index += 1) {
              itemDone = await controls.onEvent({
                kind: 'output_item_done',
                streamSeq: String(index + 1),
                content: { type: 'synthetic_item_done', item: index }
              });
            }
            await controls.onEvent({
              kind: 'completed',
              streamSeq: String(MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT + 1),
              content: { type: 'synthetic_terminal' }
            });
          }
        });
      } finally {
        detach();
      }
      const events = collector.snapshot().events;
      const itemMetric = events.find((event) =>
        event.kind === 'provider.stream_event' && event.eventKind === 'output_item_done'
      );
      return {
        checkpointed: itemDone?.checkpointed ?? null,
        ignoredReason: itemDone?.ignoredReason ?? null,
        transactionCount: itemMetric?.transactionCount ?? null
      };
    }));
  }
  return { measurements };
}

async function benchmarkShortProcesses(sampleCount) {
  if (process.platform !== 'linux') return { skipped: 'Linux detached-wrapper protocol required.' };
  const scenarios = [
    { name: 'true', command: 'true' },
    { name: 'printf_x', command: 'printf x' },
    { name: 'node_version', command: `${quotePosixShellArgument(process.execPath)} --version` }
  ];
  const output = [];
  for (const scenario of scenarios) {
    const measurements = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      measurements.push(await withApp(`phase0-process-${scenario.name}-${sample}`, async (app, scope) => {
        const toolCallId = `tool-${scenario.name}-${sample}`;
        await app.runtime.effects.createToolCall({
          source: { kind: 'internal', key: `create-${scenario.name}-${sample}` },
          toolCallId,
          turnId: scope.turnId,
          toolName: 'bash',
          arguments: {}
        });
        const collector = new RuntimePerformanceMetricCollector();
        const detach = app.database.attachPerformanceMetrics(collector);
        const prepareStartedAt = performance.now();
        let prepared;
        try {
          prepared = await app.processes.prepareStart({
            source: { kind: 'internal', key: `prepare-${scenario.name}-${sample}` },
            toolCallId,
            command: scenario.command,
            cwd: root
          });
          const prepareDurationMs = performance.now() - prepareStartedAt;
          const dispatchStartedAt = performance.now();
          const dispatched = await app.processes.dispatchStart(prepared.effect.effectIntentId, 5_000);
          const dispatchDurationMs = performance.now() - dispatchStartedAt;
          assert.equal(dispatched.observation?.foreground?.state, 'exited');
          const observation = dispatched.observation;
          const foreground = observation?.foreground;
          const events = collector.snapshot().events.filter((event) => event.kind === 'process.phase');
          return {
            prepareDurationMs,
            dispatchDurationMs,
            totalDurationMs: prepareDurationMs + dispatchDurationMs,
            terminalStatus: dispatched.terminal?.status ?? null,
            processEvidence: {
              observationOutcome: observation?.outcome ?? null,
              observationState: observation?.state ?? null,
              launchOutcome: observation?.launch.outcome ?? null,
              ...(observation?.launch.outcome && observation.launch.outcome !== 'succeeded'
                ? { launchError: observation.launch.error }
                : {}),
              foregroundState: foreground?.state ?? null,
              ...(foreground?.state === 'exited'
                ? {
                    exitCode: foreground.receipt.exitCode,
                    signal: foreground.receipt.signal,
                    terminationReason: foreground.receipt.terminationReason,
                    stopRequested: foreground.receipt.stopRequested
                  }
                : {}),
              ...(foreground?.state === 'outcome_unknown'
                ? { outcomeUnknownReason: foreground.reason }
                : {})
            },
            phases: Object.fromEntries(['spawn', 'identity_ready', 'terminal_receipt', 'output_import'].map((phase) => {
              const observed = events.filter((event) => event.phase === phase);
              return [phase, {
                count: observed.length,
                durationMs: observed.reduce((sum, event) => sum + event.durationMs, 0),
                ...(phase === 'output_import'
                  ? { byteCount: observed.reduce((sum, event) => sum + (event.byteCount ?? 0), 0) }
                  : {})
              }];
            }))
          };
        } finally {
          detach();
        }
      }));
    }
    output.push({
      command: scenario.name,
      measurements,
      totalDurationMs: distribution(measurements.map((entry) => entry.totalDurationMs))
    });
  }
  return output;
}

async function benchmarkClientFeed(sampleCount) {
  const measurements = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    measurements.push(await withApp(`phase0-feed-${sample}`, async (app, scope) => {
      const collector = new RuntimePerformanceMetricCollector();
      const detach = app.database.attachPerformanceMetrics(collector);
      const now = new Date().toISOString();
      collector.reset();
      await app.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').update(scope.conversationId, {
          title: `detached-${sample}`,
          updated_at: now
        })
      ]);
      const withoutWebview = summarizeFeedMetrics(collector.snapshot().events);

      const sent = [];
      const connection = await app.runtime.clientFeed.connect({
        activeConversationId: scope.conversationId,
        send(message) { sent.push(message); }
      });
      assert.ok(sent[0]);
      app.runtime.clientFeed.acknowledge({
        sessionId: connection.sessionId,
        hostBootId: connection.hostBootId,
        messageSeq: sent[0].messageSeq
      });
      collector.reset();
      await app.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').update(scope.conversationId, {
          title: `attached-${sample}`,
          updated_at: new Date().toISOString()
        })
      ]);
      const withWebview = summarizeFeedMetrics(collector.snapshot().events);
      app.runtime.clientFeed.disconnect(connection.sessionId);
      detach();
      return { withoutWebview, withWebview };
    }));
  }
  return { measurements };
}

function summarizeFeedMetrics(events) {
  const feed = events.filter((event) => event.kind === 'client_feed.sync_listener');
  const database = events.filter((event) => event.kind === 'database.commit_listeners');
  return {
    feedListenerEvents: feed.length,
    feedListenerDurationMs: feed.reduce((sum, event) => sum + event.durationMs, 0),
    databaseListenerCount: database.reduce((sum, event) => sum + event.listenerCount, 0),
    databaseListenerDurationMs: database.reduce((sum, event) => sum + event.durationMs, 0)
  };
}

function inspectExistingLlmAggregation() {
  let clock = 0;
  const byCount = createLlmStreamEventBatcher(() => undefined, { now: () => clock });
  for (let index = 0; index < 24; index += 1) {
    byCount.emit(deltaEvent('x'));
  }
  const countMetrics = byCount.metrics();
  byCount.dispose(false);

  const byChars = createLlmStreamEventBatcher(() => undefined, { now: () => clock });
  byChars.emit(deltaEvent('x'.repeat(512)));
  byChars.emit(deltaEvent('x'.repeat(512)));
  const charMetrics = byChars.metrics();
  byChars.dispose(false);
  return {
    intervalMs: LLM_STREAM_EVENT_AGGREGATION_INTERVAL_MS,
    maxBatchEvents: countMetrics.maxBatchEvents,
    maxBufferedChars: charMetrics.maxBufferedChars
  };

  function deltaEvent(text) {
    clock += 1;
    return {
      type: LlmEventType.Delta,
      payload: { requestId: 'synthetic', attemptId: 'synthetic', generation: 1, text }
    };
  }
}

async function withApp(name, run) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const app = await kernel.ReliableKernelApplication.open(authority, dependencies());
  try {
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: name,
        title: name,
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      emptyConversationContextHandleStateStep(name, now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${name}-agent-link`,
        conversation_id: name,
        agent_id: 'agent-main',
        role: 'default',
        created_at: now,
        updated_at: now
      })
    ]);
    const started = await app.turns.input({
      source: { kind: 'command', key: `${name}-input` },
      conversationId: name,
      leaseOwnerId: `${name}-owner`,
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      content: 'synthetic phase zero input'
    });
    return await run(app, { conversationId: name, turnId: started.turnId });
  } finally {
    await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function createRequest(app, scope, key) {
  const head = (await list(app, 'ConversationContextHeadLink', {
    conversation_id: scope.conversationId
  }))[0];
  const authority = (await list(app, 'AuthoritySnapshot', { turn_id: scope.turnId }))[0];
  return app.modelProvider.createModelRequest({
    turnId: scope.turnId,
    contextRootId: head.root_id,
    authoritySnapshotId: authority.id,
    recipe: { kind: 'phase0-provider-benchmark' },
    idempotencyKey: key
  });
}

async function list(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
}

function dependencies() {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: 'phase0-provider', modelId: 'phase0-model' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: { providerConfigId: 'phase0-provider', modelId: 'phase0-model' },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'tools-default', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {}
              },
              systemPrompt: { id: 'prompt-default', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: {
                id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null
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
      resolve() { throw new Error('Phase zero benchmark supplies providers explicitly.'); }
    },
    toolDispatcher: {
      definitions() { return []; },
      async dispatch() { throw new Error('Phase zero benchmark does not use agent-loop tool dispatch.'); }
    }
  };
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1)
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function quotePosixShellArgument(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return parsed;
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}
