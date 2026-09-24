import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiledRoot = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT)
  : path.resolve('dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { projectActiveTurnWorkEnvironment } = require(path.join(compiledRoot, 'backend/reliableKernel/clientProjection.js'));
const Database = require('better-sqlite3');
const authorityType = 'application/vnd.limcode.turn-authority-snapshot+json';
const now = '2026-09-22T00:00:00.000Z';
const policy = (id) => ({ enabled: true, defaultWorkEnvironmentId: id, allowedWorkEnvironmentIds: [id] });

test('active Turn projection reads only selected frozen authority and exports no credentials', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-active-environment-'));
  let database;
  let feed;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    database = await kernel.RuntimeDatabase.open(candidate.authority);
    const store = new kernel.ContentAddressedStore(candidate.authority, candidate.binding);
    const frozen = { workEnvironmentPolicy: policy('inherited-environment'), model: { apiKey: 'must-not-cross-feed' } };
    const selectedAuthority = await store.ingest(database, JSON.stringify(frozen), authorityType);
    const otherAuthority = await store.ingest(database, JSON.stringify({
      workEnvironmentPolicy: policy('other-conversation-environment'), secret: 'other-conversation-secret'
    }), authorityType);
    await database.transaction(['selected', 'other'].map((id) =>
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id, title: id, status: 'active', created_at: now, updated_at: now
      })
    ));

    const frames = [];
    feed = new kernel.BoundedClientFeed(database);
    await feed.connect({ activeConversationId: 'selected', send: frame => frames.push(frame) });
    assert.equal(frames[0].projections.activeConversationWindow.activeTurnWorkEnvironment, null);
    acknowledge(feed, frames[0]);
    await database.transaction([
      ...admitTurn('selected', 'selected-turn', selectedAuthority.id),
      ...admitTurn('other', 'other-turn', otherAuthority.id)
    ]);
    const active = await waitForFrame(frames, 1);
    assert.equal(active.type, 'reliable-kernel.snapshot');
    const expected = { conversationId: 'selected', turnId: 'selected-turn', ...policy('inherited-environment') };
    assert.deepEqual(active.projections.activeConversationWindow.activeTurnWorkEnvironment, expected);
    assert.doesNotMatch(JSON.stringify(active), /must-not-cross-feed|other-conversation-secret|other-conversation-environment/);
    acknowledge(feed, active);

    // A subsequent editable configuration cannot change the already committed authority object.
    frozen.workEnvironmentPolicy = policy('next-turn-environment');
    await store.ingest(database, JSON.stringify(frozen), authorityType);
    const snapshot = await database.clientProjectionSnapshot('selected');
    assert.deepEqual(snapshot.snapshot.activeConversationWindow.activeTurnWorkEnvironment, expected);
    const other = await database.clientProjectionSnapshot('other');
    assert.deepEqual(other.snapshot.activeConversationWindow.activeTurnWorkEnvironment, {
      conversationId: 'other', turnId: 'other-turn', ...policy('other-conversation-environment')
    });
    assert.equal((await database.clientProjectionSnapshot(null)).snapshot.activeConversationWindow.activeTurnWorkEnvironment, null);

    // Completing another Conversation must not refresh or replace this Conversation's projection.
    const beforeOther = frames.length;
    await database.transaction([finishTurn('other-turn')]);
    assert.equal(frames.length, beforeOther);
    await database.transaction([finishTurn('selected-turn')]);
    const terminal = await waitForFrame(frames, 2);
    assert.equal(terminal.type, 'reliable-kernel.snapshot');
    assert.equal(terminal.projections.activeConversationWindow.activeTurnWorkEnvironment, null);
    acknowledge(feed, terminal);
  } finally {
    feed?.close();
    await database?.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('projection reads one active authority, preserves a missing default id, and rejects malformed policy', () => {
  const database = new Database(':memory:');
  database.defaultSafeIntegers(true);
  database.exec(`
    CREATE TABLE turn (id TEXT, conversation_id TEXT, status TEXT, created_at TEXT);
    CREATE TABLE authority_snapshot (id TEXT, turn_id TEXT, content_object_id TEXT, created_at TEXT);
    CREATE TABLE content_object (id TEXT, content_type TEXT, sha256 TEXT, byte_length INTEGER, storage_key TEXT, created_at TEXT);
  `);
  let reads = 0;
  let document = { workEnvironmentPolicy: policy('deleted-environment'), apiKey: 'private-token' };
  const content = { readVerifiedBytes(metadata) {
    reads += 1;
    assert.equal(metadata.id, 'selected-authority-content');
    return Buffer.from(JSON.stringify(document));
  } };
  try {
    database.prepare('INSERT INTO turn VALUES (?, ?, ?, ?)').run('selected-turn', 'selected', 'active', now);
    database.prepare('INSERT INTO turn VALUES (?, ?, ?, ?)').run('old-turn', 'selected', 'terminated', now);
    database.prepare('INSERT INTO turn VALUES (?, ?, ?, ?)').run('other-turn', 'other', 'active', now);
    for (const [turnId, id] of [
      ['selected-turn', 'selected-authority-content'], ['old-turn', 'old-content'], ['other-turn', 'other-content']
    ]) {
      database.prepare('INSERT INTO authority_snapshot VALUES (?, ?, ?, ?)').run(`${turnId}-authority`, turnId, id, now);
      database.prepare('INSERT INTO content_object VALUES (?, ?, ?, ?, ?, ?)').run(id, authorityType, 'a'.repeat(64), 128n, 'unused-verified-by-owner', now);
    }
    const turns = database.prepare('SELECT * FROM turn').all();
    assert.deepEqual(projectActiveTurnWorkEnvironment(database, 'selected', turns, content), {
      conversationId: 'selected', turnId: 'selected-turn', ...policy('deleted-environment')
    });
    assert.equal(reads, 1);
    assert.equal(projectActiveTurnWorkEnvironment(database, 'missing', turns, content), null);
    assert.equal(reads, 1);
    document = { workEnvironmentPolicy: { ...policy('deleted-environment'), allowedWorkEnvironmentIds: [null] } };
    assert.throws(() => projectActiveTurnWorkEnvironment(database, 'selected', turns, content), /non-empty string/);
    document = { workEnvironmentPolicy: null };
    assert.equal(projectActiveTurnWorkEnvironment(database, 'selected', turns, content), null);
    database.prepare('UPDATE content_object SET byte_length = ? WHERE id = ?').run(17n * 1024n * 1024n, 'selected-authority-content');
    const beforeOversized = reads;
    assert.throws(() => projectActiveTurnWorkEnvironment(database, 'selected', turns, content), /read bound/);
    assert.equal(reads, beforeOversized);
  } finally {
    database.close();
  }
});

function admitTurn(conversationId, turnId, contentObjectId) {
  return [
    kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
      id: turnId, conversation_id: conversationId, status: 'active', created_at: now, updated_at: now, terminal_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({
      id: `${turnId}-authority`, turn_id: turnId, content_object_id: contentObjectId, created_at: now
    })
  ];
}

function finishTurn(turnId) {
  return kernel.DOMAIN_REPOSITORIES.domain('Turn').update(turnId, {
    status: 'terminated', updated_at: now, terminal_at: now
  });
}

function acknowledge(feed, frame) {
  feed.acknowledge({
    type: 'reliable-kernel.ack', sessionId: frame.sessionId, hostBootId: frame.hostBootId, messageSeq: frame.messageSeq
  });
}

async function waitForFrame(frames, index) {
  for (let attempt = 0; attempt < 100 && !frames[index]; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(frames[index], 'active Turn lifecycle must refresh the bounded snapshot');
  return frames[index];
}
