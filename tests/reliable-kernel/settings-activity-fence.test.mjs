import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { GlobalSettingsSaveBarrier } = require('../../dist/extension/backend/application/reliableKernel/GlobalSettingsSaveBarrier.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const activity = (revision, state) => ({ sessionId: 'session', revision, state });
function client(barrier, id) {
  const messages = [];
  barrier.attach(id, { postMessage: async message => { messages.push(message); return true; } }, 'session');
  return messages;
}
test('known-clean sender skips a round-trip; unknown peers still handshake on every execution', async () => {
  const barrier = new GlobalSettingsSaveBarrier(1000);
  const clean = client(barrier, 'clean');
  barrier.observe('clean', activity(1, 'clean'));
  await barrier.flush('clean');
  assert.equal(clean.length, 0);
  const unknown = client(barrier, 'unknown');
  for (let i = 0; i < 2; i++) {
    const flushing = barrier.flush('clean');
    await tick();
    assert.equal(unknown.length, i + 1);
    barrier.receive('unknown', unknown[i].id, { status: 'saved' });
    await flushing;
  }
});
test('stale clean notices and stale flush acknowledgements cannot clear a later edit', async () => {
  const barrier = new GlobalSettingsSaveBarrier(1000);
  const messages = client(barrier, 'editor');
  barrier.observe('editor', activity(1, 'dirty'));
  let finished = false;
  const flushing = barrier.flush().then(() => { finished = true; });
  await tick();
  barrier.observe('editor', activity(3, 'dirty'));
  barrier.observe('editor', activity(2, 'clean'));
  barrier.receive('editor', messages[0].id, { status: 'saved', activity: activity(2, 'clean') });
  await tick();
  assert.equal(finished, false);
  assert.equal(messages.length, 2);
  barrier.receive('editor', messages[1].id, { status: 'saved', activity: activity(4, 'clean') });
  await flushing;
  await barrier.flush('editor');
  assert.equal(messages.length, 2);
});
test('a clean panel becoming dirty while another panel flushes joins the barrier', async () => {
  const barrier = new GlobalSettingsSaveBarrier(1000);
  const a = client(barrier, 'a');
  const b = client(barrier, 'b');
  barrier.observe('a', activity(1, 'clean'));
  const flushing = barrier.flush('a');
  await tick();
  barrier.observe('a', activity(2, 'saving'));
  barrier.receive('b', b[0].id, { status: 'saved' });
  await tick();
  assert.equal(a.length, 1);
  barrier.receive('a', a[0].id, { status: 'saved', activity: activity(3, 'clean') });
  await flushing;
});
test('Ready resets known-clean state and invalidates an outstanding session handshake', async () => {
  const barrier = new GlobalSettingsSaveBarrier(1000);
  client(barrier, 'panel');
  barrier.observe('panel', activity(1, 'clean'));
  const replacement = client(barrier, 'panel');
  const flushing = barrier.flush();
  const rejected = assert.rejects(flushing, /重新连接/);
  await tick();
  client(barrier, 'panel');
  barrier.receive('panel', replacement[0].id, { status: 'saved', activity: activity(2, 'clean') });
  await rejected;
});
test('dirty-only detach remains unknown, failed and undeliverable flushes reject', async () => {
  const barrier = new GlobalSettingsSaveBarrier(30);
  client(barrier, 'panel');
  const flushing = barrier.flush();
  const rejected = assert.rejects(flushing, /状态未知/);
  await tick();
  barrier.detach('panel');
  await rejected;
  const failed = client(barrier, 'failed');
  const failedFlush = barrier.flush();
  const failure = assert.rejects(failedFlush, /save failed/);
  await tick();
  barrier.receive('failed', failed[0].id, { status: 'failed', message: 'save failed' });
  await failure;
  barrier.detach('failed');
  barrier.attach('offline', { postMessage: async () => false });
  await assert.rejects(barrier.flush(), /未收到/);
});

test('another known-clean editable panel still handshakes for a delayed dirty notice', async () => {
  const barrier = new GlobalSettingsSaveBarrier(1000);
  const a = client(barrier, 'a');
  const b = client(barrier, 'b');
  barrier.observe('a', activity(1, 'clean'));
  barrier.observe('b', activity(1, 'clean'));
  let finished = false;
  const flushing = barrier.flush('a').then(() => { finished = true; });
  await tick();
  assert.equal(a.length, 0);
  assert.equal(b.length, 1, 'peer cannot be skipped merely because host has not yet seen its edit');
  barrier.observe('b', activity(2, 'dirty'));
  assert.equal(finished, false);
  barrier.receive('b', b[0].id, { status: 'saved', activity: activity(3, 'clean') });
  await flushing;
});

test('a previous document activity cannot certify the replacement Ready session', async () => {
  const barrier = new GlobalSettingsSaveBarrier(1000);
  const messages = [];
  barrier.attach('panel', { postMessage: async m => { messages.push(m); return true; } }, 'new-document');
  barrier.observe('panel', { sessionId: 'old-document', revision: 100, state: 'clean' });
  const flushing = barrier.flush('panel');
  await tick();
  assert.equal(messages.length, 1);
  barrier.receive('panel', messages[0].id, { status: 'saved', activity: { sessionId: 'new-document', revision: 1, state: 'clean' } });
  await flushing;
  await barrier.flush('panel');
  assert.equal(messages.length, 1);
});

test('flush returns its atomic clean fence rather than the generation observed by a later continuation', async () => {
  const barrier = new GlobalSettingsSaveBarrier(1000);
  client(barrier, 'sender');
  barrier.observe('sender', activity(1, 'clean'));
  const flushing = barrier.flush('sender');
  barrier.observe('sender', activity(2, 'dirty'));
  const certifiedRevision = await flushing;
  assert.notEqual(certifiedRevision, barrier.activityRevision);
});
