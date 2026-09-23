import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import {
  findTurnAuthoritySourceProblems,
  validateTurnControlPlaneSources
} from './lib/turn-identity-contract.mjs';

const root = process.cwd();
const checkId = option('check');
const supportedCheck = 'candidate.turn-sole-execution-identity';
if (checkId !== supportedCheck) {
  console.error(`用法：node scripts/reliable-kernel/run-candidate-check.mjs --check=${supportedCheck} [--commit=<sha>]`);
  process.exit(2);
}
const headCommit = currentCommit();
const requestedCommit = option('commit');
if (requestedCommit && requestedCommit !== headCommit) {
  console.error(`--commit必须等于当前HEAD：参数${requestedCommit}，HEAD ${headCommit}`);
  process.exit(2);
}

const require = createRequire(import.meta.url);
let kernel;
try {
  kernel = require(path.join(root, 'dist/extension/backend/reliableKernel/index.js'));
} catch (error) {
  console.error(`无法加载已编译Phase C内核；请先运行npm run compile：${error.message}`);
  process.exit(1);
}

try {
  const summary = await checkTurnSoleExecutionIdentity();
  const evidencePath = await writeEvidence(summary, headCommit);
  console.log(`PASS: ${checkId} — ${summary}; evidence=${path.relative(root, evidencePath)}`);
} catch (error) {
  console.error(`FAIL: ${checkId} — ${error?.stack || error}`);
  process.exit(1);
}

