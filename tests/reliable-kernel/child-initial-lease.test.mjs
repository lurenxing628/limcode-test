import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = load('index.js');
const { ReliableChildAgentCoordinator } = load('childAgentCoordinator.js');
const { runWithExecutionLeaseFence, currentExecutionLeaseFence, ExecutionHandoffError } = load('executionLeaseFence.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const BASE = Date.parse('2001-01-01T00:00:00.000Z');
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check) { for (let i = 0; i < 400; i++) { if (await check()) return; await wait(10); } assert.fail('Expected lifecycle event was not observed'); }
function authority(request) {
  return { kind: 'effective-turn-authority', turnId: request.turnId, conversationId: request.conversationId,
    executorAgentId: request.executorAgentId, model: { providerConfigId: 'provider', provider: 'openai-compatible', modelId: 'model', retryPolicy: { enabled: false, maxRetries: 0 } },
    modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
    toolPolicy: { id: 'tools', allowedTools: ['run_agent'], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
    planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
    runtimeContext: { id: null, name: '', template: '' },
    workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null } };
}
async function fixture(run, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-initial-lease-'));
  let elapsed = 0;
  const now = () => new Date(BASE + elapsed).toISOString();
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  const app = await kernel.ReliableKernelApplication.open(root, {
    now,
    authorityCompiler: { async compile(request) {
      if (request.conversationId !== 'parent') elapsed += options.preparationMs ?? 0;
      return { turnId: request.turnId, executorAgentId: request.executorAgentId,
        executionPreset: { content: JSON.stringify({ providerConfigId: 'provider', modelId: 'model' }) },
        authoritySnapshot: { content: JSON.stringify(authority(request)) } };
    } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('No MCP'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { throw new Error('No provider requests in initial-lease tests'); } },
    toolDispatcher: { definitions() { return []; }, async dispatch() { throw new Error('No external tools'); } }
  });
  const rows = async (domain, where = {}) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
  const coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
    turns: app.turns, modelProvider: app.modelProvider, now, leaseDurationMs: options.durationMs ?? 30000,
    agentLoop: { registerFinalOutputObserver() { return () => {}; }, async quiesceNativeCalls() {},
      async drive(turnId) { await options.drive?.(turnId); return { turnId, terminalStatus: 'waiting', modelRequestIds: [], assistantMessageIds: [], toolCallIds: [] }; } },
    agents: { async resolve() { return { agentId: 'child-agent', agentType: 'worker' }; } },
    modelProfiles: { async initializeConversation(value) { await options.profile?.(value); return { created: true }; } }
  });
  let counter = 0;
  try {
    await app.database.transaction([
      repo('Conversation').insert({ id: 'parent', title: 'Parent', status: 'active', created_at: now(), updated_at: now() }),
      repo('AgentConversationLink').insert({ id: 'parent-agent', conversation_id: 'parent', agent_id: 'parent-agent', role: 'default', created_at: now(), updated_at: now() })
    ]);
    const parent = await app.turns.input({ source: { kind: 'command', key: 'parent-input' }, conversationId: 'parent', content: 'Delegate',
      leaseOwnerId: 'parent-owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(BASE + 600000).toISOString() });
    const sourceFence = await app.turns.executionLeaseFence({ turnId: parent.turnId, leaseOwnerId: 'parent-owner', hostBootId: app.database.hostBootId });
    async function source() {
      const toolCallId = `source-${++counter}`;
      await app.runtime.effects.createToolCall({ source: { kind: 'internal', key: toolCallId }, toolCallId,
        turnId: parent.turnId, toolName: 'run_agent', arguments: { operation: 'spawn', taskName: 'Child', prompt: 'Inspect' } });
      return toolCallId;
    }
    async function command(relative = true) {
      return { sourceToolCallId: await source(), childAgentId: 'child-agent', modelFallback: { providerConfigId: 'provider', model: 'model' },
        prompt: 'Inspect', completionPolicy: 'background', sourceSettlement: 'child_handle',
        leaseOwnerId: `child-driver:${app.database.hostBootId}`, leaseExpiresAt: new Date(BASE + elapsed + (options.durationMs ?? 30000)).toISOString(),
        ...(relative ? { leaseDurationMs: options.durationMs ?? 30000 } : {}) };
    }
    const startCoordinator = async () => {
      const toolCallId = await source();
      return runWithExecutionLeaseFence(sourceFence, () => coordinator.spawnChild({ toolCallId, turnId: parent.turnId, toolName: 'run_agent' },
        { taskName: 'Child' }, 'Inspect', 0, { document: authority({ turnId: parent.turnId, conversationId: 'parent', executorAgentId: 'parent-agent' }) }));
    };
    await run({ app, coordinator, rows, source, command, startCoordinator, sourceFence, now, advance: ms => { elapsed += ms; } });
  } finally { await coordinator.dispose(); await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

test('fresh child lease duration starts after delayed preparation, with its exact committed fence', async () => {
  await fixture(async f => {
    const command = await f.command();
    const result = await runWithExecutionLeaseFence(f.sourceFence, () => f.app.runtime.children.spawn(command));
    const [lease] = await f.rows('ExecutionLease', { turn_id: result.childTurnId });
    assert.ok(Date.parse(lease.expires_at) > Date.parse(f.now()), 'new child was born with an already expired lease');
    assert.equal(Date.parse(lease.expires_at) - Date.parse(lease.acquired_at), 30000);
    assert.ok(Date.parse(lease.acquired_at) >= BASE + 31000);
    assert.equal(result.initialExecutionFence.generation, 1n);
    assert.equal(result.initialExecutionFence.id, lease.id);
    const before = { ...lease };
    const replay = await f.app.runtime.children.spawn(command);
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.initialExecutionFence, undefined, 'replay must not synthesize generation 1');
    assert.deepEqual((await f.rows('ExecutionLease', { id: lease.id }))[0], before);
  }, { preparationMs: 31000 });
});

test('explicit absolute expiry is preserved rather than silently extended', async () => {
  await fixture(async f => {
    const command = await f.command(false);
    const result = await f.app.runtime.children.spawn(command);
    const [lease] = await f.rows('ExecutionLease', { turn_id: result.childTurnId });
    assert.equal(lease.expires_at, command.leaseExpiresAt);
  }, { preparationMs: 31000 });
});

test('child continuation receives a fresh lifetime after its own preparation', async () => {
  await fixture(async f => {
    const spawned = await f.app.runtime.children.spawn(await f.command());
    await f.app.runtime.children.claimSpawnDispatch(spawned.effectIntentId);
    const receipt = await f.app.runtime.children.recordSpawnReceipt({ sourceKey: 'receipt', attemptId: spawned.attemptId, outcome: 'succeeded' });
    await f.app.runtime.children.reconcileSpawnReceipt(receipt.effectReceiptId);
    await f.app.turns.terminal({ source: { kind: 'internal', key: 'finish-first' }, turnId: spawned.childTurnId, terminalStatus: 'completed', reason: 'fixture completion' });
    await f.app.runtime.children.observeTurnTerminal(spawned.childExecutionId, spawned.childTurnId);
    const sent = await f.app.runtime.children.send({ sourceKey: 'followup', sourceToolCallId: await f.source(), childExecutionId: spawned.childExecutionId,
      mode: 'queue_next_turn', content: 'Continue', completionPolicy: 'background' });
    const expires = new Date(Date.parse(f.now()) + 30000).toISOString();
    const admitted = await f.app.runtime.children.admitQueuedIntent({ sourceKey: 'admit', childExecutionId: spawned.childExecutionId,
      turnIntentId: sent.turnIntentId, leaseOwnerId: `child-driver:${f.app.database.hostBootId}`, leaseExpiresAt: expires, leaseDurationMs: 30000 });
    const [lease] = await f.rows('ExecutionLease', { turn_id: admitted.turnId });
    assert.ok(Date.parse(lease.expires_at) > Date.parse(f.now()));
    assert.equal(Date.parse(lease.expires_at) - Date.parse(lease.acquired_at), 30000);
    assert.equal(admitted.initialExecutionFence.id, lease.id);
  }, { preparationMs: 31000 });
});

test('stale inherited parent fence rolls the whole new child grant back', async () => {
  await fixture(async f => {
    const command = await f.command();
    await f.app.database.transaction([repo('ExecutionLease').update(f.sourceFence.id, { generation: 2n })]);
    await assert.rejects(runWithExecutionLeaseFence(f.sourceFence, () => f.app.runtime.children.spawn(command)), /generation|assertion/);
    assert.equal((await f.rows('ChildExecution')).length, 0);
    assert.equal((await f.rows('ExecutionLease')).length, 1);
  });
});

test('startup renews before profile setup and transfers the same timer into drive', async () => {
  const entered = gate(), release = gate(); let f, resource, stopCalls = 0, renewals = 0, sourceTurns = [];
  await fixture(async value => {
    f = value;
    const renew = f.app.turns.renewExecutionLease.bind(f.app.turns);
    f.app.turns.renewExecutionLease = async input => { sourceTurns.push(currentExecutionLeaseFence()?.turnId); const result = await renew(input); renewals++; return result; };
    const started = f.startCoordinator();
    try {
      await Promise.race([entered.promise, started.then(() => { throw new Error('Startup ended before profile setup'); })]);
      assert.ok(renewals >= 1, 'profile initialization must not precede the first renewal');
      assert.equal(f.coordinator.childLeaseRenewals.size, 1);
      resource = [...f.coordinator.childLeaseRenewals][0];
      const stop = resource.stop; resource.stop = () => { stopCalls++; return stop(); };
      for (let i = 0; i < 2; i++) { const observed = renewals; f.advance(2000); await eventually(() => renewals > observed); }
      assert.equal((await f.rows('ExecutionLease', { id: resource.fence.id }))[0].generation, 1n);
      assert.ok(sourceTurns.every(turnId => turnId === resource.fence.turnId), 'timer must carry child authority, not its parent source');
      release.resolve(); await started; await f.coordinator.waitForIdle();
      assert.equal(stopCalls, 1, 'startup ownership transfers once and the drive stops it once');
      assert.equal(f.coordinator.childLeaseRenewals.size, 0);
    } finally { release.resolve(); await started.catch(() => {}); }
  }, { durationMs: 3000, profile: async () => { entered.resolve(); await release.promise; }, drive: async () => {
    assert.equal([...f.coordinator.childLeaseRenewals][0], resource);
  } });
});

test('setup failure stops its renewal without launching or leaking a timer', async () => {
  await fixture(async f => {
    await assert.rejects(f.startCoordinator(), /profile failed/);
    assert.equal(f.coordinator.childLeaseRenewals.size, 0);
    assert.equal(f.coordinator.activeTurns.size, 0);
    assert.equal(f.coordinator.startupOperations.size, 0);
  }, { profile: async () => { throw new Error('profile failed'); }, drive: async () => { assert.fail('setup failure launched a child'); } });
});

test('disposal drains in-flight startup and no stopped token reaches drive', async () => {
  const entered = gate(), release = gate();
  await fixture(async f => {
    const started = f.startCoordinator(); const settled = started.catch(error => error);
    await Promise.race([entered.promise, started.then(() => { throw new Error('Startup ended before profile setup'); })]);
    let disposed = false; const disposing = f.coordinator.dispose().then(() => { disposed = true; });
    await wait(20); assert.equal(disposed, false, 'dispose must drain the admitted setup');
    release.resolve(); await disposing;
    assert.ok((await settled) instanceof Error);
    assert.equal(f.coordinator.childLeaseRenewals.size, 0);
    assert.equal(f.coordinator.startupOperations.size, 0);
  }, { profile: async () => { entered.resolve(); await release.promise; }, drive: async () => { assert.fail('disposed setup launched'); } });
});

async function holdLock(databasePath) {
  const child = spawn(process.execPath, ['-e', `const D=require('better-sqlite3');const d=new D(process.argv[1]);d.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');process.stdin.once('data',()=>{d.exec('ROLLBACK');d.close();});`, databasePath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let error = ''; child.stderr.on('data', chunk => { error += chunk; });
  await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error(error || 'lock helper exited'); })]);
  let released = false;
  return { async release() { if (!released) { released = true; child.stdin.end('release'); } await exited; } };
}

