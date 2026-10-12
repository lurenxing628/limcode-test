import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import * as entry from './fixtures/ownership-entry-fixture.mjs';
import * as folder from './fixtures/ownership-folder-fixture.mjs';
import * as release from './fixtures/ownership-release-fixture.mjs';
import * as hosts from './fixtures/ownership-host-fixture.mjs';
import * as delivery from './fixtures/ownership-delivery-fixture.mjs';
import * as quiescence from './fixtures/ownership-quiescence-fixture.mjs';
import * as continuation from './fixtures/ownership-continuation-fixture.mjs';
import * as maintenance from './fixtures/ownership-maintenance-fixture.mjs';
import * as renewal from './fixtures/ownership-renewal-fixture.mjs';
import * as panel from './fixtures/ownership-panel-fixture.mjs';
import { createBehaviorRuntime, load } from './fixtures/runtime-behavior-fixture.mjs';
const { GlobalSettingsSaveBarrier } = load('backend/application/reliableKernel/GlobalSettingsSaveBarrier.js');

test('execution eligibility uses frozen project and environment facts before writing input', entry.scenario1);
test('another live window can answer controls without taking execution ownership', entry.scenario2);
test('dead Host handoff gives one eligible window a fresh durable owner token', entry.scenario3);
test('removing the project folder hands execution back at a round boundary', folder.scenario1);
test('failed owner release revokes local authority and retries the exact token', release.scenario1);
test('stale execution generations cannot commit model callbacks or writes', hosts.scenario2);

test('application close fences its worker and retries only failed owner cleanup', async () => {
  const f = await createBehaviorRuntime('owner-close');
  const database = f.app.database, ownerClose = database.conversationOwners.close.bind(database.conversationOwners);
  const hostRecord = database.hostLivenessPath(database.hostBootId);
  const failure = Object.assign(new Error('Temporary owner cleanup failure'), { code: 'EACCES' });
  let cleanups = 0, disposals = 0;
  const dispose = f.app.processes.dispose.bind(f.app.processes);
  f.app.processes.dispose = async (...args) => { disposals += 1; return dispose(...args); };
  database.conversationOwners.close = async () => { if (++cleanups === 1) throw failure; return ownerClose(); };
  try {
    const first = f.app.close(); assert.equal(f.app.close(), first);
    await assert.rejects(first, error => error === failure);
    assert.equal(database.worker.threadId, -1); await assert.rejects(database.inspect(), /closed/);
    await assert.rejects(fs.access(hostRecord), { code: 'ENOENT' });
    await f.app.close(); assert.equal(cleanups, 2); assert.equal(disposals, 1);
    await f.app.close(); assert.equal(cleanups, 2);
  } finally { database.conversationOwners.close = ownerClose; await f.close(); }
});

test('abandonment leaves deliveries unchanged while another live window owns them', delivery.scenario1);
test('lease handback waits for this Turn native calls before relinquishing authority', quiescence.scenario1);
test('Phase D waits for the live dispatcher result without recording unknown outcome', quiescence.scenario2);
test('unacknowledged continuation wake hands back an unusable owner', continuation.scenario1);
test('maintenance input freezes the environment approved for its executor Agent', maintenance.scenario1);
test('a maintenance Turn made ineligible after admission terminates without a model call', maintenance.scenario2);
test('critical renewals preserve progress of the ordinary FIFO queue', renewal.scenario1);
test('maintenance admission is a two sided worker queue barrier', renewal.scenario2);
test('worker renewal keeps the latest expiry and never revives an expired lease', renewal.scenario3);
test('a passive panel reads committed facts without releasing peer ownership', panel.scenario1);

test('a replacement settings session invalidates old clean and flush acknowledgments', async () => {
  const barrier = new GlobalSettingsSaveBarrier(1000), messages = [];
  const attach = sessionId => barrier.attach('panel', { postMessage: async message => { messages.push(message); return true; } }, sessionId);
  attach('old-session'); barrier.observe('panel', { sessionId: 'old-session', revision: 1, state: 'dirty' });
  const first = barrier.flush(); const rejected = assert.rejects(first, /重新连接/);
  await new Promise(setImmediate);
  const old = messages[0]; attach('new-session');
  barrier.receive('panel', old.id, { status: 'saved', activity: { sessionId: 'old-session', revision: 2, state: 'clean' } });
  await rejected;
  const next = barrier.flush('panel'); await new Promise(setImmediate);
  const latest = messages.at(-1); assert.notEqual(latest.id, old.id);
  barrier.receive('panel', latest.id, { status: 'saved', activity: { sessionId: 'new-session', revision: 1, state: 'clean' } });
  await next; await barrier.flush('panel'); assert.equal(messages.length, 2);
});
