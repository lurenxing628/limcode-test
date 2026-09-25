import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(import.meta.url);
const compiledRoot = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT)
  : path.join(root, 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { ConversationRuntimeOwnerManager } = require(
  path.join(compiledRoot, 'backend/reliableKernel/ConversationRuntimeOwnerManager.js')
);
const NOW = '2026-08-20T00:00:00.000Z';

const authorityCompiler = {
  async compile(request) {
    return {
      turnId: request.turnId,
      executorAgentId: request.executorAgentId,
      executionPreset: { content: '{}' },
      authoritySnapshot: { content: '{}' }
    };
  }
};

test('父 Conversation 删除会递归删除全部 Subagent Conversation，但保留普通 fork', async () => {
  await withRuntime('conversation-delete-tree', async ({ database }) => {
    await seedConversation(database, 'parent');
    await seedConversation(database, 'child');
    await seedConversation(database, 'grandchild');
    await seedConversation(database, 'fork');
    await seedStoppedChild(database, {
      suffix: 'child',
      conversationId: 'child',
      parentConversationId: 'parent',
      parentTurnId: 'parent-turn'
    });
    await seedStoppedChild(database, {
      suffix: 'grandchild',
      conversationId: 'grandchild',
      parentConversationId: 'child',
      parentTurnId: 'child-turn',
      parentChildExecutionId: 'child-execution-child'
    });
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ConversationOriginLink').insert({
        id: 'origin-fork',
        conversation_id: 'fork',
        source_conversation_id: 'parent',
        source_turn_id: null,
        source_tool_call_id: null,
        source_message_revision_id: null,
        created_at: NOW
      })
    ]);

    const control = new kernel.ConversationDeletionControlPlane(database);
    const deleted = await control.delete('parent');
    assert.deepEqual(deleted.deletedConversationIds, ['grandchild', 'child', 'parent']);
    assert.equal(await maybeGet(database, 'Conversation', 'parent'), null);
    assert.equal(await maybeGet(database, 'Conversation', 'child'), null);
    assert.equal(await maybeGet(database, 'Conversation', 'grandchild'), null);
    assert.ok(await maybeGet(database, 'Conversation', 'fork'));
    assert.equal((await list(database, 'ChildExecution', {})).length, 0);
    assert.equal((await list(database, 'ConversationOriginLink', { conversation_id: 'fork' })).length, 1);
  });
});

test('对话树任意节点被其他宿主持有写者时拒绝整棵删除且不留下部分删除', async () => {
  await withRuntime('conversation-delete-owned-child', async ({ database, binding }) => {
    await seedConversation(database, 'a-parent');
    await seedConversation(database, 'z-child');
    await seedStoppedChild(database, {
      suffix: 'owned-child',
      conversationId: 'z-child',
      parentConversationId: 'a-parent',
      parentTurnId: 'a-parent-turn'
    });
    const peer = new ConversationRuntimeOwnerManager(binding, 'other-window');
    peer.setPendingWorkProbe(async () => false);
    try {
      await peer.claim('z-child');
      const control = new kernel.ConversationDeletionControlPlane(database);
      await assert.rejects(control.delete('a-parent'), { code: 'conversation-runtime-owner-busy' });
      assert.equal((await maybeGet(database, 'Conversation', 'a-parent')).title, 'a-parent');
      assert.equal((await maybeGet(database, 'Conversation', 'z-child')).title, 'z-child');
      assert.equal((await list(database, 'ChildExecution', {}))[0].child_conversation_id, 'z-child');

      await peer.releaseIfIdle('z-child');
      assert.deepEqual((await control.delete('a-parent')).deletedConversationIds, ['z-child', 'a-parent']);
      assert.equal(await maybeGet(database, 'Conversation', 'a-parent'), null);
      assert.equal(await maybeGet(database, 'Conversation', 'z-child'), null);
    } finally {
      await peer.close();
    }
  });
});