test('real SQLite queue/lock delay does not consume a new grant, and duplicate insert cannot revive an existing lease', async () => {
  await fixture(async f => {
    const db = f.app.database, clock = { now: f.now(), sampledAtNs: process.hrtime.bigint(), systemClock: false };
    const now = f.now();
    const row = { id: 'new-lease', conversation_id: 'new-conversation', turn_id: 'new-turn', owner_id: 'new-owner', host_boot_id: db.hostBootId,
      generation: 1n, acquired_at: now, expires_at: new Date(BASE + 250).toISOString() };
    const steps = [repo('Conversation').insert({ id: row.conversation_id, title: 'queue', status: 'active', created_at: now, updated_at: now }),
      repo('Turn').insert({ id: row.turn_id, conversation_id: row.conversation_id, status: 'active', created_at: now, updated_at: now }),
      repo('ExecutionLease').insertWithExecutionLeaseDuration(row, { durationMs: 250, clock })];
    const lock = await holdLock(db.binding.paths.databasePath);
    try {
      const committed = db.transaction(steps); await wait(600); await lock.release(); await committed;
      const [lease] = await f.rows('ExecutionLease', { id: row.id });
      assert.ok(Date.parse(lease.acquired_at) >= BASE + 600);
      assert.equal(Date.parse(lease.expires_at) - Date.parse(lease.acquired_at), 250);
      await assert.rejects(db.transaction([repo('ExecutionLease').insertWithExecutionLeaseDuration(row, {
        durationMs: 30000, clock: { ...clock, sampledAtNs: process.hrtime.bigint(), now: new Date(BASE + 90000).toISOString() }
      })]), /UNIQUE/);
      assert.deepEqual((await f.rows('ExecutionLease', { id: row.id }))[0], lease);
      assert.throws(() => repo('Turn').insertWithExecutionLeaseDuration(row, { durationMs: 1, clock }), /limited/);
      await assert.rejects(db.transaction([repo('ExecutionLease').insertWithExecutionLeaseDuration({ ...row, id: 'foreign', host_boot_id: 'dead-foreign' }, { durationMs: 30000, clock })]), /local first-generation/);
    } finally { await lock.release(); }
  });
});