async function checkTurnSoleExecutionIdentity() {
  const sourceProblems = await validateTurnControlPlaneSources(root);
  assert.deepEqual(sourceProblems, [], sourceProblems.join('；'));
  const negativeProblems = findTurnAuthoritySourceProblems(
    'type Legacy = RunId; const sourceRunId = "legacy"; const commandId = "legacy"; import "backend/world/modules/agentRun";',
    'negative-fixture'
  );
  assert.ok(negativeProblems.length >= 4, '旧执行身份负例必须被候选路径检查识别');

  return withRuntime('main', async ({ authority, binding, database }) => {
    const store = new kernel.ContentAddressedStore(authority, binding);
    const compiler = authorityCompiler(new Set(['agent-a', 'agent-b', 'agent-concurrent']));
    const control = createControl(database, store, compiler);
    const assertions = [];
    const sourceConversationId = 'conversation-source';
    await seedConversation(database, sourceConversationId, 'agent-a', 'source');

    const inputCommand = {
      ...executionCommand(sourceConversationId, { kind: 'command', key: 'input:source:1' }),
      content: 'first user input'
    };
    const beforeInput = BigInt((await database.inspect()).currentCommitSeq);
    const input = await control.input(inputCommand);
    assert.equal(input.admitted, true);
    assert.ok(input.turnId && input.intentId && input.messageId && input.messageRevisionId);
    assert.equal(BigInt(input.commitSeq), beforeInput + 1n);
    const afterInput = BigInt((await database.inspect()).currentCommitSeq);
    const duplicateInput = await control.input(inputCommand);
    assert.equal(duplicateInput.deduplicated, true);
    assert.equal(duplicateInput.intentId, input.intentId);
    assert.equal(duplicateInput.turnId, input.turnId);
    assert.equal(duplicateInput.messageId, input.messageId);
    assert.equal(duplicateInput.messageRevisionId, input.messageRevisionId);
    assert.equal(BigInt((await database.inspect()).currentCommitSeq), afterInput);
    assert.equal((await list(database, 'CommandReceipt', {
      source_kind: 'command', source_key: 'input:source:1'
    })).length, 1);
    assertIndependentMessageFacts(await facts(database, input));
    assertions.push('receipt、CAS metadata、Intent、Turn、Message与lease单事务；duplicate重放原result且不增加commit');

    const authorityRows = await list(database, 'AuthoritySnapshot', { turn_id: input.turnId });
    const authorityMetadata = await get(database, 'ContentObject', authorityRows[0].content_object_id);
    const frozenAuthority = JSON.parse((await store.read(authorityMetadata)).toString('utf8'));
    assert.deepEqual(frozenAuthority, {
      kind: 'effective-turn-authority',
      turnId: input.turnId,
      executorAgentId: 'agent-a',
      model: { providerConfigId: 'provider-local', modelId: 'model-local' },
      policies: { toolPolicyId: 'tools-default', systemPromptId: 'prompt-default' }
    });
    assert.equal((await list(database, 'TurnExecutorLink', { turn_id: input.turnId }))[0].agent_id, 'agent-a');
    await assertAuthorityCompilerFailure(database, store);
    assertions.push('AuthoritySnapshot只接受服务端compiler输出；compiler失败不提交receipt/intent');

    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').update('agent-link-source', {
        agent_id: 'agent-b', updated_at: '2026-07-31T10:01:00.000Z'
      })
    ]);
    assert.equal((await list(database, 'TurnExecutorLink', { turn_id: input.turnId }))[0].agent_id, 'agent-a');

    const interruptCommand = {
      source: { kind: 'command', key: 'interrupt:source:1' },
      turnId: input.turnId,
      reason: 'user requested stop'
    };
    const interrupt = await control.interrupt(interruptCommand);
    const duplicateInterrupt = await control.interrupt(interruptCommand);
    assert.equal(interrupt.pendingTurnInputPosition, '1');
    assert.equal(duplicateInterrupt.pendingTurnInputId, interrupt.pendingTurnInputId);
    assert.equal(duplicateInterrupt.pendingTurnInputPosition, '1');
    assert.equal((await list(database, 'TurnTermination', { turn_id: input.turnId })).length, 0);
    assert.equal((await get(database, 'Turn', input.turnId)).status, 'active');
    assertions.push('interrupt request仅创建PendingTurnInput，并可从receipt稳定重放position');

    const terminalCommits = [];
    const unsubscribeTerminal = database.onCommit((commit) => terminalCommits.push(commit));
    const terminalCommand = {
      source: { kind: 'callback', key: 'provider-terminal:source:1' },
      turnId: input.turnId,
      terminalStatus: 'interrupted',
      reason: 'provider stopped'
    };
    const terminal = await control.terminal(terminalCommand);
    unsubscribeTerminal();
    const terminalCommit = terminalCommits.find((commit) => commit.commitSeq === terminal.commitSeq);
    assert.ok(terminalCommit);
    assertAtomicTerminalChanges(terminalCommit, input.turnId);
    assert.equal((await list(database, 'ExecutionLease', { turn_id: input.turnId })).length, 0);
    assert.equal((await get(database, 'PendingTurnInput', interrupt.pendingTurnInputId)).state, 'consumed');
    const terminalInterruptReplay = await control.interrupt(interruptCommand);
    assert.equal(terminalInterruptReplay.deduplicated, true);
    assert.equal(terminalInterruptReplay.ignoredBecauseTerminal, true);
    assert.equal(terminalInterruptReplay.pendingTurnInputId, undefined);
    const duplicateTerminal = await control.terminal(terminalCommand);
    assert.equal(duplicateTerminal.deduplicated, true);
    assert.equal(duplicateTerminal.terminalRecorded, true);
    assertions.push('interrupted terminal在同一commit确认termination input、写TurnTermination并释放实际lease；consumed interrupt与duplicate terminal均重放终态');

    await assertLateTerminalReceiptOnly(control, database, input.turnId);
    await assertSourceKindBoundaries(control, database, sourceConversationId, input.turnId);
    assertions.push('late callback仅写receipt；callback不能admit新Turn，command不能直接写terminal');

    const retry = await control.continuation({
      ...executionCommand(sourceConversationId, { kind: 'command', key: 'retry:source:1' }),
      sourceTurnId: input.turnId,
      content: 'continue after the interrupted source turn'
    });
    assert.equal(retry.admitted, true);
    assert.ok(retry.turnId && retry.turnId !== input.turnId);
    assert.equal((await list(database, 'TurnExecutorLink', { turn_id: retry.turnId }))[0].agent_id, 'agent-b');
    await control.terminal({
      source: { kind: 'callback', key: 'provider-terminal:retry:1' }, turnId: retry.turnId,
      terminalStatus: 'completed', reason: 'retry completed'
    });
    const continuation = await control.continuation({
      ...executionCommand(sourceConversationId, { kind: 'command', key: 'continuation:source:1' }),
      sourceTurnId: retry.turnId,
      content: 'continue with a new turn'
    });
    assert.equal(continuation.admitted, true);
    assert.ok(continuation.turnId && continuation.turnId !== retry.turnId);
    assertions.push('continuation创建新Intent/Turn，旧Turn保持终态并冻结当前默认executor');

    await assertTerminalLeaseInjectionSafe(database, store, compiler);
    assertions.push('terminal事务前注入lease仍由同一事务释放，不产生terminated+lease');

    await assertUnexpectedAdmissionFailureRollsBack(database, store, compiler);
    assertions.push('非lease admission UNIQUE向外传播，receipt/intent/lease均不提交');

    await assertCrossFacadeConcurrency(database, store, compiler);
    assertions.push('无commandTail时并发input仅一个lease；并发interrupt各写独立receipt并合并到同一open PendingTurnInput');

    await assertEditDeleteRaceRejected(database, store, compiler);
    assertions.push('delete线性化后竞态edit被事务断言拒绝且不创建revision/receipt');

    await assertCompetingTerminals(database, store, compiler, continuation.turnId);
    assertions.push('跨facade competing terminal只产生一个终止事实，另一来源receipt-only');

    await assertForkSourceOnly(control, database, sourceConversationId, input);
    assertions.push('Phase C fork仅验证Turn/MessageRevision/Context root source facts，不写target或ContextHead');

    await assertLargeEditAndDelete(control, database, store, sourceConversationId, input);
    assertions.push('终态Conversation上的edit使用immutable revision并重放>2^53 decimal sequence；delete保持独立facts');

    await assertRecoveryMatrixAgainstContract();
    assert.equal((await control.recoveryFacts(input.turnId)).judgment, 'finalize');
    assertions.push('identity.json derivation覆盖全部16种recovery组合');

    assert.equal((await list(database, 'CommandReceipt', {
      source_kind: 'callback', source_key: 'provider-terminal:source:1'
    })).length, 1);
    assert.equal((await list(database, 'CommandReceipt', {
      source_kind: 'internal', source_key: 'terminal-reconcile:late'
    })).length, 1);
    assert.equal((await list(database, 'CommandReceipt', {
      source_kind: 'recovery', source_key: 'terminal-recovery:late'
    })).length, 1);
    assertions.push('command/callback/internal/recovery统一按(source_kind,source_key)去重');

    return `${assertions.length}组真实SQLite/CAS/fault断言通过：${assertions.join('；')}`;
  });
}

