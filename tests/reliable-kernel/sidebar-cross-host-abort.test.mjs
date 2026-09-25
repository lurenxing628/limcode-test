import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(name, parent, isMain) {
  return name === 'vscode' ? { EventEmitter: class { event = () => {}; } } : originalLoad.call(this, name, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
  compiledRoot, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
));

function facadeForAbort(overrides = {}) {
  const calls = [];
  const facade = Object.create(Facade.prototype);
  facade.product = {
    application: { database: { conversationOwners: {
      run() { assert.fail('侧栏停止不应要求当前宿主认领远端 Conversation'); }
    } } },
    conversations: { async interrupt(request) { calls.push({ kind: 'interrupt', request }); } },
    childAgents: { async interruptSubtree(request) { calls.push({ kind: 'subtree', request }); } }
  };
  facade.maybeRow = async () => ({ id: 'turn', conversation_id: 'conversation', status: 'active' });
  facade.list = async (domain) => domain === 'ExecutionLease'
    ? [{ generation: 4n }]
    : [];
  Object.assign(facade, overrides);
  return { facade, calls };
}

test('侧栏可在非 owner 窗口提交严格 Turn/lease 栅栏的停止请求', async () => {
  const { facade, calls } = facadeForAbort();
  const result = await facade.abortConversation('conversation', 'sidebar-command', {
    turnId: 'turn', leaseGeneration: '4'
  });
  assert.deepEqual(result, { status: 'committed', turnId: 'turn' });
  assert.deepEqual(calls, [{ kind: 'interrupt', request: {
    commandId: 'sidebar-command', conversationId: 'conversation', turnId: 'turn',
    expectedLeaseGeneration: '4', reason: '用户从侧栏请求终止当前 Conversation。'
  } }]);
});

test('侧栏停止拒绝串会话与过时 ExecutionLease，均不提交中断', async () => {
  for (const [overrides, reason] of [
    [{ maybeRow: async () => ({ id: 'turn', conversation_id: 'other', status: 'active' }) }, 'target_turn_not_current'],
    [{ list: async () => [{ generation: 5n }] }, 'lease_generation_replaced']
  ]) {
    const { facade, calls } = facadeForAbort(overrides);
    assert.deepEqual(await facade.abortConversation('conversation', 'sidebar-command', {
      turnId: 'turn', leaseGeneration: '4'
    }), { status: 'stale', reason, turnId: 'turn' });
    assert.deepEqual(calls, []);
  }
});

test('侧栏子 Agent 停止仍经跨宿主子树控制面提交', async () => {
  const { facade, calls } = facadeForAbort({
    list: async (domain) => domain === 'ExecutionLease'
      ? [{ generation: 4n }]
      : [{ child_execution_id: 'child-execution' }]
  });
  const result = await facade.abortConversation('conversation', 'sidebar-child-command', {
    turnId: 'turn', leaseGeneration: '4'
  });
  assert.deepEqual(result, { status: 'committed', turnId: 'turn' });
  assert.deepEqual(calls, [{ kind: 'subtree', request: {
    sourceKey: 'sidebar-child-interrupt:sidebar-child-command', childExecutionId: 'child-execution',
    reason: '用户从侧栏请求递归终止当前子 Agent。'
  } }]);
});