test('disposal before the admitted startup microtask prevents any startup work', async () => {
  await fixture(async f => {
    let calls = 0;
    const task = f.coordinator.runChildStartup(async () => { calls++; });
    const settled = task.catch(error => error);
    await f.coordinator.dispose();
    assert.ok((await settled) instanceof Error);
    assert.equal(calls, 0);
    assert.equal(f.coordinator.startupOperations.size, 0);
  });
});

test('expiry before owner claim does not revive g1 or hand off the still-valid parent', async () => {
  await fixture(async f => {
    const spawned = await f.app.runtime.children.spawn(await f.command());
    const [before] = await f.rows('ExecutionLease', { turn_id: spawned.childTurnId });
    const owners = f.app.database.conversationOwners;
    const claim = owners.tryClaimEligible.bind(owners);
    owners.tryClaimEligible = async id => { f.advance(1000); return claim(id); };
    let recovery = 0; f.coordinator.triggerRecoveryPass = () => { recovery++; };
    const resource = await runWithExecutionLeaseFence(f.sourceFence, () => f.coordinator.prepareChildLease(spawned.initialExecutionFence));
    assert.equal(resource, null, 'lost exact authority is distinct from replay/no-fence admission');
    assert.equal(f.coordinator.childLeaseRenewals.size, 0);
    assert.deepEqual((await f.rows('ExecutionLease', { id: before.id }))[0], before);
    assert.ok(await f.app.turns.executionLeaseFence({ turnId: f.sourceFence.turnId, leaseOwnerId: 'parent-owner', hostBootId: f.app.database.hostBootId }));
  }, { durationMs: 250 });
});