async function assertAuthorityCompilerFailure(database, store) {
  await seedConversation(database, 'conversation-invalid-authority', 'agent-invalid', 'invalid-authority');
  const rejecting = createControl(database, store, authorityCompiler(new Set()));
  const before = BigInt((await database.inspect()).currentCommitSeq);
  await assert.rejects(rejecting.input({
    ...executionCommand('conversation-invalid-authority', { kind: 'command', key: 'invalid-authority' }),
    content: 'must not start'
  }), /configuration authority unavailable/);
  assert.equal(BigInt((await database.inspect()).currentCommitSeq), before);
  assert.equal((await list(database, 'CommandReceipt', { source_key: 'invalid-authority' })).length, 0);
  assert.equal((await list(database, 'TurnIntent', { conversation_id: 'conversation-invalid-authority' })).length, 0);
}

async function assertLateTerminalReceiptOnly(control, database, turnId) {
  const turnCount = (await list(database, 'Turn', {})).length;
  const commits = [];
  const unsubscribe = database.onCommit((commit) => commits.push(commit));
  const late = await control.terminal({
    source: { kind: 'callback', key: 'provider-terminal:source:late' }, turnId,
    terminalStatus: 'completed', reason: 'late provider callback'
  });
  unsubscribe();
  assert.equal(late.ignoredBecauseTerminal, true);
  assert.equal(late.terminalRecorded, false);
  assert.deepEqual(commits.find((commit) => commit.commitSeq === late.commitSeq)?.changes, []);
  assert.equal((await list(database, 'Turn', {})).length, turnCount);
  for (const [kind, key] of [['internal', 'terminal-reconcile:late'], ['recovery', 'terminal-recovery:late']]) {
    const closed = await control.terminal({
      source: { kind, key }, turnId, terminalStatus: 'failed', reason: 'late source reconciliation'
    });
    assert.equal(closed.ignoredBecauseTerminal, true);
  }
}