test('任一 Subagent 仍活动时拒绝删除整棵 Conversation 树', async () => {
  await withRuntime('conversation-delete-active', async ({ database }) => {
    await seedConversation(database, 'parent');
    await seedConversation(database, 'child', 'active');
    await seedStoppedChild(database, {
      suffix: 'child',
      conversationId: 'child',
      parentConversationId: 'parent',
      parentTurnId: 'parent-turn',
      childStatus: 'active',
      activeTurn: true
    });
    const control = new kernel.ConversationDeletionControlPlane(database);
    await assert.rejects(control.delete('parent'), /活动 Turn|活动 Subagent/);
    assert.ok(await maybeGet(database, 'Conversation', 'parent'));
    assert.ok(await maybeGet(database, 'Conversation', 'child'));
  });
});

test('recovery interruption 兼容旧动态 reason，普通命令仍拒绝不同 facts', async () => {
  await withRuntime('interruption-replay', async ({ database, store }) => {
    await seedConversation(database, 'parent', 'active');
    await seedConversation(database, 'child');
    const effects = new kernel.EffectControlPlane(database, store, { now: () => NOW });
    await effects.createToolCall({
      source: { kind: 'internal', key: 'replay-source-tool' },
      toolCallId: 'tool-replay',
      turnId: 'parent-turn',
      toolName: 'run_agent',
      arguments: { operation: 'spawn', taskName: 'Inspect interruption recovery', prompt: 'Check interruption replay behavior' }
    });
    const childExecutionId = 'child-execution-replay';
    const sourceKey = kernel.childInterruptionRecoverySourceKey(childExecutionId);
    const requestId = kernel.stablePhaseFId('child_interruption_request', 'recovery', sourceKey);
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ChildExecution').insert({
        id: childExecutionId,
        child_conversation_id: 'child',
        status: 'interrupting',
        created_at: NOW,
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').insert({
        id: 'child-parent-replay',
        child_execution_id: childExecutionId,
        source_tool_call_id: 'tool-replay',
        parent_child_execution_id: null,
        parent_turn_id: 'parent-turn',
        created_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AnswerBridge').insert({
        id: 'answer-bridge-replay',
        child_execution_id: childExecutionId,
        current_submission_id: null,
        status: 'interrupted',
        created_at: NOW,
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ChildInterruptionRequest').insert({
        id: requestId,
        root_child_execution_id: childExecutionId,
        source_kind: 'recovery',
        source_key: sourceKey,
        reason: 'Startup recovery observed terminal child Turn turn-legacy.',
        created_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ChildInterruptionLineageLink').insert({
        id: kernel.stablePhaseFId('child_interruption_lineage_link', requestId, childExecutionId),
        interruption_request_id: requestId,
        child_execution_id: childExecutionId,
        created_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: kernel.stablePhaseFId('command_receipt', 'interrupt-subtree', 'recovery', sourceKey),
        source_kind: 'recovery',
        source_key: sourceKey,
        conversation_id: 'child',
        turn_id: null,
        created_at: NOW
      })
    ]);
    const children = new kernel.ChildExecutionControlPlane(database, store, effects, {
      now: () => NOW,
      authorityCompiler
    });
    const replay = await children.interruptSubtree({
      sourceKey,
      childExecutionId,
      reason: kernel.CHILD_INTERRUPTION_RECOVERY_REASON
    });
    assert.equal(replay.deduplicated, true);
    assert.deepEqual(replay.lineageIds, [childExecutionId]);

    const ordinarySourceKey = 'command-replay';
    const ordinaryRequestId = kernel.stablePhaseFId(
      'child_interruption_request',
      'command',
      ordinarySourceKey
    );
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ChildInterruptionRequest').insert({
        id: ordinaryRequestId,
        root_child_execution_id: childExecutionId,
        source_kind: 'command',
        source_key: ordinarySourceKey,
        reason: 'original command reason',
        created_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ChildInterruptionLineageLink').insert({
        id: kernel.stablePhaseFId('child_interruption_lineage_link', ordinaryRequestId, childExecutionId),
        interruption_request_id: ordinaryRequestId,
        child_execution_id: childExecutionId,
        created_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: kernel.stablePhaseFId('command_receipt', 'interrupt-subtree', 'command', ordinarySourceKey),
        source_kind: 'command',
        source_key: ordinarySourceKey,
        conversation_id: 'child',
        turn_id: null,
        created_at: NOW
      })
    ]);
    await assert.rejects(children.interruptSubtree({
      sourceKey: ordinarySourceKey,
      childExecutionId,
      reason: 'new reason'
    }), /different facts/);
  });
});

