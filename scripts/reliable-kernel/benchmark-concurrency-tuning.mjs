import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const CHILD_MODEL_FALLBACK = Object.freeze({
  providerConfigId: 'benchmark',
  provider: 'openai-compatible',
  model: 'benchmark'
});
const kernel = await import(pathToFileURL(path.join(
  root,
  'dist/extension/backend/reliableKernel/index.js'
)).href);
const concurrency = await import(pathToFileURL(path.join(
  root,
  'dist/extension/backend/capabilities/boundedConcurrency.js'
)).href);
const scheduling = await import(pathToFileURL(path.join(
  root,
  'dist/extension/shared/agentScheduling.js'
)).href);

const iterations = integerArgument('--iterations', 5);
const childIterations = integerArgument('--child-iterations', 3);
const ordinaryCap = scheduling.MAX_CONCURRENT_ORDINARY_TOOLS_PER_TURN ?? integerArgument('--ordinary-cap', 4);
const constrainedCap = scheduling.MAX_CONCURRENT_PROCESS_OR_MCP_TOOLS_PER_TURN
  ?? integerArgument('--constrained-cap', 2);
const childCap = scheduling.MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN;
const outputPath = optionalTextArgument('--output');

const report = {
  kind: 'limcode-concurrency-tuning-benchmark',
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  caps: { ordinary: ordinaryCap, processOrMcp: constrainedCap, childAdmission: childCap },
  iterations,
  caveats: [
    'lane throughput uses deterministic delayed capabilities and measures the bounded scheduler itself',
    'child durable-start uses a fresh temporary SQLite/CAS Runtime and covers spawn, claim, receipt, and receipt reconciliation, but not provider network execution',
    'HOL uses the real ReliableToolDispatcher with a delayed child fixture and a fast readonly fixture; it measures when the readonly Operation becomes durable and when the whole batch returns',
    'all fixtures use temporary directories and do not mutate the workspace Runtime'
  ],
  ordinaryLane: await benchmarkSyntheticLane({ count: 8, delayMs: 50, cap: ordinaryCap }),
  processOrMcpLane: await benchmarkSyntheticLane({ count: 4, delayMs: 80, cap: constrainedCap }),
  childDurableStart: await benchmarkChildDurableStart(),
  mixedHol: await benchmarkMixedHol()
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await fs.writeFile(path.resolve(root, outputPath), serialized, 'utf8');
process.stdout.write(serialized);

async function benchmarkSyntheticLane({ count, delayMs, cap }) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let active = 0;
    let maxActive = 0;
    const startedAt = performance.now();
    const outcomes = await concurrency.mapSettledWithBoundedConcurrency(
      Array.from({ length: count }, (_, index) => index),
      cap,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(delayMs);
        active -= 1;
        return value;
      }
    );
    assertNoRejection(outcomes);
    samples.push({ wallMs: round(performance.now() - startedAt), maxActive });
  }
  return {
    count,
    capabilityDelayMs: delayMs,
    raw: samples,
    summary: {
      wallMs: summarize(samples.map((sample) => sample.wallMs)),
      maxActive: summarize(samples.map((sample) => sample.maxActive))
    }
  };
}

async function benchmarkChildDurableStart() {
  const samples = [];
  for (let iteration = 0; iteration < childIterations; iteration += 1) {
    samples.push(await runChildDurableStart(iteration));
  }
  return {
    count: 8,
    iterations: childIterations,
    raw: samples,
    summary: {
      wallMs: summarize(samples.map((sample) => sample.wallMs)),
      databaseRequestCount: summarize(samples.map((sample) => sample.databaseRequestCount)),
      workerQueueWaitTotalMs: summarize(samples.map((sample) => sample.workerQueueWaitTotalMs)),
      workerExecuteTotalMs: summarize(samples.map((sample) => sample.workerExecuteTotalMs))
    }
  };
}

