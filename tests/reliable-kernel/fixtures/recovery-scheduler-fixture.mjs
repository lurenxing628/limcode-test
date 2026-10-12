// Focused real production probes; no matrix or duplicate registrations.
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { pathToFileURL } from 'node:url';

const root = process.cwd();

const compiledRoot = process.env.LIMCODE_COMPILED_ROOT
  ? path.resolve(root, process.env.LIMCODE_COMPILED_ROOT)
  : path.join(root, 'dist/extension');

const kernel = await import(pathToFileURL(
  path.join(compiledRoot, 'backend/reliableKernel/index.js')
).href);

const { emptyConversationContextHandleStateStep } = await import(pathToFileURL(
  path.join(compiledRoot, 'backend/reliableKernel/conversationContextHandleState.js')
).href);

const { readConversationContextHandleCatalog } = await import(pathToFileURL(
  path.join(compiledRoot, 'backend/reliableKernel/conversationChildHandles.js')
).href);

function frozenPolicy() {
  return {
    displayAutoExpand: false,
    displayAutoOpenDiff: false,
    executionGate: 'automatic',
    changeApplyMode: 'unsupported',
    changeApplyDelaySeconds: 0,
    autoSubmitResult: true,
    schedulingMode: 'parallel'
  };
}

const SCHEDULER_DEFINITIONS = [
  { declaration: { name: 'read', description: 'readonly fixture', parameters: { type: 'object' } } },
  { declaration: { name: 'run_agent', description: 'child fixture', parameters: { type: 'object' } } }
];

function schedulerRecipeTools(names) {
  return SCHEDULER_DEFINITIONS
    .filter((definition) => names.includes(definition.declaration.name))
    .map((definition) => ({
      name: definition.declaration.name,
      description: definition.declaration.description,
      parameters: definition.declaration.parameters
    }));
}

function watchScheduled(tasks) {
  const state = { settled: new Map() };
  for (const [index, task] of tasks.entries()) {
    Promise.resolve(task).then(
      (result) => { state.settled.set(index, result); },
      (error) => { state.settled.set(index, error); }
    );
  }
  return state;
}

async function untilScheduling(state, allowedSettled, predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    const premature = [...state.settled.keys()].filter((index) => !allowedSettled.has(index));
    if (premature.length > 0) {
      const details = premature.map((index) => {
        const value = state.settled.get(index);
        return value instanceof Error
          ? `#${index} threw ${String(value && value.message)}`
          : `#${index} settled ${JSON.stringify(value)}`;
      }).join('; ');
      throw new Error(`Premature scheduled settlement while waiting for ${label}: ${details}`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dependencies(host, toolPolicyFor) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: 'provider-native', modelId: 'model-native' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: 'provider-native',
                provider: 'openai-responses',
                modelId: 'model-native',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100000,
                contextWindowTokens: 128000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'tools-default',
                allowedTools: [],
                preset: 'custom',
                toolConfigs: {},
                sourceConfigs: {},
                ...toolPolicyFor(request.conversationId)
              },
              planReviewPolicy: { mode: 'never' },
              systemPrompt: { id: 'prompt-default', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
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
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      }
    },
    providers: {
      resolve(providerId) {
        return {
          providerId,
          async sendFullRequest() { throw new Error('fixture provider must be supplied explicitly'); }
        };
      }
    },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({
        database,
        contentStore,
        effects: runtime.effects,
        files,
        fileMutations,
        processes,
        mcp,
        interactions,
        host
      })
  };
}

async function list(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 100
  }))).snapshot;
}

let sharedNative;
async function nativeApplication() {
  if (sharedNative) return sharedNative;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-native-schedule-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const hosts = new Map(), policies = new Map(), dispatches = new Map(), tasks = new Map();
  const host = {
    definitions: () => SCHEDULER_DEFINITIONS,
    executeNoEffect: (definition, input, ...args) => hosts.get(input.turnId).executeNoEffect(definition, input, ...args),
    dispatchSpecial: (definition, input, ...args) => hosts.get(input.turnId).dispatchSpecial(definition, input, ...args)
  };
  const app = await kernel.ReliableKernelApplication.open(authority, dependencies(host, id => policies.get(id)));
  return sharedNative = { app, parent, hosts, policies, dispatches, tasks };
}

export async function close() {
  if (!sharedNative) return;
  await sharedNative.app.close();
  await fs.rm(sharedNative.parent, { recursive: true, force: true });
}

