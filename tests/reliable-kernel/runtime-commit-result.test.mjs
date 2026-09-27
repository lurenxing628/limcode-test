import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

// A committed transaction reaches the host once: the worker posts its result in the commit message
// and answers the request with a reference to it, so a large merge or relocation transaction is
// not structured-cloned a second time. Callers still get the whole result (TurnControlPlane reads
// its `changes`, several control planes its `allocatedSequences`).

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const NOW = '2026-09-27T00:00:00.000Z';
const repo = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
const conversations = (prefix, count) => Array.from({ length: count }, (_value, index) => repo('Conversation').insert({
  id: `${prefix}-${index}`, title: `会话 ${index}`, status: 'active', created_at: NOW, updated_at: NOW
}));

test('提交结果只克隆一次：调用方拿到的就是提交监听者收到的那份完整结果，应答不再另带一份', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-commit-result-'));
  let database;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(directory);
    database = await kernel.RuntimeDatabase.open(candidate.authority);
    const messages = [];
    database['worker'].on('message', (message) => messages.push(message));
    const seen = [];
    const unsubscribe = database.onCommit((commit) => seen.push(commit));

    const first = await database.transaction(conversations('first', 200));
    assert.equal(seen.length, 1);
    assert.equal(first, seen[0], 'the caller gets the object the listeners received');
    assert.equal(first.changes.length, 200, 'with every change of the commit');
    assert.ok(first.changes.every((change) => change.domain === 'Conversation' && change.kind === 'upsert' && change.record.status === 'active'));
    assert.deepEqual(first.allocatedSequences, []);
    const commitMessage = messages.find((message) => message.type === 'commit' && message.result.commitSeq === first.commitSeq);
    assert.equal(commitMessage.result.changes.length, 200, 'the commit message carries the result once');
    const response = messages.find((message) => message.type === 'response' && message.committed === first.commitSeq);
    assert.ok(response, 'the response names the commit it answers');
    assert.equal(response.result, null, 'and carries no second copy of it');

    // A refused transaction answers with its own error and leaves no stale commit behind.
    await assert.rejects(database.transaction(conversations('first', 1)), /UNIQUE constraint failed: conversation\.id/);
    unsubscribe();
    const second = await database.transaction(conversations('second', 3));
    assert.equal(seen.length, 1, 'an unsubscribed listener sees nothing');
    assert.notEqual(second, first);
    assert.equal(BigInt(second.commitSeq), BigInt(first.commitSeq) + 1n);
    assert.deepEqual(second.changes.map((change) => change.id).sort(), ['second-0', 'second-1', 'second-2']);
  } finally {
    await database?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
