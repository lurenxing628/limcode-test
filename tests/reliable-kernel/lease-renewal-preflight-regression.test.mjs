// Baseline-compatible regression: run this unchanged against both compiled source versions.
// Delays the old lease snapshot response by advancing an injected logical clock, without sleeps.
// The atomic worker candidate has no host snapshot preflight to queue and retains its generation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = await import(pathToFileURL(path.join(compiled, 'backend/reliableKernel/index.js')).href);
const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
const start = Date.parse('2001-01-01T00:00:00.000Z');
const iso = offset => new Date(start + offset).toISOString();

test('renewal does not wait for a host snapshot preflight that consumes its lease lifetime', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-lease-preflight-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const binding = await authority.current();
  const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: 'lease-regression-host' });
  const store = new kernel.ContentAddressedStore(authority, binding);
  let elapsed = 10000;
  const turns = new kernel.TurnControlPlane(database, store, {
    now: () => iso(elapsed),
    authorityCompiler: { async compile() { throw new Error('No model or tool execution in this regression'); } }
  });
  const fence = { id: 'lease', conversationId: 'conversation', turnId: 'turn', ownerId: 'owner', hostBootId: database.hostBootId, generation: 1n };
  try {
    await database.transaction([
      repo('Conversation').insert({ id: fence.conversationId, title: 'Renewal regression', status: 'active', created_at: iso(0), updated_at: iso(0) }),
      repo('Turn').insert({ id: fence.turnId, conversation_id: fence.conversationId, status: 'active', created_at: iso(0), updated_at: iso(0) }),
      repo('ExecutionLease').insert({ id: fence.id, conversation_id: fence.conversationId, turn_id: fence.turnId,
        owner_id: fence.ownerId, host_boot_id: fence.hostBootId, generation: 1n, acquired_at: iso(0), expires_at: iso(30000) })
    ]);
    const snapshot = database.snapshot.bind(database);
    let preflightSnapshots = 0;
    database.snapshot = async reads => {
      const result = await snapshot(reads);
      if (reads.length === 2 && reads[0].domain === 'Turn' && reads[1].domain === 'ExecutionLease') {
        preflightSnapshots += 1;
        elapsed = 41000; // Metadata read waited behind enough indivisible normal jobs to miss TTL.
      }
      return result;
    };
    const result = await turns.renewExecutionLeaseDetailed({ fence, leaseExpiresAt: iso(40000) });
    assert.equal(result.renewed, true, JSON.stringify({ result, preflightSnapshots }));
    assert.equal(preflightSnapshots, 0);
    const [after] = (await snapshot([repo('ExecutionLease').get('lease')])).snapshot;
    assert.equal(after.generation, 1n);
    assert.equal(after.expires_at, iso(40000));
  } finally { await database.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