async function withNativeApp(name, run, host, toolPolicyOverrides) {
  const fixture = await nativeApplication(), app = fixture.app;
  fixture.policies.set(name, toolPolicyOverrides);
  let turnId;
  try {
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: name, title: name, status: 'active', created_at: now, updated_at: now
      }),
      emptyConversationContextHandleStateStep(name, now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${name}-agent-link`, conversation_id: name, agent_id: 'agent-main',
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    const started = await app.turns.input({
      source: { kind: 'command', key: `${name}-input` },
      conversationId: name,
      leaseOwnerId: `${name}-owner`,
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      content: 'native tool admission fixture'
    });
    turnId = started.turnId;
    fixture.hosts.set(turnId, host);
    await run(app, name, turnId);
  } finally {
    if (turnId) {
      host.closing = true;
      host.release();
      await Promise.allSettled(fixture.tasks.get(turnId) ?? []);
      await app.modelProvider.quiesceTurnDispatches(turnId);
      await Promise.allSettled(fixture.dispatches.get(turnId) ?? []);
      fixture.hosts.delete(turnId);
      fixture.tasks.delete(turnId);
      fixture.dispatches.delete(turnId);
    }
    fixture.policies.delete(name);
  }
}

async function createStreamingRequest(app, turnId, key, tools = []) {
  const turn = (await list(app, 'Turn', { id: turnId }))[0];
  const head = (await list(app, 'ConversationContextHeadLink', { conversation_id: turn.conversation_id }))[0];
  const authoritySnapshot = (await list(app, 'AuthoritySnapshot', { turn_id: turnId }))[0];
  const created = await app.modelProvider.createModelRequest({
    turnId,
    contextRootId: head.root_id,
    authoritySnapshotId: authoritySnapshot.id,
    recipe: { kind: 'reliable-agent-turn', round: '1', tools,
      modelHandleCatalog: await readConversationContextHandleCatalog(app.database, app.contentStore, turn.conversation_id) },
    idempotencyKey: key
  });
  // Drive the established dispatch socket-open: it commits the full streaming aggregate
  // (ModelRequest streaming + running Operation/Attempt + first socket generation) before the
  // adapter starts, then the holding adapter keeps the stream open for the test.
  const opened = deferred();
  const hold = deferred();
  const dispatchPromise = app.modelProvider.dispatch(created.modelRequestId, {
    providerId: 'provider-native',
    async sendFullRequest(_request, controls) {
      opened.resolve(controls);
      if (controls.signal.aborted) return;
      await Promise.race([
        hold.promise,
        new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }))
      ]);
    }
  });
  // Teardown aborts the held stream; the terminal classification is not part of any assertion.
  const dispatches = sharedNative.dispatches.get(turnId) ?? [];
  dispatches.push(dispatchPromise);
  sharedNative.dispatches.set(turnId, dispatches);
  void dispatchPromise.catch(() => undefined);
  const controls = await opened.promise;
  const request = (await list(app, 'ModelRequest', { id: created.modelRequestId }))[0];
  assert.equal(request.status, 'streaming', 'dispatch socket-open must commit the streaming aggregate');
  const stats = request.stream_stats_json;
  return {
    modelRequestId: created.modelRequestId,
    controls,
    close: hold.resolve,
    identity: {
      attemptSeq: String(stats.attemptSeq),
      socketGeneration: String(stats.socketGeneration)
    }
  };
}

async function insertAssistantMessage(app, modelRequestId, key) {
  const now = new Date().toISOString();
  const messageId = `message-${key}`;
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
      id: messageId, created_at: now, updated_at: now, deleted_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').insert({
      id: `request-message-link-${key}`,
      model_request_id: modelRequestId,
      message_id: messageId,
      created_at: now
    })
  ]);
  return messageId;
}

async function persistNativeCheckpoint(app, request, streamSeq, checkpointKind, payload) {
  const result = checkpointKind === 'native_tool_call'
    ? await app.modelProvider.recordNativeToolCallProof(
        request.modelRequestId,
        request.identity.attemptSeq,
        request.identity.socketGeneration,
        String(streamSeq),
        payload
      )
    : await app.modelProvider.recordStreamEvent(
        request.modelRequestId,
        request.identity.attemptSeq,
        request.identity.socketGeneration,
        { kind: 'native_control', streamSeq: String(streamSeq), content: payload }
      );
  assert.deepEqual(
    { accepted: result.accepted, checkpointed: result.checkpointed },
    { accepted: true, checkpointed: true },
    `native checkpoint ${checkpointKind}@${streamSeq} must persist`
  );
  const persisted = (await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId }))
    .filter((row) => String(row.stream_seq) === String(streamSeq) && row.checkpoint_kind === checkpointKind);
  assert.equal(persisted.length, 1, `native checkpoint ${checkpointKind}@${streamSeq} must be uniquely readable`);
  return persisted[0].id;
}

function nativeEntry(toolCallId, overrides = {}) {
  return {
    toolCallId,
    toolName: 'read',
    arguments: { path: '/tmp/native-fixture' },
    providerCallId: `call-${toolCallId}`,
    providerOrdinal: 0,
    policy: frozenPolicy(),
    ...overrides
  };
}

function nativeItemCheckpoint(entry, overrides = {}) {
  return {
    type: 'native_tool_call',
    responseId: 'resp-1',
    toolName: entry.toolName,
    arguments: entry.arguments,
    resolvedArguments: entry.arguments,
    modelHandleCatalog: { entries: [] },
    providerCallId: entry.providerCallId,
    providerOrdinal: entry.providerOrdinal,
    async: true,
    ...overrides
  };
}

function batchInput(turnId, modelRequestId, messageId, entry, key) {
  return {
    source: { kind: 'callback', key: `test:${key}` },
    batchId: `batch-${key}`,
    turnId,
    modelRequestId,
    messageId,
    entries: [entry]
  };
}

async function admitNativeCall(app, options) {
  const entry = nativeEntry(options.toolCallId, {
    toolName: options.toolName ?? 'read',
    arguments: options.arguments ?? { path: '/tmp/native-fixture' },
    providerCallId: options.providerCallId ?? `call-${options.toolCallId}`,
    providerOrdinal: options.providerOrdinal ?? 0,
    policy: options.policy ?? frozenPolicy()
  });
  await persistNativeCheckpoint(
    app,
    options.request,
    options.streamSeq,
    'native_tool_call',
    nativeItemCheckpoint(entry, { async: options.declaredAsync ?? true })
  );
  await app.runtime.effects.createToolCallBatch({
    ...batchInput(options.turnId, options.request.modelRequestId, options.messageId, entry, `admit-${options.toolCallId}`),
    streamIdentity: { ...options.request.identity, streamSeq: String(options.streamSeq) }
  });
  return entry;
}

function scheduleInput(turnId, modelRequestId, entry) {
  return {
    turnId,
    modelRequestId,
    toolCallId: entry.toolCallId,
    providerCallId: entry.providerCallId,
    toolName: entry.toolName,
    arguments: entry.arguments
  };
}



export const scenario1 = async () => {
  const started = [];
  const gates = new Map();
  const host = {
    definitions: () => SCHEDULER_DEFINITIONS,
    release() { for (const gate of gates.values()) gate.resolve(); },
    async executeNoEffect(definition, input) {
      started.push(input.toolCallId);
      const gate = deferred();
      gates.set(input.toolCallId, gate);
      if (!host.closing) await gate.promise;
      return { ok: true, output: 'done' };
    }
  };
  await withNativeApp('native-schedule-ordinary-cap', async (app, conversationId, turnId) => {
    const effects = app.runtime.effects;
    const request = await createStreamingRequest(app, turnId, 'req-cap', schedulerRecipeTools(['read']));
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-cap');
    const entries = [];
    for (let index = 0; index < 9; index += 1) {
      entries.push(await admitNativeCall(app, {
        turnId,
        request,
        messageId,
        toolCallId: `tool-call-cap-${index}`,
        streamSeq: index + 1,
        providerOrdinal: index
      }));
    }
    const tasks = entries.map((entry) =>
      app.toolDispatcher.scheduleAdmittedCall(scheduleInput(turnId, modelRequestId, entry))
    );
    sharedNative.tasks.set(turnId, tasks);
    const watch = watchScheduled(tasks);
    const allowedSettled = new Set();
    await untilScheduling(watch, allowedSettled, () => started.length === 8, 'ordinary lane admits exactly eight calls');
    assert.ok(!started.includes('tool-call-cap-8'), 'the ninth call waits for a lane slot');
    gates.get('tool-call-cap-0').resolve();
    allowedSettled.add(0);
    await tasks[0];
    await untilScheduling(watch, allowedSettled, () => started.includes('tool-call-cap-8'), 'a freed slot starts the queued ninth call');
    for (const [index, gate] of [...gates.entries()]) {
      if (index !== 'tool-call-cap-0') gate.resolve();
    }
    for (let index = 1; index < tasks.length; index += 1) allowedSettled.add(index);
    const results = await Promise.all(tasks);
    assert.ok(results.every((result) => result.status === 'succeeded'));
  }, host, { allowedTools: ['read', 'run_agent'] });
};

export const scenario2 = async () => {
  const started = [];
  const gates = new Map();
  const host = {
    definitions: () => SCHEDULER_DEFINITIONS,
    release() { for (const gate of gates.values()) gate.resolve(); },
    async executeNoEffect(definition, input) {
      started.push(input.toolCallId);
      const gate = deferred();
      gates.set(input.toolCallId, gate);
      if (!host.closing) await gate.promise;
      return { ok: true, output: 'done' };
    }
  };
  await withNativeApp('native-schedule-serial', async (app, conversationId, turnId) => {
    const request = await createStreamingRequest(app, turnId, 'req-serial', schedulerRecipeTools(['read']));
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-serial');
    const serialPolicy = { ...frozenPolicy(), schedulingMode: 'serial' };
    const specs = [
      { toolCallId: 'tool-call-seq-a', policy: frozenPolicy() },
      { toolCallId: 'tool-call-seq-s1', policy: serialPolicy },
      { toolCallId: 'tool-call-seq-b', policy: frozenPolicy() },
      { toolCallId: 'tool-call-seq-s2', policy: serialPolicy }
    ];
    const entries = [];
    for (const [index, spec] of specs.entries()) {
      entries.push(await admitNativeCall(app, {
        turnId,
        request,
        messageId,
        toolCallId: spec.toolCallId,
        streamSeq: index + 1,
        providerOrdinal: index,
        policy: spec.policy
      }));
    }
    const tasks = entries.map((entry) =>
      app.toolDispatcher.scheduleAdmittedCall(scheduleInput(turnId, modelRequestId, entry))
    );
    sharedNative.tasks.set(turnId, tasks);
    const watch = watchScheduled(tasks);
    const allowedSettled = new Set();
    await untilScheduling(watch, allowedSettled, () => started.length === 1, 'only the first parallel call runs before the serial point');
    assert.deepEqual(started, ['tool-call-seq-a']);
    gates.get('tool-call-seq-a').resolve();
    allowedSettled.add(0);
    await untilScheduling(watch, allowedSettled, () => started.length === 2, 'the serial call drains the earlier generation');
    assert.deepEqual(started, ['tool-call-seq-a', 'tool-call-seq-s1']);
    assert.ok(!started.includes('tool-call-seq-b'), 'a later parallel call waits for the serial call');
    gates.get('tool-call-seq-s1').resolve();
    allowedSettled.add(1);
    await untilScheduling(watch, allowedSettled, () => started.includes('tool-call-seq-b'), 'the next generation starts after the serial call');
    assert.ok(!started.includes('tool-call-seq-s2'), 'the next serial call drains the new generation first');
    gates.get('tool-call-seq-b').resolve();
    allowedSettled.add(2);
    await untilScheduling(watch, allowedSettled, () => started.includes('tool-call-seq-s2'), 'the drained serial call runs last');
    gates.get('tool-call-seq-s2').resolve();
    allowedSettled.add(3);
    const results = await Promise.all(tasks);
    assert.ok(results.every((result) => result.status === 'succeeded'));
  }, host, { allowedTools: ['read', 'run_agent'] });
};

export const scenario3 = async () => {
  const started = [];
  const admissions = new Map();
  const gates = new Map();
  const host = {
    definitions: () => SCHEDULER_DEFINITIONS,
    release() { for (const gate of gates.values()) gate.resolve(); },
    async dispatchSpecial(definition, input, authority, signal, admission) {
      started.push(input.toolCallId);
      admissions.set(input.toolCallId, admission);
      const gate = deferred();
      gates.set(input.toolCallId, gate);
      if (!host.closing) await gate.promise;
      return {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'awaiting_child',
        resumeKey: input.toolCallId
      };
    }
  };
  await withNativeApp('native-schedule-child-barrier', async (app, conversationId, turnId) => {
    const request = await createStreamingRequest(app, turnId, 'req-child', schedulerRecipeTools(['run_agent']));
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-child');
    const entries = [];
    for (let index = 0; index < 9; index += 1) {
      entries.push(await admitNativeCall(app, {
        turnId,
        request,
        messageId,
        toolCallId: `tool-call-child-${index}`,
        toolName: 'run_agent',
        arguments: { operation: 'spawn', taskName: `Inspect admission slot ${index}`, prompt: `Check child admission ${index}` },
        streamSeq: index + 1,
        providerOrdinal: index
      }));
    }
    const tasks = entries.map((entry) =>
      app.toolDispatcher.scheduleAdmittedCall(scheduleInput(turnId, modelRequestId, entry))
    );
    sharedNative.tasks.set(turnId, tasks);
    const watch = watchScheduled(tasks);
    const allowedSettled = new Set();
    await untilScheduling(watch, allowedSettled, () => started.length === 8, 'child starts are bounded by the shared admission barrier');
    assert.ok(!started.includes('tool-call-child-8'), 'the ninth child waits for an admission slot');
    assert.equal(typeof admissions.get('tool-call-child-0')?.release, 'function');
    admissions.get('tool-call-child-0').release();
    await untilScheduling(watch, allowedSettled, () => started.includes('tool-call-child-8'), 'releasing the durable barrier admits the queued child');
    assert.equal(gates.has('tool-call-child-0'), true, 'the released child keeps running past the barrier');
    for (const gate of gates.values()) gate.resolve();
    for (let index = 0; index < tasks.length; index += 1) allowedSettled.add(index);
    const results = await Promise.all(tasks);
    assert.ok(results.every((result) => result.disposition === 'paused'));
  }, host, { allowedTools: ['read', 'run_agent'] });
};