async function assertSourceKindBoundaries(control, database, conversationId, terminalTurnId) {
  const turnCount = (await list(database, 'Turn', {})).length;
  await assert.rejects(control.continuation({
    ...executionCommand(conversationId, { kind: 'callback', key: 'forbidden-callback-continuation' }),
    sourceTurnId: terminalTurnId,
    content: 'must not open'
  }), /source kind must be command or internal/);
  await assert.rejects(control.terminal({
    source: { kind: 'command', key: 'forbidden-command-terminal' },
    turnId: terminalTurnId,
    terminalStatus: 'completed',
    reason: 'must not write'
  }), /terminal source kind/);
  const originalInputMessage = (await list(database, 'MessageTurnLink', {
    turn_id: terminalTurnId, role: 'input'
  }))[0]?.message_id;
  await assert.rejects(control.delete({
    source: { kind: 'command', key: 'input:source:1' },
    conversationId,
    messageId: originalInputMessage
  }), /does not contain delete result facts/);
  assert.equal((await list(database, 'Turn', {})).length, turnCount);
  assert.equal((await list(database, 'CommandReceipt', { source_key: 'forbidden-callback-continuation' })).length, 0);
  assert.equal((await list(database, 'CommandReceipt', { source_key: 'forbidden-command-terminal' })).length, 0);
}

async function assertLargeEditAndDelete(control, database, store, conversationId, input) {
  const highContent = await store.ingest(database, 'large sequence base', 'text/plain');
  const currentLink = (await list(database, 'MessageCurrentRevisionLink', { message_id: input.messageId }))[0];
  const contextHead = (await list(database, 'ConversationContextHeadLink', { conversation_id: conversationId }))[0];
  const baseRoot = await get(database, 'ContextSequenceRoot', contextHead.root_id);
  const highSegmentId = 'context-segment-large-base';
  const highNodeId = 'context-node-large-base';
  const highRootId = 'context-root-large-base';
  await database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
      id: 'message-revision-large-base', message_id: input.messageId, revision_seq: '9007199254740992',
      role: 'user', content_object_id: highContent.id, created_at: '2026-07-31T10:02:00.000Z'
    }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').update(currentLink.id, {
      revision_id: 'message-revision-large-base', updated_at: '2026-07-31T10:02:00.000Z'
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ContextSegment').insert({
      id: highSegmentId,
      content_object_id: highContent.id,
      segment_kind: 'message',
      created_at: '2026-07-31T10:02:00.000Z'
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ContextSegmentSource').insert({
      id: 'context-source-large-base',
      segment_id: highSegmentId,
      source_kind: 'message_revision',
      source_id: 'message-revision-large-base',
      source_revision: 9007199254740992n,
      created_at: '2026-07-31T10:02:00.000Z'
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ContextSequenceNode').insert({
      id: highNodeId,
      parent_node_id: baseRoot.root_node_id,
      segment_id: highSegmentId,
      created_at: '2026-07-31T10:02:00.000Z'
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
      id: highRootId,
      conversation_id: conversationId,
      root_node_id: highNodeId,
      tail_node_id: null,
      tail_segment_count: 0n,
      segment_count: baseRoot.segment_count + 1n,
      estimated_tokens: baseRoot.estimated_tokens + 5n,
      created_at: '2026-07-31T10:02:00.000Z'
    }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
    kernel.DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').update(contextHead.id, {
      root_id: highRootId,
      updated_at: '2026-07-31T10:02:00.000Z'
    })
  ]);
  const editCommand = {
    source: { kind: 'command', key: 'edit:source-message:1' },
    conversationId,
    messageId: input.messageId,
    content: 'edited first user input'
  };
  const edit = await control.edit(editCommand);
  const duplicateEdit = await control.edit(editCommand);
  assert.equal(edit.messageRevisionSeq, '9007199254740993');
  assert.equal(duplicateEdit.messageRevisionId, edit.messageRevisionId);
  assert.equal(duplicateEdit.messageRevisionSeq, edit.messageRevisionSeq);
  assert.equal((await get(database, 'MessageRevision', edit.messageRevisionId)).revision_seq, 9007199254740993n);
  const revisionsBeforeDelete = (await list(database, 'MessageRevision', { message_id: input.messageId })).length;
  const deleteCommand = {
    source: { kind: 'command', key: 'delete:source-message:1' },
    conversationId,
    messageId: input.messageId
  };
  await control.delete(deleteCommand);
  assert.equal((await control.delete(deleteCommand)).deduplicated, true);
  assert.equal(typeof (await get(database, 'Message', input.messageId)).deleted_at, 'string');
  assert.equal((await list(database, 'MessageRevision', { message_id: input.messageId })).length, revisionsBeforeDelete);
  assert.equal((await list(database, 'MessageCurrentRevisionLink', { message_id: input.messageId })).length, 1);
  assert.equal((await list(database, 'MessagePartOfConversation', { message_id: input.messageId })).length, 1);
  assert.equal((await list(database, 'MessageTurnLink', { message_id: input.messageId })).length, 1);
}

