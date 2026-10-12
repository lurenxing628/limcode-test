import { createOwnershipScope } from './ownership-scope-fixture.mjs';
// Focused production ownership boundary; old review matrices are absent.
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

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

async function withDatabase(verify, options = {}) {
  const { outer: directory, authority, binding } = await createOwnershipScope('renewal');
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

const boundary = 'maintenanceBegin';

export const scenario1 = () => {
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
};

export const scenario2 = () => {
    const order = [];
    const q = scheduled(r => order.push(r.id));
    [ ['snapshot', 'before-normal'], ['renewExecutionLease', 'before-critical'], [boundary, 'barrier'],
      ['snapshot', 'after-normal'], ['renewExecutionLease', 'after-critical'] ]
      .forEach(([kind, id]) => q.queue.enqueue({ kind, id }));
    q.drain();
    assert.deepEqual(order, ['before-critical', 'before-normal', 'barrier', 'after-critical', 'after-normal']);
  };

export const scenario3 = async () => {
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
    await database.transaction([repo('ExecutionLease').update('lease', { expires_at: iso(-1) })]);
    const expired = await database.renewExecutionLease(renewInput());
    assert.equal(expired.renewed, false);
    assert.equal(expired.reason, 'lease_expired');
    unsubscribe();
  });
};