async function withRuntime(label, body) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-${label}-`));
  let database;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    database = await kernel.RuntimeDatabase.open(candidate.authority, { hostBootId: label });
    const store = new kernel.ContentAddressedStore(candidate.authority, candidate.binding);
    return await body({ ...candidate, database, store });
  } finally {
    if (database) await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function seedConversation(database, id, turnStatus = 'terminated') {
  const steps = [
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id,
      title: id,
      status: 'active',
      created_at: NOW,
      updated_at: NOW
    }),
    kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
      id: `${id}-turn`,
      conversation_id: id,
      status: turnStatus,
      created_at: NOW,
      updated_at: NOW,
      terminal_at: turnStatus === 'terminated' ? NOW : null
    })
  ];
  if (turnStatus === 'active') {
    steps.push(kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
      id: `${id}-lease`,
      conversation_id: id,
      turn_id: `${id}-turn`,
      owner_id: `${id}-owner`,
      host_boot_id: 'fixture-host',
      generation: 1n,
      acquired_at: NOW,
      expires_at: '2026-08-21T00:00:00.000Z'
    }));
  }
  await database.transaction(steps);
}

async function seedStoppedChild(database, input) {
  const executionId = `child-execution-${input.suffix}`;
  const turnId = `${input.conversationId}-turn`;
  const steps = [
    kernel.DOMAIN_REPOSITORIES.domain('ConversationOriginLink').insert({
      id: `origin-${input.suffix}`,
      conversation_id: input.conversationId,
      source_conversation_id: input.parentConversationId,
      source_turn_id: input.parentTurnId,
      source_tool_call_id: `tool-${input.suffix}`,
      source_message_revision_id: null,
      created_at: NOW
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ChildExecution').insert({
      id: executionId,
      child_conversation_id: input.conversationId,
      status: input.childStatus ?? 'idle',
      created_at: NOW,
      updated_at: NOW
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').insert({
      id: `parent-link-${input.suffix}`,
      child_execution_id: executionId,
      source_tool_call_id: `tool-${input.suffix}`,
      parent_child_execution_id: input.parentChildExecutionId ?? null,
      parent_turn_id: input.parentTurnId,
      created_at: NOW
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').insert({
      id: `turn-link-${input.suffix}`,
      child_execution_id: executionId,
      turn_seq: 1n,
      turn_id: turnId,
      created_at: NOW
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AnswerBridge').insert({
      id: `answer-bridge-${input.suffix}`,
      child_execution_id: executionId,
      current_submission_id: null,
      status: input.activeTurn ? 'open' : 'closed',
      created_at: NOW,
      updated_at: NOW
    })
  ];
  if (input.activeTurn) {
    steps.push(
      kernel.DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').insert({
        id: `active-link-${input.suffix}`,
        child_execution_id: executionId,
        turn_id: turnId,
        updated_at: NOW
      })
    );
  }
  await database.transaction(steps);
}

async function maybeGet(database, domain, id) {
  const snapshot = await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain(domain).get(id)]);
  return snapshot.snapshot[0];
}

async function list(database, domain, where) {
  const snapshot = await database.snapshot([
    kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, limit: 1000 })
  ]);
  return snapshot.snapshot[0];
}