async function assertTerminalLeaseInjectionSafe(database, store, compiler) {
  await seedConversation(database, 'conversation-lease-injection', 'agent-a', 'lease-injection');
  const now = '2026-07-31T10:03:00.000Z';
  await database.transaction([kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
    id: 'turn-lease-injection', conversation_id: 'conversation-lease-injection', status: 'active',
    created_at: now, updated_at: now, terminal_at: null
  })]);
  let injected = false;
  const proxy = proxyDatabase(database, {
    async beforeTransaction(steps) {
      if (!injected && steps.some((step) => step.kind === 'insert' && step.domain === 'TurnTermination')) {
        injected = true;
        await database.transaction([kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
          id: 'lease-injected', conversation_id: 'conversation-lease-injection', turn_id: 'turn-lease-injection',
          owner_id: 'recovery-owner', host_boot_id: 'recovery-host', generation: 1n, acquired_at: now,
          expires_at: '2026-07-31T11:03:00.000Z'
        })]);
      }
    }
  });
  const control = createControl(proxy, store, compiler);
  await control.terminal({
    source: { kind: 'callback', key: 'terminal-lease-injection' }, turnId: 'turn-lease-injection',
    terminalStatus: 'completed', reason: 'done'
  });
  assert.equal((await get(database, 'Turn', 'turn-lease-injection')).status, 'terminated');
  assert.equal((await list(database, 'ExecutionLease', { turn_id: 'turn-lease-injection' })).length, 0);
  assert.equal((await list(database, 'TurnTermination', { turn_id: 'turn-lease-injection' })).length, 1);
}

async function assertUnexpectedAdmissionFailureRollsBack(database, store, compiler) {
  await seedConversation(database, 'conversation-admission-fault', 'agent-a', 'admission-fault');
  const now = '2026-07-31T10:04:00.000Z';
  await database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
      id: 'seed-turn-admission-fault', conversation_id: 'conversation-admission-fault', status: 'terminated',
      created_at: now, updated_at: now, terminal_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('TurnExecutorLink').insert({
      id: 'executor-link-admission-collision', turn_id: 'seed-turn-admission-fault', agent_id: 'agent-a', created_at: now
    })
  ]);
  let injected = false;
  const proxy = proxyDatabase(database, {
    beforeTransaction(steps) {
      if (injected) return;
      const admission = steps.find((step) => step.kind === 'savepoint' && step.name === 'admit_turn_intent');
      const executor = admission?.steps.find((step) => step.kind === 'insert' && step.domain === 'TurnExecutorLink');
      if (executor) {
        executor.row.id = 'executor-link-admission-collision';
        injected = true;
      }
    }
  });
  const control = createControl(proxy, store, compiler);
  await assert.rejects(control.input({
    ...executionCommand('conversation-admission-fault', { kind: 'command', key: 'admission-fault' }),
    content: 'must rollback'
  }), /UNIQUE|constraint/i);
  assert.equal((await list(database, 'CommandReceipt', { source_key: 'admission-fault' })).length, 0);
  assert.equal((await list(database, 'TurnIntent', { conversation_id: 'conversation-admission-fault' })).length, 0);
  assert.equal((await list(database, 'ExecutionLease', { conversation_id: 'conversation-admission-fault' })).length, 0);
}

