import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import * as fork from './fixtures/fork-lifecycle-fixture.mjs';
import * as estimate from './fixtures/fork-estimate-fixture.mjs';
import { createBatchFixture, kernel, repo } from './fixtures/runtime-behavior-fixture.mjs';
let batch;
async function nodes() { return batch ??= await createBatchFixture(); }
after(async () => { await batch?.close(); });

test('fork completed history, reopen, continue and replay the same target', fork.scenario1);
test('an active source Turn cannot be copied and remains stoppable', fork.scenario2);
test('fork uses the current transcript after an earlier message edit', fork.scenario3);
test('owned compression survives source deletion and nested forks', fork.scenario4);
test('a rejected fork clears every setting copied before its commit', fork.scenario5);
test('lost fork acknowledgment replays without overwriting target settings', fork.scenario6);
test('copied Plan approval authorizes retry through the fork owned ToolCall', fork.scenario7);
test('fork candidate search reads shared history once within its visible range', fork.scenario8);
test('fork prefix preserves Provider calibration without counting image storage bytes', estimate.scenario1);

test('context batches reuse the first identity and preserve materialized order', async () => {
 const h = await nodes(); const at = h.now;
 await h.segments(['batch-a-segment','batch-b-segment']);
 const a={id:'batch-a',parent_node_id:null,segment_id:'batch-a-segment',created_at:at};
 const b={id:'batch-b',parent_node_id:'batch-a',segment_id:'batch-b-segment',created_at:at};
 await h.database.transaction([repo('ContextSequenceNode').ensureContextSequenceNodes([a])]);
 const commit=await h.database.transaction([repo('ContextSequenceNode').ensureContextSequenceNodes([{...a,created_at:'2026-10-13T01:00:00.000Z'},b])]);
 const records=(await h.database.snapshot([repo('ContextSequenceNode').get(a.id),repo('ContextSequenceNode').get(b.id)])).snapshot;
 assert.deepEqual(records.map(x=>[x.id,x.parent_node_id,x.created_at]),[['batch-a',null,at],['batch-b','batch-a',at]]);
 assert.ok(commit.changes.every(change=>change.domain!=='ContextSequenceNode'));
});

test('a context node identity collision rolls back earlier batch inserts', async () => {
 const h=await nodes();await h.segments(['collision-prefix-segment','collision-changed-segment']);
 await assert.rejects(h.database.transaction([repo('ContextSequenceNode').ensureContextSequenceNodes([
 {id:'collision-prefix',parent_node_id:null,segment_id:'collision-prefix-segment',created_at:h.now},
 {id:'batch-a',parent_node_id:null,segment_id:'collision-changed-segment',created_at:h.now}
 ])]), error=>error.code==='RUNTIME_TRANSACTION_ASSERTION_FAILED');
 assert.equal((await h.database.snapshot([repo('ContextSequenceNode').get('collision-prefix')])).snapshot[0],null);
});

test('a rolled back savepoint forgets new context node identities before reuse', async () => {
 const h=await nodes();await h.segments(['savepoint-a-segment']);
 const a={id:'savepoint-a',parent_node_id:null,segment_id:'savepoint-a-segment',created_at:h.now};
 await h.database.transaction([
 kernel.savepoint('node_collision',[repo('ContextSequenceNode').ensureContextSequenceNodes([a]),repo('ContextSequenceNode').insert(a)],
 {kind:'rollback-and-continue-on-unique',constraints:[{domain:'ContextSequenceNode',columns:['id']},{domain:'ContextSequenceNode',columns:['segment_id']}]}),
 repo('ContextSequenceNode').ensureContextSequenceNodes([{...a,created_at:'2026-10-13T01:00:00.000Z'}])]);
 assert.equal((await h.database.snapshot([repo('ContextSequenceNode').get(a.id)])).snapshot[0].created_at,'2026-10-13T01:00:00.000Z');
});