async function runChildDurableStart(iteration) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-concurrency-child-start-'));
  let database;
  let services;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    database = await kernel.RuntimeDatabase.open(candidate.authority, {
      hostBootId: `concurrency-child-start-${iteration}`
    });
    const store = kernel.ContentAddressedStore.forDatabase(candidate.authority, database);
    const authorityCompiler = benchmarkAuthorityCompiler('child-start');
    services = kernel.createReliableKernelRuntimeServices(database, store, { authorityCompiler });
    const now = new Date().toISOString();
    const conversationId = `concurrency-child-start-${iteration}`;
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId,
        title: 'Concurrency child start benchmark',
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${conversationId}-agent`,
        conversation_id: conversationId,
        agent_id: 'agent-main',
        role: 'default',
        created_at: now,
        updated_at: now
      })
    ]);
    const turns = new kernel.TurnControlPlane(database, store, { authorityCompiler });
    const parentTurn = await turns.input({
      source: { kind: 'command', key: `${conversationId}-input` },
      conversationId,
      leaseOwnerId: `${conversationId}-owner`,
      hostBootId: database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      content: 'Start child fixtures.'
    });
    const toolCalls = [];
    for (let index = 0; index < 8; index += 1) {
      toolCalls.push(await services.effects.createToolCall({
        source: { kind: 'callback', key: `${conversationId}-tool-${index}` },
        toolCallId: `${conversationId}-tool-${index}`,
        turnId: parentTurn.turnId,
        toolName: 'run_agent',
        arguments: { prompt: `child ${index}` }
      }));
    }

    const events = [];
    const detach = database.attachPerformanceMetrics?.({
      record(event) { events.push({ ...event }); }
    }) ?? (() => undefined);
    const startedAt = performance.now();
    const outcomes = await concurrency.mapSettledWithBoundedConcurrency(
      toolCalls,
      childCap,
      async (tool, index) => {
        const spawned = await services.children.spawn({
          sourceToolCallId: tool.toolCallId,
          childAgentId: `child-agent-${iteration}-${index}`,
          modelFallback: CHILD_MODEL_FALLBACK,
          sourceSettlement: 'child_handle',
          prompt: `child prompt ${index}`,
          completionPolicy: 'background',
          leaseOwnerId: `child-owner-${iteration}-${index}`,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()
        });
        if (!await services.children.claimSpawnDispatch(spawned.effectIntentId)) {
          throw new Error('Child spawn claim was unexpectedly unavailable.');
        }
        const receipt = await services.children.recordSpawnReceipt({
          sourceKey: `child-receipt-${iteration}-${index}`,
          attemptId: spawned.attemptId,
          outcome: 'succeeded',
          detail: { adapter: 'benchmark' }
        });
        await services.children.reconcileSpawnReceipt(receipt.effectReceiptId);
      }
    );
    const wallMs = performance.now() - startedAt;
    detach();
    assertNoRejection(outcomes);
    const finished = events.filter((event) => event.kind === 'database.request' && event.phase === 'finished');
    return {
      wallMs: round(wallMs),
      databaseRequestCount: finished.length,
      workerQueueWaitTotalMs: round(sum(finished, 'workerQueueWaitMs')),
      workerExecuteTotalMs: round(sum(finished, 'workerExecuteDurationMs'))
    };
  } finally {
    services?.clientFeed?.close?.();
    await database?.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function benchmarkMixedHol() {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    samples.push(await runMixedHol(iteration));
  }
  return {
    childDelayMs: 250,
    readonlyDelayMs: 20,
    raw: samples,
    summary: {
      readonlyCapabilityMs: summarize(samples.map((sample) => sample.readonlyCapabilityMs)),
      readonlyDurableMs: summarize(samples.map((sample) => sample.readonlyDurableMs)),
      batchReturnMs: summarize(samples.map((sample) => sample.batchReturnMs)),
      durableLagAfterCapabilityMs: summarize(samples.map((sample) => sample.durableLagAfterCapabilityMs))
    }
  };
}

async function runMixedHol(iteration) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-concurrency-hol-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let app;
  let readonlyCapabilityAt;
  let readonlyDurableAt;
  let batchStartedAt;
  let unsubscribe = () => undefined;
  try {
    const childDefinition = agentRunDefinition('run_agent');
    const readonlyDefinition = runtimeDefinition('echo', {
      riskLevel: 'read',
      readonly: true,
      defaultAutoApproveExecution: true
    });
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: dispatcherAuthorityCompiler(['run_agent', 'echo']),
      mcpPolicyGate: {
        async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
      },
      providers: {
        resolve(providerId) {
          return { providerId, async sendFullRequest() { throw new Error('Provider is unused.'); } };
        }
      },
      createToolDispatcher(context) {
        return new kernel.ReliableToolDispatcher({
          ...context,
          effects: context.runtime.effects,
          host: {
            definitions: () => [childDefinition, readonlyDefinition],
            async executeNoEffect() {
              await delay(20);
              readonlyCapabilityAt = performance.now();
              return { ok: true, output: { lane: 'ordinary' } };
            },
            async dispatchSpecial(_definition, input, _authority, signal, admission) {
              admission?.release();
              await abortableDelay(250, signal);
              return {
                disposition: 'settled',
                toolCallId: input.toolCallId,
                status: 'succeeded'
              };
            }
          }
        });
      }
    });
    const turnId = await createTurn(app, `concurrency-hol-${iteration}`);
    const child = await createToolCall(app, turnId, 'run_agent', {
      prompt: 'slow child',
      foregroundWaitMs: 60_000,
      scheduling: 'parallel'
    }, `child-${iteration}`);
    const ordinary = await createToolCall(app, turnId, 'echo', {
      value: 'fast readonly',
      scheduling: 'parallel'
    }, `ordinary-${iteration}`);
    unsubscribe = app.database.onCommit((commit) => {
      if (readonlyDurableAt !== undefined) return;
      if (commit.changes.some((change) =>
        change.domain === 'Operation' && change.record?.tool_call_id === ordinary.toolCallId
      )) readonlyDurableAt = performance.now();
    });
    batchStartedAt = performance.now();
    await app.toolDispatcher.dispatchBatch([child, ordinary]);
    const batchReturnedAt = performance.now();
    if (readonlyCapabilityAt === undefined) throw new Error('Readonly capability did not run.');
    if (readonlyDurableAt === undefined) throw new Error('Readonly settlement did not become durable.');
    return {
      readonlyCapabilityMs: round(readonlyCapabilityAt - batchStartedAt),
      readonlyDurableMs: round(readonlyDurableAt - batchStartedAt),
      batchReturnMs: round(batchReturnedAt - batchStartedAt),
      durableLagAfterCapabilityMs: round(readonlyDurableAt - readonlyCapabilityAt)
    };
  } finally {
    unsubscribe();
    await app?.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

function dispatcherAuthorityCompiler(allowedTools) {
  return {
    async compile(request) {
      return {
        turnId: request.turnId,
        executorAgentId: request.executorAgentId,
        executionPreset: { content: '{}' },
        authoritySnapshot: {
          content: JSON.stringify({
            model: { providerConfigId: 'benchmark', modelId: 'benchmark' },
            modelProfile: {
              compressionThresholdTokens: 100000,
              contextWindowTokens: 128000,
              tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
            },
            toolPolicy: {
              id: 'benchmark-tools',
              preset: 'custom',
              allowedTools,
              toolConfigs: {},
              sourceConfigs: {}
            },
            planReviewPolicy: {
              mode: 'off',
              allowReadonlyBeforeApproval: true,
              requireForToolRiskLevels: []
            },
            systemPrompt: { id: null, text: '' },
            workEnvironmentPolicy: {
              id: 'benchmark-work-environments',
              enabled: true,
              allowedWorkEnvironmentIds: [],
              defaultWorkEnvironmentId: null
            }
          })
        }
      };
    }
  };
}

function benchmarkAuthorityCompiler(suffix) {
  return {
    async compile(request) {
      return {
        turnId: request.turnId,
        executorAgentId: request.executorAgentId,
        executionPreset: {
          content: JSON.stringify({ providerConfigId: 'benchmark', modelId: 'benchmark', suffix })
        },
        authoritySnapshot: {
          content: JSON.stringify({
            turnId: request.turnId,
            executorAgentId: request.executorAgentId,
            suffix,
            model: {
              providerConfigId: 'benchmark',
              provider: 'openai-compatible',
              modelId: 'benchmark'
            }
          })
        }
      };
    }
  };
}

function agentRunDefinition(name) {
  return {
    execution: 'agentRun',
    declaration: {
      name,
      description: `${name} benchmark fixture`,
      parameters: { type: 'object' },
      metadata: {
        category: 'agent',
        riskLevel: 'agent',
        defaultEnabled: true,
        defaultAutoApproveExecution: true
      }
    }
  };
}

function runtimeDefinition(name, metadata = {}) {
  return {
    execution: 'runtime',
    declaration: {
      name,
      description: `${name} benchmark fixture`,
      parameters: { type: 'object' },
      metadata: { defaultEnabled: true, ...metadata }
    },
    async execute() { throw new Error(`${name} must execute only through the benchmark host.`); }
  };
}

async function createTurn(app, conversationId) {
  const now = new Date().toISOString();
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId,
      title: 'Concurrency HOL benchmark',
      status: 'active',
      created_at: now,
      updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `${conversationId}-agent`,
      conversation_id: conversationId,
      agent_id: 'agent-main',
      role: 'default',
      created_at: now,
      updated_at: now
    })
  ]);
  const result = await app.turns.input({
    source: { kind: 'command', key: `${conversationId}-input` },
    conversationId,
    leaseOwnerId: 'concurrency-benchmark',
    hostBootId: app.database.hostBootId,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    content: 'Run mixed tools.'
  });
  return result.turnId;
}

async function createToolCall(app, turnId, toolName, args, suffix) {
  const toolCallId = `benchmark-${toolName}-${suffix}`;
  await app.runtime.effects.createToolCall({
    source: { kind: 'internal', key: `create:${toolCallId}` },
    toolCallId,
    turnId,
    toolName,
    arguments: args
  });
  return {
    turnId,
    modelRequestId: 'benchmark-model-request',
    toolCallId,
    toolName,
    arguments: args
  };
}

function assertNoRejection(outcomes) {
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  if (rejected) throw rejected.reason;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: round(sorted[0]),
    p50: round(percentile(sorted, 0.50)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted[sorted.length - 1])
  };
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function sum(events, key) {
  return events.reduce((total, event) => total + (typeof event[key] === 'number' ? event[key] : 0), 0);
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortableDelay(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function integerArgument(name, fallback) {
  const raw = optionalTextArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function optionalTextArgument(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}