async function assertCrossFacadeConcurrency(database, store, compiler) {
  const conversationId = 'conversation-concurrent';
  await seedConversation(database, conversationId, 'agent-concurrent', 'concurrent');
  const left = createControl(database, store, compiler);
  const right = createControl(database, store, compiler);
  const [first, second] = await Promise.all([
    left.input({ ...executionCommand(conversationId, { kind: 'command', key: 'input:concurrent:a' }), content: 'A' }),
    right.input({ ...executionCommand(conversationId, { kind: 'command', key: 'input:concurrent:b' }), content: 'B' })
  ]);
  assert.equal([first, second].filter((entry) => entry.admitted).length, 1);
  assert.equal([first, second].filter((entry) => !entry.admitted).length, 1);
  assert.equal((await list(database, 'ExecutionLease', { conversation_id: conversationId })).length, 1);
  assert.equal((await list(database, 'Turn', { conversation_id: conversationId })).length, 1);
  const active = [first, second].find((entry) => entry.admitted);
  const interrupts = await Promise.all([
    left.interrupt({ source: { kind: 'command', key: 'interrupt:concurrent:a' }, turnId: active.turnId, reason: 'A' }),
    right.interrupt({ source: { kind: 'command', key: 'interrupt:concurrent:b' }, turnId: active.turnId, reason: 'B' })
  ]);
  assert.deepEqual(interrupts.map((entry) => entry.pendingTurnInputPosition).sort(), ['1', '1']);
  assert.equal(interrupts.filter((entry) => entry.coalesced).length, 1);
  assert.equal((await list(database, 'PendingTurnInput', { turn_id: active.turnId })).length, 1);
  assert.equal((await list(database, 'CommandReceipt', { turn_id: active.turnId })).filter((receipt) =>
    String(receipt.source_key).startsWith('interrupt:concurrent:')
  ).length, 2);
}

async function assertEditDeleteRaceRejected(database, store, compiler) {
  const conversationId = 'conversation-edit-delete-race';
  await seedConversation(database, conversationId, 'agent-a', 'edit-delete-race');
  const starter = createControl(database, store, compiler);
  const started = await starter.input({
    ...executionCommand(conversationId, { kind: 'command', key: 'start-edit-delete-race' }), content: 'original'
  });
  await starter.terminal({
    source: { kind: 'callback', key: 'terminal-edit-delete-race' },
    turnId: started.turnId,
    terminalStatus: 'completed',
    reason: 'fixture idle before competing history mutations'
  });
  const deleter = createControl(database, store, compiler);
  let injected = false;
  const proxy = proxyDatabase(database, {
    async beforeTransaction(steps) {
      const isEdit = steps.some((step) => step.kind === 'insert' && step.domain === 'MessageRevision');
      if (isEdit && !injected) {
        injected = true;
        await deleter.delete({
          source: { kind: 'command', key: 'delete-edit-race' }, conversationId, messageId: started.messageId
        });
      }
    }
  });
  const editor = createControl(proxy, store, compiler);
  const revisionCount = (await list(database, 'MessageRevision', { message_id: started.messageId })).length;
  await assert.rejects(editor.edit({
    source: { kind: 'command', key: 'edit-after-delete-race' }, conversationId,
    messageId: started.messageId, content: 'must fail'
  }), /assertion failed/);
  assert.equal((await list(database, 'MessageRevision', { message_id: started.messageId })).length, revisionCount);
  assert.equal((await list(database, 'CommandReceipt', { source_key: 'edit-after-delete-race' })).length, 0);
}

