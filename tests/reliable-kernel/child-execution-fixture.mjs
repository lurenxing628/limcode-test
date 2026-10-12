import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const load = file => require(path.join(compiled, file));
export const kernel = load('backend/reliableKernel/index.js');
export const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
export const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
const { boundChildToolPolicy, boundChildSkillPolicy } = load('backend/reliableKernel/childExecutionBoundary.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');

export const policy = overrides => ({ id: 'child-tools', allowedTools: ['read', 'write', 'skills', 'run_agent'], preset: 'custom', toolConfigs: {}, sourceConfigs: {}, ...overrides });

/** One real Runtime/worker for the suite; each case owns separate durable conversation identities. */
export async function openChildFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-suite-'));
  let elapsed = 0, sequence = 0, preparationMs = 0;
  const base = Date.parse('2001-01-01T00:00:00.000Z');
  const now = () => new Date(base + elapsed).toISOString();
  const compileRequests = [];
  const parentPolicies = new Map();
  const authority = request => ({
    kind: 'effective-turn-authority', turnId: request.turnId, conversationId: request.conversationId,
    executorAgentId: request.executorAgentId,
    model: { providerConfigId: 'provider', provider: 'openai-compatible', modelId: 'model', retryPolicy: { enabled: false, maxRetries: 0 } },
    modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
    toolPolicy: request.inheritedToolPolicy ? boundChildToolPolicy(policy(), request.inheritedToolPolicy)
      : parentPolicies.get(request.conversationId)
        ?? policy({ toolConfigs: { run_agent: { config: { maxConcurrentAgents: 1, maxChildAgentDepth: 2 } } } }),
    skillPolicy: request.inheritedSkillPolicy ? boundChildSkillPolicy({ id: 'child-skills', sourceConfigs: {} }, request.inheritedSkillPolicy)
      : { id: 'parent-skills', sourceConfigs: { agents: { enabled: true, disabledSkills: ['deploy'] } } },
    planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
    runtimeContext: { id: null, name: '', template: '' },
    workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
  });
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  const app = await kernel.ReliableKernelApplication.open(root, {
    now,
    authorityCompiler: { async compile(request) {
      compileRequests.push(structuredClone(request));
      if (request.executorAgentId === 'child-agent') elapsed += preparationMs;
      return { turnId: request.turnId, executorAgentId: request.executorAgentId,
        executionPreset: { content: JSON.stringify({ providerConfigId: 'provider', modelId: 'model' }) },
        authoritySnapshot: { content: JSON.stringify(authority(request)) } };
    } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('unexpected MCP'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: `completed ${request.conversationId}` }] } });
    } }; } },
    toolDispatcher: { definitions() { return []; }, async dispatch() { assert.fail('unexpected external tool'); } }
  });
  const rows = async (domain, where = {}) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
  async function parent(label, toolPolicy) {
    const id = `${label}-${++sequence}`;
    if (toolPolicy) parentPolicies.set(id, toolPolicy);
    await app.database.transaction([
      repo('Conversation').insert({ id, title: label, status: 'active', created_at: now(), updated_at: now() }),
      emptyConversationContextHandleStateStep(id, now()),
      repo('AgentConversationLink').insert({ id: `${id}-agent`, conversation_id: id, agent_id: 'parent-agent', role: 'default', created_at: now(), updated_at: now() })
    ]);
    return { id, input: key => ({ source: { kind: 'command', key: `${id}-${key}` }, conversationId: id, content: `${id} ${key}`,
      leaseOwnerId: `${id}-owner`, hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(base + elapsed + 600000).toISOString() }) };
  }
  async function source(parentTurnId, toolName = 'run_agent') {
    const toolCallId = `child-source-${++sequence}`;
    await app.runtime.effects.createToolCall({ source: { kind: 'internal', key: toolCallId }, toolCallId,
      turnId: parentTurnId, toolName, arguments: { operation: 'spawn', taskName: 'Child', prompt: 'Inspect' } });
    return toolCallId;
  }
  const command = sourceToolCallId => ({ sourceToolCallId, childAgentId: 'child-agent', modelFallback: { providerConfigId: 'provider', model: 'model' },
    prompt: 'Inspect', completionPolicy: 'background', sourceSettlement: 'child_handle',
    leaseOwnerId: `child-driver:${app.database.hostBootId}`, leaseExpiresAt: new Date(base + elapsed + 30000).toISOString(), leaseDurationMs: 30000 });
  const coordinator = options => new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
    turns: app.turns, modelProvider: app.modelProvider, now, leaseDurationMs: 30000,
    agentLoop: { registerFinalOutputObserver() { return () => {}; }, async quiesceNativeCalls() {}, async drive() { assert.fail('unexpected child drive'); } },
    agents: { async resolve() { return { agentId: 'child-agent', agentType: 'worker' }; } },
    modelProfiles: { async initializeConversation(input) { await options?.profile?.(input); return { created: true }; } }
  });
  return { app, now, rows, parent, source, command, coordinator, authority, compileRequests,
    preparation(ms) { preparationMs = ms; },
    async close() { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
  };
}

/** External task observation input; dispatch, readonly selection and wait cleanup are production code. */
export function taskToolsFixture() {
  const events = { spawns: [], sends: [], interrupts: [] }, listeners = new Set(), observed = gate();
  const initialTask = { id: 'task-input', kind: 'turn_intent_revision', classification: 'task', state: 'effective', text: 'Inspect', contentObjectId: 'body', contentType: 'text/plain', sequence: '1', createdAt: '2001-01-01T00:00:00.000Z' };
  const task = { childExecutionId: 'child', answerBridgeId: 'bridge', parentConversationId: 'parent', conversationId: 'child-conversation',
    depth: 1, status: 'active', label: 'Inspect', createdAt: initialTask.createdAt, resumable: true, initialTask,
    currentInputs: [initialTask], queuedInputs: [], timeline: [initialTask], execution: { activeTurnId: 'child-turn' }, result: { deliveries: [], handling: [] } };
  const database = { hostBootId: 'task-host', onCommit(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async snapshot(reads) { return { snapshot: reads.map(read => read.domain === 'Turn' ? { id: read.id, conversation_id: 'parent', status: 'active' }
      : read.domain === 'ToolCall' ? { id: read.id, turn_id: 'parent-turn' } : read.kind === 'list' ? [] : null) }; } };
  const coordinator = new ReliableChildAgentCoordinator({ database,
    effects: { async settleWithoutEffect(input) { return { status: input.status, terminal: { status: input.status, detail: input.detail } }; } },
    children: { async spawn(input) { events.spawns.push(input); assert.fail('readonly spawned work'); },
      async readConversationTaskProjection() { observed.resolve(); return { conversationId: 'parent', snapshotCommitSeq: '1', tasks: [task] }; },
      async send(input) { events.sends.push(input); assert.fail('readonly sent work'); } }
  });
  coordinator.triggerRecoveryPass = () => {};
  coordinator.interruptSubtree = async input => { events.interrupts.push(input); assert.fail('readonly interrupted work'); };
  return { coordinator, task, events, listeners, observed,
    call(args, signal) { return coordinator.dispatch({ turnId: 'parent-turn', modelRequestId: 'request', toolCallId: 'readonly-call', toolName: 'run_agent', arguments: args }, signal); } };
}
