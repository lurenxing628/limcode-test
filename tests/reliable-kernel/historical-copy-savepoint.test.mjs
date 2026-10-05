import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

// A ModelStreamFence or ModelStreamCheckpoint may be copied only together with its ModelRequest,
// copied historically in the same transaction. The worker remembers those requests per
// transaction; a savepoint that rolls back must forget the ones it copied, or a later step of the
// same transaction could attach copied stream facts to a request that no longer is a copy.

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = (name) => require(path.join(compiled, 'backend/reliableKernel', name));
const { RootAuthority } = load('rootAuthority.js');
const { RuntimeDatabase, initializeEmptyRuntimeRoot } = load('runtimeDatabase.js');
const { ContentAddressedStore } = load('contentAddressedStore.js');
const { preparedContentObjectSteps } = load('contentObjectTransaction.js');
const { DOMAIN_REPOSITORIES, savepoint } = load('repositories.js');
const repo = (name) => DOMAIN_REPOSITORIES.domain(name);
const NOW = '2026-09-27T00:00:00.000Z';
const CONTINUE_ON_DUPLICATE_CONVERSATION = {
  kind: 'rollback-and-continue-on-unique',
  constraints: [{ domain: 'Conversation', columns: ['id'] }]
};

async function withCopyTarget(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-historical-copy-savepoint-'));
  const authority = new RootAuthority(() => path.join(directory, 'runtime'));
  await initializeEmptyRuntimeRoot(authority);
  const database = await RuntimeDatabase.open(authority);
  try {
    const store = ContentAddressedStore.forDatabase(authority, database);
    const recipe = await store.prepare(database, '{}', 'application/json');
    await database.transaction([
      ...preparedContentObjectSteps([recipe], 'historical_copy_fixture'),
      repo('Conversation').insert({ id: 'copy', title: 'copy', status: 'active', created_at: NOW, updated_at: NOW }),
      repo('Turn').insert({ id: 'copy-turn', conversation_id: 'copy', status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
      repo('AuthoritySnapshot').insert({ id: 'copy-authority', turn_id: 'copy-turn', content_object_id: recipe.metadata.id, created_at: NOW })
    ]);
    const request = (id, terminal = true) => ({
      id, turn_id: 'copy-turn', request_seq: 1n,
      status: terminal ? 'terminal' : 'prepared', terminal_state: terminal ? 'completed' : null,
      provider_id: 'p', model_id: 'm', context_window_tokens: 1000n, compression_threshold_tokens: 900n,
      estimated_context_tokens: 1n, authority_snapshot_id: 'copy-authority', settings_snapshot_object_id: null,
      recipe_object_id: recipe.metadata.id, usage_json: null,
      stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null }, created_at: NOW, updated_at: NOW
    });
    /** The request row with its one Operation and Attempt, copied historically or created as the Runtime does. */
    const requestSteps = (id, { historical }) => {
      const insert = (domain, row) => historical ? repo(domain).insertHistoricalCopy(row) : repo(domain).insert(row);
      return [
        insert('ModelRequest', request(id, historical)),
        insert('Operation', { id: `${id}-operation`, owner_kind: 'model_request', owner_id: id, operation_seq: 1n,
          tool_call_id: null, status: historical ? 'completed' : 'pending', created_at: NOW, updated_at: NOW }),
        insert('Attempt', { id: `${id}-attempt`, operation_id: `${id}-operation`, attempt_seq: 1n,
          status: historical ? 'completed' : 'pending', created_at: NOW, updated_at: NOW, completed_at: historical ? NOW : null })
      ];
    };
    const checkpoint = (requestId) => repo('ModelStreamCheckpoint').insertHistoricalCopy({
      id: `${requestId}-checkpoint`, model_request_id: requestId, attempt_seq: 1n, socket_generation: 1n, stream_seq: 1n,
      checkpoint_kind: 'terminal_summary', content_object_id: recipe.metadata.id, created_at: NOW
    });
    const fence = (requestId) => repo('ModelStreamFence').insertHistoricalCopy({
      id: `${requestId}-fence`, model_request_id: requestId, attempt_seq: 1n, socket_generation: 1n,
      terminal_stream_seq: 1n, outcome: 'completed', created_at: NOW
    });
    const count = async (domain, where) => (await database.snapshot([repo(domain).list({ where, limit: 10 })])).snapshot[0].length;
    await run({ database, requestSteps, checkpoint, fence, count });
  } finally {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('savepoint 内的历史复制父请求照常记下，同一事务后面的检查点与栅栏可以跟着复制', async () => withCopyTarget(async (f) => {
  await f.database.transaction([
    savepoint('copy_request', f.requestSteps('kept-request', { historical: true }), CONTINUE_ON_DUPLICATE_CONVERSATION),
    f.checkpoint('kept-request'),
    f.fence('kept-request')
  ]);
  assert.equal(await f.count('ModelStreamCheckpoint', { model_request_id: 'kept-request' }), 1);
  assert.equal(await f.count('ModelStreamFence', { model_request_id: 'kept-request' }), 1);
}));

test('savepoint 回滚时撤销其中的历史复制记录：同一事务后面的检查点插入被拒绝', async () => withCopyTarget(async (f) => {
  await assert.rejects(f.database.transaction([
    savepoint('copy_request', [
      ...f.requestSteps('rolled-back-request', { historical: true }),
      // Fails on conversation.id: the savepoint rolls back and the transaction continues.
      repo('Conversation').insert({ id: 'copy', title: 'duplicate', status: 'active', created_at: NOW, updated_at: NOW })
    ], CONTINUE_ON_DUPLICATE_CONVERSATION),
    f.checkpoint('rolled-back-request')
  ]), /Historical ModelStreamCheckpoint copy requires its ModelRequest to be copied in the same transaction/);
  assert.equal(await f.count('ModelRequest', { id: 'rolled-back-request' }), 0);
  assert.equal(await f.count('ModelStreamCheckpoint', {}), 0);
}));

test('savepoint 回滚后同 id 的请求改为普通插入，也不能再挂上历史复制的栅栏', async () => withCopyTarget(async (f) => {
  // Without the rollback forgetting the copy, this fence would be accepted onto a prepared request
  // that the transaction created itself (the append the historical-copy rule forbids), leaving only
  // the end-of-transaction aggregate check to refuse it.
  await assert.rejects(f.database.transaction([
    savepoint('copy_request', [
      ...f.requestSteps('reused-request', { historical: true }),
      repo('Conversation').insert({ id: 'copy', title: 'duplicate', status: 'active', created_at: NOW, updated_at: NOW })
    ], CONTINUE_ON_DUPLICATE_CONVERSATION),
    ...f.requestSteps('reused-request', { historical: false }),
    f.fence('reused-request')
  ]), /Historical ModelStreamFence copy requires its ModelRequest to be copied in the same transaction/);
  assert.equal(await f.count('ModelRequest', { id: 'reused-request' }), 0, 'the whole transaction rolled back');
  assert.equal(await f.count('ModelStreamFence', {}), 0);
}));