async function assertCompetingTerminals(database, store, compiler, turnId) {
  const left = createControl(database, store, compiler);
  const right = createControl(database, store, compiler);
  const results = await Promise.all([
    left.terminal({
      source: { kind: 'callback', key: 'terminal:compete:a' }, turnId,
      terminalStatus: 'completed', reason: 'A'
    }),
    right.terminal({
      source: { kind: 'callback', key: 'terminal:compete:b' }, turnId,
      terminalStatus: 'failed', reason: 'B'
    })
  ]);
  assert.equal(results.filter((entry) => entry.terminalRecorded).length, 1);
  assert.equal(results.filter((entry) => entry.ignoredBecauseTerminal).length, 1);
  assert.equal((await list(database, 'TurnTermination', { turn_id: turnId })).length, 1);
  assert.equal((await list(database, 'ExecutionLease', { turn_id: turnId })).length, 0);
}

async function assertRecoveryMatrixAgainstContract() {
  const identity = JSON.parse(await fs.readFile(
    path.join(root, 'docs/architecture/reliable-kernel/contracts/identity.json'),
    'utf8'
  ));
  const derivation = identity.recoveryJudgment.derivation;
  let count = 0;
  for (const turnStatus of ['active', 'terminated']) {
    for (const executionLeaseExists of [false, true]) {
      for (const pendingTurnInputExists of [false, true]) {
        for (const turnTerminationExists of [false, true]) {
          const expected = derivation.find((row) =>
            row.turnStatus === turnStatus
            && matchesPresence(row.executionLease, executionLeaseExists)
            && matchesPresence(row.pendingTurnInput, pendingTurnInputExists)
            && matchesPresence(row.turnTermination, turnTerminationExists)
          );
          assert.ok(expected, 'identity.json derivation must cover every combination');
          assert.equal(kernel.judgeTurnRecovery({
            turnStatus, executionLeaseExists, pendingTurnInputExists, turnTerminationExists
          }), expected.judgment);
          count += 1;
        }
      }
    }
  }
  assert.equal(count, 16);
}

async function assertForkSourceOnly(control, database, sourceConversationId, input) {
  const sourceHead = (await list(database, 'ConversationContextHeadLink', {
    conversation_id: sourceConversationId
  }))[0];
  assert.ok(sourceHead?.root_id, 'Phase E input admission must create the source Context head');
  const conversationCount = (await list(database, 'Conversation', {})).length;
  const headCount = (await list(database, 'ConversationContextHeadLink', {})).length;
  const validated = await control.validateForkSource({
    sourceConversationId,
    sourceTurnId: input.turnId,
    sourceMessageId: input.messageId,
    sourceMessageRevisionId: input.messageRevisionId,
    sourceContextRootId: sourceHead.root_id
  });
  assert.equal(validated.messageRevisionSeq, '1');
  const sourceRoot = await get(database, 'ContextSequenceRoot', sourceHead.root_id);
  assert.equal(validated.contextRootSeq, sourceRoot.root_seq.toString());
  assert.equal((await list(database, 'Conversation', {})).length, conversationCount);
  assert.equal((await list(database, 'ConversationContextHeadLink', {})).length, headCount);
  assert.equal(typeof control.fork, 'undefined');
}

function assertIndependentMessageFacts(state) {
  assert.equal(state.turns.length, 1);
  assert.equal(state.leases.length, 1);
  assert.equal(state.messages.length, 1);
  assert.equal(state.revisions.length, 1);
  assert.equal(state.currentLinks.length, 1);
  assert.equal(state.memberships.length, 1);
  assert.equal(state.turnLinks.length, 1);
}

function assertAtomicTerminalChanges(commit, turnId) {
  const changes = new Set(commit.changes.map((change) => `${change.domain}:${change.kind}:${change.id}`));
  assert.ok(changes.has(`Turn:upsert:${turnId}`));
  assert.ok([...changes].some((entry) => entry.startsWith('TurnTermination:upsert:')));
  assert.ok([...changes].some((entry) => entry.startsWith('ExecutionLease:remove:')));
}

