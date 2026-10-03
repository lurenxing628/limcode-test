import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = relative => import(pathToFileURL(path.join(compiled, relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { DatabaseWorkerRequestQueue, DATABASE_WORKER_CRITICAL_BURST } = await load('backend/reliableKernel/databaseWorkerRequestQueue.js');
const { decideExecutionLeaseRenewal, executionLeaseRenewalNow } = await load('backend/reliableKernel/executionLeaseRenewal.js');
const { runWithExecutionLeaseFence } = await load('backend/reliableKernel/executionLeaseFence.js');
const { withRuntimeMaintenance } = await load('backend/reliableKernel/runtimeHostControl.js');
const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
const EPOCH = Date.parse('2001-01-01T00:00:00.000Z');
const iso = offset => new Date(EPOCH + offset).toISOString();
const target = { id: 'lease', conversationId: 'conversation', turnId: 'turn', ownerId: 'owner', hostBootId: 'host', generation: 1n };
const turn = { id: target.turnId, conversation_id: target.conversationId, status: 'active' };
const lease = (offset = 30000) => ({ id: target.id, conversation_id: target.conversationId, turn_id: target.turnId,
  owner_id: target.ownerId, host_boot_id: target.hostBootId, generation: target.generation,
  acquired_at: iso(0), expires_at: iso(offset) });
const input = (expires = 60000) => ({ fence: target, leaseExpiresAt: iso(expires),
  clock: { now: iso(0), sampledAtNs: 0n, systemClock: false } });

function scheduled(execute) {
  const turns = [];
  const queue = new DatabaseWorkerRequestQueue(execute, run => turns.push(run));
  return { queue, turns, step() { assert.ok(turns.length); turns.shift()(); }, drain() { while (turns.length) turns.shift()(); } };
}

test('critical renewal beats cumulative normal backlog: deterministic FIFO red / critical-lane green', () => {
  // Actual production decision and queue; each indivisible normal job consumes 5 seconds of a
  // logical clock. This proves order/expiry, not a machine-dependent speed benchmark.
  const run = priority => {
    let elapsedMs = 10000; // Renewal is due with 20 seconds of the original 30-second lease left.
    let result;
    const order = [];
    const execute = request => {
      order.push(request.id);
      if (request.kind === 'renewExecutionLease') result = decideExecutionLeaseRenewal(input(), turn, [lease()], 'host', EPOCH + elapsedMs);
      else elapsedMs += 5000;
    };
    const requests = Array.from({ length: 6 }, (_, id) => ({ kind: 'transaction', id }));
    requests.push({ kind: 'renewExecutionLease', id: 'renewal' });
    if (priority) { const q = scheduled(execute); requests.forEach(r => q.queue.enqueue(r)); q.drain(); }
    else requests.forEach(execute); // Baseline port.on(message): synchronous FIFO handlers.
    return { result, order };
  };
  assert.equal(run(false).result.reason, 'lease_expired');
  const green = run(true);
  assert.equal(green.result.renewed, true);
  assert.equal(green.order[0], 'renewal');
  assert.deepEqual(green.order.slice(1), [0, 1, 2, 3, 4, 5]);
});

test('ordinary FIFO progresses during sustained critical pressure and jobs yield individually', () => {
  const executed = [];
  const q = scheduled(r => executed.push(r.id));
  for (let i = 0; i < 3; i++) q.queue.enqueue({ kind: 'snapshot', id: `normal-${i}` });
  for (let i = 0; i < DATABASE_WORKER_CRITICAL_BURST * 3; i++) q.queue.enqueue({ kind: 'renewExecutionLease', id: `critical-${i}` });
  assert.equal(executed.length, 0);
  assert.equal(q.turns.length, 1);
  q.step();
  assert.equal(executed.length, 1, 'one complete synchronous job per scheduled callback');
  q.drain();
  assert.deepEqual(executed.filter(x => x.startsWith('normal')), ['normal-0', 'normal-1', 'normal-2']);
  for (let i = 0; i < 3; i++) assert.equal(executed.indexOf(`normal-${i}`), (i + 1) * DATABASE_WORKER_CRITICAL_BURST + i);
  assert.ok(q.queue.ordinary.every(x => x === undefined), 'completed payloads are released immediately');
  assert.ok(q.queue.critical.every(x => x === undefined));
});

for (const boundary of ['close', 'maintenanceBegin', 'maintenanceAppend', 'maintenanceCommit', 'maintenanceRollback']) {
  test(`${boundary} is a two-sided queue barrier`, () => {
    const order = [];
    const q = scheduled(r => order.push(r.id));
    [ ['snapshot', 'before-normal'], ['renewExecutionLease', 'before-critical'], [boundary, 'barrier'],
      ['snapshot', 'after-normal'], ['renewExecutionLease', 'after-critical'] ]
      .forEach(([kind, id]) => q.queue.enqueue({ kind, id }));
    q.drain();
    assert.deepEqual(order, ['before-critical', 'before-normal', 'barrier', 'after-critical', 'after-normal']);
  });
}

test('closing the scheduler drops all later work from both lanes', () => {
  const order = [];
  const q = scheduled(r => { order.push(r.id); if (r.kind === 'close') q.queue.close(); });
  q.queue.enqueue({ kind: 'close', id: 'close' });
  q.queue.enqueue({ kind: 'renewExecutionLease', id: 'late-critical' });
  q.queue.enqueue({ kind: 'snapshot', id: 'late-normal' });
  q.drain();
  assert.deepEqual(order, ['close']);
});

test('clock includes pre-reception and lock elapsed time without replacing an injected epoch', () => {
  const clock = { now: iso(0), sampledAtNs: 10_000_000n, systemClock: false };
  assert.equal(executionLeaseRenewalNow(clock, 40_010_000_000n, Date.now()), EPOCH + 40000);
  assert.equal(decideExecutionLeaseRenewal(input(), turn, [lease()], 'host', executionLeaseRenewalNow(clock, 40_010_000_000n)).reason, 'lease_expired');
  assert.equal(executionLeaseRenewalNow({ ...clock, systemClock: true }, 20_000_000n, EPOCH + 50000), EPOCH + 50000);
  assert.equal(executionLeaseRenewalNow({ ...clock, systemClock: true }, 20_000_000n, EPOCH - 50000), EPOCH + 10);
  assert.throws(() => executionLeaseRenewalNow(clock, 9_000_000n), /monotonic/);
});

test('atomic decision rejects genuinely expired, terminal, missing, replaced and foreign authority', () => {
  const decide = (changes = {}) => decideExecutionLeaseRenewal(changes.input ?? input(), changes.turn ?? turn,
    changes.leases ?? [lease()], changes.host ?? 'host', changes.now ?? EPOCH + 10000);
  assert.equal(decide({ now: EPOCH + 30000 }).reason, 'lease_expired');
  assert.equal(decide({ now: EPOCH + 60000 }).reason, 'requested_expiry_not_future');
  assert.equal(decide({ turn: { ...turn, status: 'terminated' } }).reason, 'fence_replaced');
  assert.equal(decide({ leases: [] }).reason, 'lease_missing');
  assert.equal(decide({ leases: [{ ...lease(), generation: 2n }] }).reason, 'fence_replaced');
  assert.equal(decide({ host: 'foreign-or-dead-host' }).reason, 'fence_replaced');
  assert.equal(decide({ input: { ...input(), fence: { ...target, ownerId: 'wrong' } } }).reason, 'fence_replaced');
  assert.equal(decide({ leases: [lease(90000)] }).renewedExpiresAt, iso(90000));
  assert.throws(() => decide({ leases: [{ ...lease(), acquired_at: 'not-a-timestamp' }] }), /ExecutionLease.acquired_at/);
});

async function withDatabase(verify, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-lease-renewal-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const binding = await authority.current();
  const open = async () => {
    const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: 'host', ...(options.maintenance ? { maintenance: true } : {}) });
    try {
      await database.transaction([
        repo('Conversation').insert({ id: 'conversation', title: 'Lease test', status: 'active', created_at: iso(0), updated_at: iso(0) }),
        repo('Turn').insert({ ...turn, created_at: iso(0), updated_at: iso(0) }),
        repo('ExecutionLease').insert(lease(options.expiry ?? 30000))
      ]);
      const renewInput = () => ({ ...input(), clock: { now: iso(0), sampledAtNs: process.hrtime.bigint(), systemClock: false } });
      await verify({ database, authority, binding, renewInput });
    } finally { await database.close(); }
  };
  try {
    if (options.maintenance) await withRuntimeMaintenance(binding.paths, open);
    else await open();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

const currentLease = async database => (await database.snapshot([repo('ExecutionLease').get('lease')])).snapshot[0];

test('real worker renewal uses one request, publishes its commit, and keeps the longest concurrent expiry', async () => {
  await withDatabase(async ({ database, renewInput }) => {
    const commits = [];
    const unsubscribe = database.onCommit(commit => commits.push(commit));
    const submitted = [];
    const send = database.sendRequest.bind(database);
    database.sendRequest = request => { submitted.push(request.kind); return send(request); };
    const results = await Promise.all([
      database.renewExecutionLease(renewInput()),
      database.renewExecutionLease({ ...renewInput(), leaseExpiresAt: iso(90000) })
    ]);
    assert.ok(results.every(result => result.renewed));
    assert.deepEqual(submitted.filter(kind => ['renewExecutionLease', 'snapshot', 'transaction'].includes(kind)),
      ['renewExecutionLease', 'renewExecutionLease']);
    assert.equal((await currentLease(database)).expires_at, iso(90000));
    assert.equal(commits.length, 2);
    assert.ok(commits.every(commit => commit.changes.some(change => change.domain === 'ExecutionLease' && change.id === 'lease')));
    assert.ok(BigInt(commits[1].commitSeq) > BigInt(commits[0].commitSeq));
    unsubscribe();
  });
});

test('stale inherited source fence refuses renewal of a separately valid target', async () => {
  await withDatabase(async ({ database, renewInput }) => {
    const source = { ...target, id: 'source-lease', turnId: 'source-turn', conversationId: 'source-conversation' };
    await database.transaction([
      repo('Conversation').insert({ id: source.conversationId, title: 'Source', status: 'active', created_at: iso(0), updated_at: iso(0) }),
      repo('Turn').insert({ ...turn, id: source.turnId, conversation_id: source.conversationId, created_at: iso(0), updated_at: iso(0) }),
      repo('ExecutionLease').insert({ ...lease(), id: source.id, conversation_id: source.conversationId, turn_id: source.turnId, generation: 2n })
    ]);
    await database.conversationOwners.run(source.conversationId, async () => {
      await assert.rejects(runWithExecutionLeaseFence(source, () => database.renewExecutionLease(renewInput())), /generation.*no longer authorizes/);
    });
    assert.equal((await currentLease(database)).expires_at, iso(30000));
  });
});

test('target foreign Host identity is refused even when the captured row matches exactly', async () => {
  await withDatabase(async ({ database, renewInput }) => {
    await database.transaction([repo('ExecutionLease').update('lease', { host_boot_id: 'dead-foreign-host' })]);
    const result = await database.renewExecutionLease({ ...renewInput(), fence: { ...target, hostBootId: 'dead-foreign-host' } });
    assert.equal(result.reason, 'fence_replaced');
    assert.equal((await currentLease(database)).expires_at, iso(30000));
  });
});

test('root-validation and Host-heartbeat failures refuse renewal before worker admission', async () => {
  await withDatabase(async ({ database, authority, renewInput }) => {
    const validate = authority.validate;
    authority.validate = async () => { throw new Error('test root replaced'); };
    await assert.rejects(database.renewExecutionLease(renewInput()), /root replaced/);
    authority.validate = validate;
    database.heartbeatFailure = new Error('test host identity failure');
    await assert.rejects(database.renewExecutionLease(renewInput()), /Host liveness heartbeat failed/);
    database.heartbeatFailure = undefined;
    assert.equal((await currentLease(database)).expires_at, iso(30000));
  });
});

test('maintenance admission stays before a later critical renewal', async () => {
  await withDatabase(async ({ database, renewInput }) => {
    // sendRequest is used only here to submit both messages in a deterministic port order.
    const begin = database.sendRequest({ kind: 'maintenanceBegin' });
    const renewal = database.sendRequest({ kind: 'renewExecutionLease', input: renewInput() });
    const rejected = assert.rejects(renewal, /maintenance transaction is open.*renewExecutionLease is refused/);
    await begin;
    await rejected;
    await database.maintenanceRollback();
    assert.equal((await currentLease(database)).expires_at, iso(30000));
  }, { maintenance: true });
});

test('graceful close settles requests submitted after its barrier in either lane', async () => {
  await withDatabase(async ({ database, renewInput }) => {
    const send = database.sendRequest.bind(database);
    let late;
    database.sendRequest = request => {
      const result = send(request);
      if (request.kind === 'close') late = Promise.allSettled([
        send({ kind: 'renewExecutionLease', input: renewInput() }),
        send({ kind: 'snapshot', reads: [] })
      ]);
      return result;
    };
    await database.close();
    const outcomes = await late;
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every(result => result.status === 'rejected'));
  });
});

test('unexpected worker exit settles pending promises from both queues', async () => {
  await withDatabase(async ({ database, renewInput }) => {
    const pending = Promise.allSettled(Array.from({ length: 100 }, (_, i) => database.sendRequest(i % 2
      ? { kind: 'renewExecutionLease', input: renewInput() }
      : { kind: 'snapshot', reads: [] })));
    await database.worker.terminate();
    const outcomes = await pending;
    assert.equal(outcomes.length, 100);
    assert.ok(outcomes.some(result => result.status === 'rejected'));
  });
});

async function holdWriteLock(databasePath) {
  const child = spawn(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
  `, databasePath], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error(stderr || 'lock helper exited'); })]);
  let released = false;
  return { async release() {
    if (!released) { released = true; if (child.exitCode === null) child.stdin.end('release'); }
    await exited;
  } };
}

test('actual worker selects a renewal before an already submitted ordinary backlog drains', { timeout: 10000 }, async () => {
  await withDatabase(async ({ database, binding, renewInput }) => {
    const lock = await holdWriteLock(binding.paths.databasePath);
    const order = [];
    try {
      const blocker = database.sendRequest({ kind: 'transaction', steps: [repo('Conversation').update('conversation', { title: 'unrelated write' })] });
      const ordinary = Array.from({ length: 40 }, (_, i) => database.sendRequest({ kind: 'snapshot', reads: [repo('Turn').get('turn')] })
        .then(() => { order.push(i); }));
      const renewal = database.sendRequest({ kind: 'renewExecutionLease', input: renewInput() }).then(result => {
        order.push('renewal'); return result;
      });
      await lock.release();
      assert.equal((await renewal).renewed, true);
      await Promise.all([blocker, ...ordinary]);
      assert.ok(order.indexOf('renewal') < 40, `ordinary backlog fully drained before renewal: ${order}`);
      assert.deepEqual(order.filter(id => id !== 'renewal'), Array.from({ length: 40 }, (_, i) => i));
    } finally { await lock.release(); }
  });
});

test('lease expiring during a real SQLite write-lock wait is never revived', { timeout: 10000 }, async () => {
  await withDatabase(async ({ database, binding, renewInput }) => {
    const lock = await holdWriteLock(binding.paths.databasePath);
    try {
      const started = process.hrtime.bigint();
      const request = database.renewExecutionLease(renewInput());
      // Holding a lock past a known logical expiry is the test condition, not a speed threshold.
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.ok(process.hrtime.bigint() - started >= 250_000_000n);
      await lock.release();
      const result = await request;
      assert.equal(result.reason, 'lease_expired');
      assert.equal((await currentLease(database)).expires_at, iso(250));
    } finally { await lock.release(); }
  }, { expiry: 250 });
});
