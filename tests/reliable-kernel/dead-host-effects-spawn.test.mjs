import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// What a user's stop may do with a Turn's in-flight child work (PhaseDRecoveryScanner.deadHostEffectsForTurn):
// a dispatched run_agent spawn is recorded as spawned only once the Host that dispatched it is proven
// dead; while that Host (the new child Turn's lease holder, or another Host holding this Turn's lease)
// is alive or unverifiable the work is 'live'. A child cancel in flight is always left to the child
// scheduler.
const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const { PhaseDRecoveryScanner } = await load('backend/reliableKernel/phaseDRecovery.js');

function recoveryOver(tables, alive) {
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
  const read = (request) => (tables[request.domain] ?? []).filter((row) => matches(row, request.where));
  const database = {
    hostBootId: 'self',
    async snapshotAll(request) { return { snapshot: read(request) }; },
    async snapshot(requests) { return { snapshot: requests.map(read) }; },
    async isHostAlive(hostBootId) { return alive.includes(hostBootId); }
  };
  const effects = { async readEffectDispatchFence() { return null; } };
  return new PhaseDRecoveryScanner(database, effects, {}, {}, {}, async () => undefined, {});
}

function spawnInFlight({ parentLeaseHost, childLeaseHost, kind = 'subagent_spawn', extra = [] }) {
  return {
    ToolCall: [{ id: 'call', turn_id: 'turn', status: 'executing' }],
    Operation: [
      { id: 'op', tool_call_id: 'call', status: 'executing', owner_kind: 'child_execution', owner_id: 'child-execution' },
      ...extra.map((intent) => ({ id: `op-${intent}`, tool_call_id: 'call', status: 'executing', owner_kind: 'child_execution', owner_id: 'child-execution' }))
    ],
    Attempt: [{ id: 'attempt', operation_id: 'op' }, ...extra.map((intent) => ({ id: `attempt-${intent}`, operation_id: `op-${intent}` }))],
    EffectIntent: [
      { id: 'intent', attempt_id: 'attempt', effect_kind: kind, dispatch_state: 'dispatched' },
      ...extra.map((intent) => ({ id: intent, attempt_id: `attempt-${intent}`, effect_kind: intent, dispatch_state: 'dispatched' }))
    ],
    ChildExecution: [{ id: 'child-execution', child_conversation_id: 'child-conversation' }],
    ExecutionLease: [
      ...(parentLeaseHost ? [{ id: 'parent-lease', turn_id: 'turn', conversation_id: 'parent', host_boot_id: parentLeaseHost }] : []),
      ...(childLeaseHost ? [{ id: 'child-lease', turn_id: 'child-turn', conversation_id: 'child-conversation', host_boot_id: childLeaseHost }] : [])
    ]
  };
}

test('派生在途：派发宿主（子 Turn 租约持有者）存活即为 live，不交给停止记为已派生', async () => {
  assert.deepEqual(await recoveryOver(spawnInFlight({ parentLeaseHost: 'w1', childLeaseHost: 'w1' }), ['w1'])
    .deadHostEffectsForTurn('turn', 'self'), { state: 'live', hostBootIds: ['w1'] });
  // The parent Turn's lease already moved to this window's control claim; the child lease still names the live dispatcher.
  assert.deepEqual(await recoveryOver(spawnInFlight({ parentLeaseHost: 'self', childLeaseHost: 'w1' }), ['w1'])
    .deadHostEffectsForTurn('turn', 'self'), { state: 'live', hostBootIds: ['w1'] });
  // This window dispatched it: its own child scheduler is recording the spawn.
  assert.deepEqual(await recoveryOver(spawnInFlight({ parentLeaseHost: 'self', childLeaseHost: 'self' }), [])
    .deadHostEffectsForTurn('turn', 'self'), { state: 'live', hostBootIds: ['self'] });
  // Another live window holds the parent Turn's lease: it is still executing the Turn.
  assert.deepEqual(await recoveryOver(spawnInFlight({ parentLeaseHost: 'w2', childLeaseHost: 'w1' }), ['w2'])
    .deadHostEffectsForTurn('turn', 'self'), { state: 'live', hostBootIds: ['w2'] });
});

test('派生在途：派发宿主被证明已死时才列出派生，供用户停止记为已派生', async () => {
  assert.deepEqual(await recoveryOver(spawnInFlight({ parentLeaseHost: 'w1', childLeaseHost: 'w1' }), [])
    .deadHostEffectsForTurn('turn', 'self'), { state: 'unsupported', spawnEffectIntentIds: ['intent'] });
  // This window's own control claim on the parent Turn does not count as the dispatcher.
  assert.deepEqual(await recoveryOver(spawnInFlight({ parentLeaseHost: 'self', childLeaseHost: 'w1' }), [])
    .deadHostEffectsForTurn('turn', 'self'), { state: 'unsupported', spawnEffectIntentIds: ['intent'] });
});

test('复审 X21：子 Agent 取消在途时交给子调度，不列出派生也不按无在途工作收尾', async () => {
  assert.deepEqual(await recoveryOver(spawnInFlight({ parentLeaseHost: 'w1', kind: 'subagent_cancel' }), [])
    .deadHostEffectsForTurn('turn', 'self'), { state: 'unsupported' });
  assert.deepEqual(await recoveryOver(spawnInFlight({ parentLeaseHost: 'w1', childLeaseHost: 'w1', extra: ['subagent_cancel'] }), [])
    .deadHostEffectsForTurn('turn', 'self'), { state: 'unsupported' });
});