async function facts(database, input) {
  return {
    turns: await list(database, 'Turn', { conversation_id: input.conversationId }),
    leases: await list(database, 'ExecutionLease', { turn_id: input.turnId }),
    messages: await list(database, 'Message', { id: input.messageId }),
    revisions: await list(database, 'MessageRevision', { message_id: input.messageId }),
    currentLinks: await list(database, 'MessageCurrentRevisionLink', { message_id: input.messageId }),
    memberships: await list(database, 'MessagePartOfConversation', { message_id: input.messageId }),
    turnLinks: await list(database, 'MessageTurnLink', { turn_id: input.turnId, message_id: input.messageId })
  };
}

function matchesPresence(expected, exists) {
  return expected === 'any' || expected === (exists ? 'exists' : 'absent');
}

function authorityCompiler(validAgents) {
  return {
    async compile(request) {
      if (!validAgents.has(request.executorAgentId)) {
        throw new Error(`configuration authority unavailable for ${request.executorAgentId}`);
      }
      return {
        turnId: request.turnId,
        executorAgentId: request.executorAgentId,
        executionPreset: {
          content: JSON.stringify({ providerConfigId: 'provider-local', modelId: 'model-local' })
        },
        authoritySnapshot: {
          content: JSON.stringify({
            kind: 'effective-turn-authority',
            turnId: request.turnId,
            executorAgentId: request.executorAgentId,
            model: { providerConfigId: 'provider-local', modelId: 'model-local' },
            policies: { toolPolicyId: 'tools-default', systemPromptId: 'prompt-default' }
          })
        }
      };
    }
  };
}

function createControl(database, store, compiler) {
  return new kernel.TurnControlPlane(database, store, { authorityCompiler: compiler });
}

function proxyDatabase(database, hooks = {}) {
  return {
    binding: database.binding,
    hostBootId: database.hostBootId,
    // 每个变更命令都经对话运行宿主所有权边界（按对话分配运行宿主后），代理必须转发同一个所有权管理器。
    conversationOwners: database.conversationOwners,
    async snapshot(reads) {
      const intercepted = hooks.snapshot?.(reads);
      return intercepted ?? database.snapshot(reads);
    },
    async transaction(steps) {
      await hooks.beforeTransaction?.(steps);
      return database.transaction(steps);
    },
    async materializeContext(rootId) { return database.materializeContext(rootId); },
    async snapshotAll(read) { return database.snapshotAll(read); },
    onCommit(listener) { return database.onCommit(listener); }
  };
}

async function withRuntime(label, body) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-phase-c-${label}-`));
  let database;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    database = await kernel.RuntimeDatabase.open(candidate.authority, { hostBootId: `phase-c-${label}` });
    return await body({ ...candidate, database });
  } finally {
    if (database) await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function seedConversation(database, conversationId, agentId, suffix) {
  const now = '2026-07-31T09:59:00.000Z';
  await database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `agent-link-${suffix}`, conversation_id: conversationId, agent_id: agentId,
      role: 'default', created_at: now, updated_at: now
    })
  ]);
}

function executionCommand(conversationId, source) {
  return {
    source,
    conversationId,
    leaseOwnerId: 'local-executor',
    hostBootId: 'phase-c-candidate',
    leaseExpiresAt: '2026-07-31T11:00:00.000Z'
  };
}

async function list(database, domain, where) {
  const snapshot = await database.snapshot([
    kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, limit: 1000 })
  ]);
  return snapshot.snapshot[0];
}

async function get(database, domain, id) {
  const snapshot = await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain(domain).get(id)]);
  assert.ok(snapshot.snapshot[0], `${domain} ${id} should exist`);
  return snapshot.snapshot[0];
}

async function writeEvidence(summary, commitSha) {
  const evidencePath = path.join(root, 'tests/reliable-kernel/evidence/phase-c-turn-control-plane.json');
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify({
    kind: 'limcode-phase-c-turn-control-plane',
    checkId: supportedCheck,
    passed: true,
    commitSha,
    measuredAt: new Date().toISOString(),
    summary
  }, null, 2)}\n`);
  return evidencePath;
}

function currentCommit() {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}
