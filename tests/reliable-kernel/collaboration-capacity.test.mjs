import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = name => require(path.join(compiled, 'backend/reliableKernel', name));
const { RootAuthority } = load('rootAuthority.js');
const { RuntimeDatabase, initializeEmptyRuntimeRoot } = load('runtimeDatabase.js');
const { ContentAddressedStore } = load('contentAddressedStore.js');
const { preparedContentObjectSteps } = load('contentObjectTransaction.js');
const { DOMAIN_REPOSITORIES } = load('repositories.js');
const { prepareCollaborationCapacity, CollaborationCapacityError } = load('collaborationCapacity.js');
const { frozenCollaborationLimits } = load('collaborationPolicy.js');
const repo = name => DOMAIN_REPOSITORIES.domain(name);
const now = '2026-09-22T00:00:00.000Z';

async function fixture(maximum, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-capacity-'));
  const authority = new RootAuthority(() => path.join(directory, 'runtime'));
  await initializeEmptyRuntimeRoot(authority);
  const database = await RuntimeDatabase.open(authority);
  const store = new ContentAddressedStore(authority, database.binding);
  const content = await store.prepare(database, JSON.stringify({ toolPolicy: { toolConfigs: {
    run_agent: { config: { maxConcurrentAgents: maximum, maxAutomaticFollowups: 0 } }
  } } }), 'application/json');
  const child = (id, active = true) => [
    repo('Conversation').insert({ id, title: id, status: 'active', created_at: now, updated_at: now }),
    repo('ChildExecution').insert({ id: `${id}-child`, child_conversation_id: id,
      status: active ? 'starting' : 'idle', created_at: now, updated_at: now }),
    repo('ChildExecutionParentLink').insert({ id: `${id}-parent`, child_execution_id: `${id}-child`,
      source_tool_call_id: `${id}-spawn`, parent_child_execution_id: null, parent_turn_id: 'root-turn', created_at: now }),
    ...(active ? [repo('Turn').insert({ id: `${id}-turn`, conversation_id: id, status: 'active',
      created_at: now, updated_at: now, terminal_at: null })] : [])
  ];
  try {
    await database.transaction([
      ...preparedContentObjectSteps([content], 'capacity_policy'),
      repo('Conversation').insert({ id: 'root', title: 'root', status: 'active', created_at: now, updated_at: now }),
      repo('Turn').insert({ id: 'root-turn', conversation_id: 'root', status: 'active', created_at: now, updated_at: now, terminal_at: null }),
      repo('AuthoritySnapshot').insert({ id: 'root-authority', turn_id: 'root-turn', content_object_id: content.metadata.id, created_at: now })
    ]);
    await run({ database, store, child, reserve: (conversationId = 'root') =>
      prepareCollaborationCapacity(database, store, conversationId, 'root-turn') });
  } finally {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('capacity includes reserved child starts, excludes root and idle members, and reads frozen user limits', async () => {
  await fixture(2, async f => {
    await f.database.transaction([...(await f.reserve()), ...f.child('one')]);
    await f.database.transaction(f.child('idle', false));
    await f.database.transaction([...(await f.reserve('idle')), ...f.child('two')]);
    await assert.rejects(f.reserve(), error => error instanceof CollaborationCapacityError && error.maximum === 2);
  });
});

test('two competing reservations cannot both admit a child beyond the team capacity', async () => {
  await fixture(1, async f => {
    const [left, right] = await Promise.all([f.reserve(), f.reserve()]);
    const attempts = await Promise.allSettled([
      f.database.transaction([...left, ...f.child('left')]),
      f.database.transaction([...right, ...f.child('right')])
    ]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
    const rows = (await f.database.snapshot([repo('ChildExecution').list({ limit: 100 })])).snapshot[0];
    assert.equal(rows.length, 1);
    await assert.rejects(f.reserve(), CollaborationCapacityError);
  });
});

test('frozen policy accepts zero automatic followups and rejects malformed explicit limits', () => {
  assert.deepEqual(frozenCollaborationLimits({ toolPolicy: { toolConfigs: { run_agent: {
    config: { maxConcurrentAgents: 3, maxAutomaticFollowups: 0 }
  } } } }), { maxConcurrentAgents: 3, maxAutomaticFollowups: 0 });
  for (const value of [-1, 0, 1.5, '8']) {
    assert.throws(() => frozenCollaborationLimits({ toolPolicy: { toolConfigs: { run_agent: {
      config: { maxConcurrentAgents: value }
    } } } }), /Invalid frozen/);
  }
});
