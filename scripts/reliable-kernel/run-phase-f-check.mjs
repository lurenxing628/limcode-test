import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import {
  RELIABLE_KERNEL_COMPILE_PROVENANCE,
  manifestFilesAreTracked,
  reliableKernelCompiledManifest,
  reliableKernelSourceManifest
} from './lib/compile-provenance.mjs';

const root = process.cwd();
const NOW = '2026-08-01T00:00:00.000Z';
const CHILD_MODEL_FALLBACK = Object.freeze({
  providerConfigId: 'fake-local',
  provider: 'openai-compatible',
  model: 'fake-model'
});
const checkId = option('check');
const PHASE_F_CHECKS = new Set([
  'candidate.conversation-fork-links',
  'candidate.subagent-answer-restart-delivery',
  'candidate.subagent-cancel-subtree',
  'candidate.client-snapshot-bounds',
  'candidate.client-change-batch-bounds',
  'candidate.client-queue-bounds',
  'candidate.client-snapshot-feed-barrier',
  'candidate.old-writer-not-routed',
  'candidate.recovery.answer-inbox-invariant',
  'candidate.recovery.pending-delivery',
  'candidate.recovery.foreground-wait-expired',
  'candidate.recovery.interrupted-subtree-incomplete',
  'candidate.parent-handling-matrix'
]);
if (!checkId || !PHASE_F_CHECKS.has(checkId)) {
  console.error('用法：node scripts/reliable-kernel/run-phase-f-check.mjs --check=<Phase-F-stable-id> [--commit=<sha>]');
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
let Database;
let ReliableConversationRunner;
let mapSettledWithBoundedAdmissionConcurrency;
let MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN;
try {
  kernel = require(path.join(root, 'dist/extension/backend/reliableKernel/index.js'));
  ({ ReliableConversationRunner } = require(path.join(
    root,
    'dist/extension/backend/application/reliableKernel/ReliableConversationRunner.js'
  )));
  Database = require('better-sqlite3');
  ({ mapSettledWithBoundedAdmissionConcurrency } = require(path.join(
    root,
    'dist/extension/backend/capabilities/boundedConcurrency.js'
  )));
  ({ MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN } = require(path.join(
    root,
    'dist/extension/shared/agentScheduling.js'
  )));
} catch (error) {
  console.error(`无法加载已编译Phase F内核；请先运行npm run compile：${error.message}`);
  process.exit(1);
}

const handlers = new Map([
  ['candidate.conversation-fork-links', checkConversationForkLinks],
  ['candidate.subagent-answer-restart-delivery', checkAnswerRestartDelivery],
  ['candidate.subagent-cancel-subtree', checkCancelSubtree],
  ['candidate.client-snapshot-bounds', checkClientSnapshotBounds],
  ['candidate.client-change-batch-bounds', checkClientChangeBatchBounds],
  ['candidate.client-queue-bounds', checkClientQueueBounds],
  ['candidate.client-snapshot-feed-barrier', checkSnapshotFeedBarrier],
  ['candidate.old-writer-not-routed', checkOldWriterNotRouted],
  ['candidate.recovery.answer-inbox-invariant', checkRecoveryAnswerInbox],
  ['candidate.recovery.pending-delivery', checkRecoveryPendingDelivery],
  ['candidate.recovery.foreground-wait-expired', checkRecoveryForegroundWait],
  ['candidate.recovery.interrupted-subtree-incomplete', checkRecoveryInterruptedSubtree],
  ['candidate.parent-handling-matrix', checkParentHandlingMatrix]
]);

try {
  const evidence = await handlers.get(checkId)();
  const evidencePath = await writeEvidence(checkId, evidence, headCommit);
  console.log(
    `PASS: ${checkId} — ${evidence.assertions.length}组真实断言通过：${evidence.assertions.join('；')}; `
      + `faults=${evidence.faults.join('、')}; evidence=${path.relative(root, evidencePath)}`
  );
} catch (error) {
  console.error(`FAIL: ${checkId} — ${error?.stack || error}`);
  process.exit(1);
}

async function checkConversationForkLinks() {
  return withRuntime('fork', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const seeded = await seedParent(ctx, 'fork');
    // A fork copies completed history only: end the seeded Turn before forking its message.
    await seeded.control.terminal({
      source: { kind: 'callback', key: 'fork-seed-terminal' },
      turnId: seeded.turnId,
      terminalStatus: 'completed',
      reason: 'fixture completed before fork'
    });
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'agent-link-fork-reviewer',
        conversation_id: seeded.conversationId,
        agent_id: 'agent-fork-reviewer',
        role: 'reviewer',
        created_at: NOW,
        updated_at: NOW
      })
    ]);
    const projectUri = 'file:///workspace/fork-project';
    await ctx.database.transaction(kernel.projectFolderAssignmentSteps({
      conversationId: seeded.conversationId,
      folder: { uri: projectUri, name: 'fork-project' },
      now: new Date().toISOString()
    }));
    const sourceProjectLink = (await list(ctx.database, 'ConversationProjectLink', {
      conversation_id: seeded.conversationId
    }))[0];
    assert.ok(sourceProjectLink);
    const context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    const sourceRootId = await context.currentHeadRootId(seeded.conversationId);
    const sourceRoot = await get(ctx.database, 'ContextSequenceRoot', sourceRootId);
    const sourceMessageSegment = (await list(ctx.database, 'ContextSegmentSource', {
      source_kind: 'message_revision',
      source_id: seeded.messageRevisionId
    }))[0];
    assert.ok(sourceMessageSegment);
    const forks = ctx.services.conversationFork;
    const baseCommand = {
      idempotencyKey: 'fork-atomic',
      reuseKey: 'reuse-fork-atomic',
      sourceConversationId: seeded.conversationId,
      sourceContextRootId: sourceRootId,
      sourceContextEndSegmentId: sourceMessageSegment.segment_id,
      sourceMessageRevisionId: seeded.messageRevisionId,
      sourceTurnId: seeded.turnId,
      expectedSourceHeadRootId: sourceRootId,
      targetTitle: 'Fork target',
      targetAgentId: 'fork-target-agent'
    };
    await assert.rejects(forks.fork({
      ...baseCommand,
      idempotencyKey: 'fork-missing-exact-boundary',
      reuseKey: 'reuse-fork-missing-exact-boundary',
      sourceContextEndSegmentId: undefined
    }), /sourceMessageRevisionId requires sourceContextEndSegmentId/);

    const originalTransaction = ctx.database.transaction.bind(ctx.database);
    let injected = false;
    ctx.database.transaction = async (steps) => {
      if (!injected && steps.some((step) => step.kind === 'insert' && step.domain === 'ConversationBranchLink')) {
        injected = true;
        return originalTransaction([
          ...steps,
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').assert('missing-fork-fault', { status: 'active' })
        ]);
      }
      return originalTransaction(steps);
    };
    await assert.rejects(forks.fork(baseCommand), /assertion failed/);
    ctx.database.transaction = originalTransaction;
    assert.equal((await list(ctx.database, 'ConversationReuseLink', { reuse_key: baseCommand.reuseKey })).length, 0);
    assert.equal((await list(ctx.database, 'ConversationBranchLink', { source_conversation_id: seeded.conversationId })).length, 0);
    assert.equal((await list(ctx.database, 'ConversationOriginLink', { source_conversation_id: seeded.conversationId })).length, 0);
    assert.equal((await list(ctx.database, 'ConversationProjectLink', {})).length, 1);
    assert.equal((await list(ctx.database, 'Conversation', {})).length, 1);
    assertions.push('消息边界fork强制携带精确Context segment；fork中间故障使target Conversation/root/head/三类Link整笔SQLite事务回滚');
    faults.push('fork writer transaction fault after relation inserts');

    const forked = await forks.fork(baseCommand);
    const replay = await forks.fork(baseCommand);
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.targetConversationId, forked.targetConversationId);
    // The title is only the target's initial display title, never part of the fork identity.
    const retitledReplay = await forks.fork({ ...baseCommand, targetTitle: 'Different replay title' });
    assert.equal(retitledReplay.deduplicated, true);
    assert.equal(retitledReplay.targetConversationId, forked.targetConversationId);
    const targetRoot = await get(ctx.database, 'ContextSequenceRoot', forked.targetRootId);
    assert.equal(targetRoot.root_node_id, sourceRoot.root_node_id);
    assert.equal(targetRoot.segment_count, sourceRoot.segment_count);
    assert.notEqual(targetRoot.id, sourceRoot.id);
    assert.equal((await list(ctx.database, 'ConversationReuseLink', { conversation_id: forked.targetConversationId })).length, 1);
    assert.equal((await list(ctx.database, 'ConversationBranchLink', { target_conversation_id: forked.targetConversationId })).length, 1);
    const origin = (await list(ctx.database, 'ConversationOriginLink', { conversation_id: forked.targetConversationId }))[0];
    assert.equal(origin.source_turn_id, seeded.turnId);
    assert.equal(Object.hasOwn(origin, 'source_run_id'), false);
    const targetProjectLink = (await list(ctx.database, 'ConversationProjectLink', {
      conversation_id: forked.targetConversationId
    }))[0];
    assert.equal(targetProjectLink.project_context_id, sourceProjectLink.project_context_id);
    const targetAgentLinks = await list(ctx.database, 'AgentConversationLink', {
      conversation_id: forked.targetConversationId
    });
    assert.deepEqual(
      targetAgentLinks.map((link) => [link.role, link.agent_id]).sort(),
      [['default', 'fork-target-agent'], ['reviewer', 'agent-fork-reviewer']]
    );
    const sourceMembershipsBeforeContinuation = await list(ctx.database, 'MessagePartOfConversation', {
      conversation_id: seeded.conversationId
    });
    const targetMembershipsBeforeContinuation = await list(ctx.database, 'MessagePartOfConversation', {
      conversation_id: forked.targetConversationId
    });
    assert.equal(forked.copiedMessageCount, 1);
    assert.equal(targetMembershipsBeforeContinuation.length, 1);
    assert.notEqual(targetMembershipsBeforeContinuation[0].message_id, seeded.messageId);
    assert.equal(targetMembershipsBeforeContinuation[0].message_seq, sourceMembershipsBeforeContinuation[0].message_seq);
    const targetMessageId = targetMembershipsBeforeContinuation[0].message_id;
    const targetCurrent = (await list(ctx.database, 'MessageCurrentRevisionLink', {
      message_id: targetMessageId
    }))[0];
    assert.ok(targetCurrent);
    assert.notEqual(targetCurrent.revision_id, seeded.messageRevisionId);
    const targetRevision = await get(ctx.database, 'MessageRevision', targetCurrent.revision_id);
    const sourceRevision = await get(ctx.database, 'MessageRevision', seeded.messageRevisionId);
    assert.equal(targetRevision.content_object_id, sourceRevision.content_object_id);
    assert.equal(targetRevision.role, sourceRevision.role);
    const targetSnapshot = await ctx.database.clientProjectionSnapshot(forked.targetConversationId);
    assert.equal(String(targetSnapshot.snapshot.activeConversationWindow.visibleMessageCount), '1');
    assert.deepEqual(
      targetSnapshot.snapshot.activeConversationWindow.messages.map((message) => message.id),
      [targetMessageId]
    );
    assertions.push('Reuse/Branch/Origin/ConversationProjectLink保持独立，fork原子继承ProjectContext并以新Message/Revision身份投影可见历史');

    const targetControl = createTurnControl(ctx, 'fork-independent-continuation');
    const targetContinuation = await targetControl.input({
      source: { kind: 'command', key: 'fork-target-independent-input' },
      conversationId: forked.targetConversationId,
      leaseOwnerId: 'fork-target-executor',
      hostBootId: ctx.database.hostBootId,
      leaseExpiresAt: '2026-08-02T00:00:00.000Z',
      content: 'target-only-continuation'
    });
    const targetMembershipsAfterContinuation = await list(ctx.database, 'MessagePartOfConversation', {
      conversation_id: forked.targetConversationId
    });
    assert.equal(targetMembershipsAfterContinuation.length, 2);
    assert.equal(targetMembershipsAfterContinuation.find((row) => row.message_id === targetContinuation.messageId)?.message_seq, 2n);
    assert.equal((await list(ctx.database, 'MessagePartOfConversation', {
      conversation_id: seeded.conversationId
    })).length, 1);
    const targetHeadAfterContinuation = await context.currentHeadRootId(forked.targetConversationId);
    assert.notEqual(targetHeadAfterContinuation, forked.targetRootId);
    assert.equal(await context.currentHeadRootId(seeded.conversationId), sourceRootId);
    assertions.push('fork后目标续聊从复制序列继续递增，并与源Conversation的Message membership和Context head独立演进');

    const sourceAppend = await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'fork-source-after', sourceRevision: '0' },
      content: 'source-after-fork', contentType: 'text/plain'
    });
    const targetAppend = await context.appendContent({
      conversationId: forked.targetConversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'fork-target-after', sourceRevision: '0' },
      content: 'target-after-fork', contentType: 'text/plain'
    });
    assert.notEqual(sourceAppend.nodeId, targetAppend.nodeId);
    assert.equal((await context.materialize(sourceAppend.rootId)).segments.at(-1).content.toString('utf8'), 'source-after-fork');
    assert.equal((await context.materialize(targetAppend.rootId)).segments.at(-1).content.toString('utf8'), 'target-after-fork');
    assertions.push('fork后source/target独立append形成不同后继，原共享前缀保持immutable');

    const prefixSeed = await seedParent(ctx, 'fork-prefix-c');
    await prefixSeed.control.terminal({
      source: { kind: 'callback', key: 'fork-prefix-c-terminal' },
      turnId: prefixSeed.turnId,
      terminalStatus: 'completed',
      reason: 'fixture completed before second input'
    });
    const prefixBControl = createTurnControl(ctx, 'fork-prefix-b');
    const prefixB = await prefixBControl.input({
      source: { kind: 'command', key: 'fork-prefix-b-input' },
      conversationId: prefixSeed.conversationId,
      leaseOwnerId: 'fork-prefix-b-executor',
      hostBootId: ctx.database.hostBootId,
      leaseExpiresAt: '2026-08-02T00:00:00.000Z',
      content: 'user-input-fork-prefix-b'
    });
    const prefixRootId = await context.currentHeadRootId(prefixSeed.conversationId);
    const prefixCSource = (await list(ctx.database, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: prefixSeed.messageRevisionId
    }))[0];
    const prefixBSource = (await list(ctx.database, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: prefixB.messageRevisionId
    }))[0];
    const prefixAuthority = (await list(ctx.database, 'AuthoritySnapshot', {
      turn_id: prefixB.turnId
    }))[0];
    assert.ok(prefixAuthority);
    const prefixCompression = await new kernel.ContextCompressionControlPlane(
      ctx.database,
      ctx.store
    ).create({
      conversationId: prefixSeed.conversationId,
      headRootId: prefixRootId,
      authoritySnapshotId: prefixAuthority.id,
      compressSegmentCount: 1,
      title: 'Fork recursive compression fixture',
      summary: 'COMPRESSED_PREFIX_C',
      idempotencyKey: 'fork-recursive-compression'
    });
    await prefixBControl.terminal({
      source: { kind: 'callback', key: 'fork-prefix-b-terminal' },
      turnId: prefixB.turnId,
      terminalStatus: 'completed',
      reason: 'fixture completed before fork'
    });
    const forkThroughB = await forks.fork({
      idempotencyKey: 'fork-prefix-through-b',
      reuseKey: 'reuse-fork-prefix-through-b',
      sourceConversationId: prefixSeed.conversationId,
      sourceContextRootId: prefixCompression.rootId,
      sourceContextEndSegmentId: prefixBSource.segment_id,
      sourceMessageRevisionId: prefixB.messageRevisionId,
      expectedCurrentMessageRevisionId: prefixB.messageRevisionId,
      sourceTurnId: prefixB.turnId,
      expectedSourceHeadRootId: prefixCompression.rootId,
      targetTitle: 'Fork through B',
      targetAgentId: prefixSeed.agentId
    });
    const forkBMemberships = (await list(ctx.database, 'MessagePartOfConversation', {
      conversation_id: forkThroughB.targetConversationId
    })).sort((left, right) => Number(left.message_seq - right.message_seq));
    assert.equal(forkBMemberships.length, 2);
    const clonedCMessageId = forkBMemberships[0].message_id;
    const clonedCCurrent = (await list(ctx.database, 'MessageCurrentRevisionLink', {
      message_id: clonedCMessageId
    }))[0];
    const clonedCRevision = await get(ctx.database, 'MessageRevision', clonedCCurrent.revision_id);
    const clonedCSource = (await list(ctx.database, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: clonedCRevision.id
    }))[0];
    assert.equal(clonedCSource.segment_id, prefixCSource.segment_id);
    const clonedCTurnLink = (await list(ctx.database, 'MessageTurnLink', {
      message_id: clonedCMessageId
    }))[0];
    const clonedCTermination = (await list(ctx.database, 'TurnTermination', {
      turn_id: clonedCTurnLink.turn_id
    }))[0];
    assert.equal(clonedCTermination.terminal_status, 'interrupted');
    assert.equal(clonedCTermination.reason, 'forked_history_snapshot');

    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('CompressionBlock').insert({
        id: 'fork-prefix-target-compression-block',
        conversation_id: forkThroughB.targetConversationId,
        status: 'enabled',
        authority_snapshot_id: 'fork-prefix-compression-authority',
        title_object_id: clonedCRevision.content_object_id,
        summary_object_id: clonedCRevision.content_object_id,
        created_at: NOW,
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('CompressionBlockSource').insert({
        id: 'fork-prefix-target-compression-source',
        compression_block_id: 'fork-prefix-target-compression-block',
        segment_id: clonedCSource.segment_id,
        position: 1n,
        created_at: NOW
      })
    ]);
    const forkBProjection = await ctx.database.clientProjectionSnapshot(forkThroughB.targetConversationId);
    const projectedBlock = forkBProjection.snapshot.activeConversationWindow.compressionBlocks.find((block) =>
      block.id === 'fork-prefix-target-compression-block'
    );
    assert.ok(projectedBlock);
    assert.equal(projectedBlock.anchor_message_id, clonedCMessageId);
    assert.notEqual(projectedBlock.anchor_message_id, prefixSeed.messageId);

    const forkBRoots = await list(ctx.database, 'ContextSequenceRoot', {
      conversation_id: forkThroughB.targetConversationId
    });
    let recursiveSourceRootId;
    for (const root of forkBRoots) {
      const materialized = await context.materializeStructure(root.id);
      if (materialized.records.some((record) => record.segment.id === clonedCSource.segment_id)) {
        recursiveSourceRootId = root.id;
        break;
      }
    }
    assert.ok(recursiveSourceRootId);
    assert.notEqual(recursiveSourceRootId, forkThroughB.targetRootId);

    const forkCOnly = await forks.fork({
      idempotencyKey: 'fork-prefix-c-only',
      reuseKey: 'reuse-fork-prefix-c-only',
      sourceConversationId: forkThroughB.targetConversationId,
      sourceContextRootId: recursiveSourceRootId,
      sourceContextEndSegmentId: clonedCSource.segment_id,
      sourceMessageRevisionId: clonedCRevision.id,
      expectedCurrentMessageRevisionId: clonedCRevision.id,
      sourceTurnId: clonedCTurnLink.turn_id,
      targetTitle: 'Recursive fork through C',
      targetAgentId: prefixSeed.agentId
    });
    const cOnlyContext = await context.materialize(forkCOnly.targetRootId);
    assert.deepEqual(cOnlyContext.segments.map((segment) => segment.segmentId), [clonedCSource.segment_id]);
    const cOnlyModelInput = cOnlyContext.segments.map((segment) => segment.content.toString('utf8')).join('\n');
    assert.match(cOnlyModelInput, /user-input-fork-prefix-c/);
    assert.doesNotMatch(cOnlyModelInput, /user-input-fork-prefix-b/);
    assertions.push('压缩后的B分支保留历史root，仍可从压缩前C递归fork并精确截止；裁断Turn降级为interrupted，Compression anchor只选目标Conversation消息');

    const failedSeed = await seedParent(ctx, 'fork-preserve-failed-turn');
    await failedSeed.control.terminal({
      source: { kind: 'callback', key: 'fork-preserve-failed-turn-terminal' },
      turnId: failedSeed.turnId,
      terminalStatus: 'failed',
      reason: 'provider_failed_before_output'
    });
    const failedRootId = await context.currentHeadRootId(failedSeed.conversationId);
    const failedSource = (await list(ctx.database, 'ContextSegmentSource', {
      source_kind: 'message_revision',
      source_id: failedSeed.messageRevisionId
    }))[0];
    const failedFork = await forks.fork({
      idempotencyKey: 'fork-preserve-failed-turn',
      reuseKey: 'reuse-fork-preserve-failed-turn',
      sourceConversationId: failedSeed.conversationId,
      sourceContextRootId: failedRootId,
      sourceContextEndSegmentId: failedSource.segment_id,
      sourceMessageRevisionId: failedSeed.messageRevisionId,
      expectedCurrentMessageRevisionId: failedSeed.messageRevisionId,
      sourceTurnId: failedSeed.turnId,
      expectedSourceHeadRootId: failedRootId,
      targetTitle: 'Fork preserves failed Turn',
      targetAgentId: failedSeed.agentId
    });
    const failedTargetMembership = (await list(ctx.database, 'MessagePartOfConversation', {
      conversation_id: failedFork.targetConversationId
    }))[0];
    const failedTargetTurnLink = (await list(ctx.database, 'MessageTurnLink', {
      message_id: failedTargetMembership.message_id
    }))[0];
    const failedTargetTermination = (await list(ctx.database, 'TurnTermination', {
      turn_id: failedTargetTurnLink.turn_id
    }))[0];
    assert.equal(failedTargetTermination.terminal_status, 'failed');
    assert.equal(failedTargetTermination.reason, 'provider_failed_before_output');
    assertions.push('完整failed Turn无需final-output fence即可保留真实终态；只有被边界裁断的Turn降级');

    // Regression: a fork boundary after a terminal ModelRequest copies the historical
    // request/operation/attempt rows through the trusted historicalCopy channel instead of
    // crashing on the creation invariant "ModelRequest insert must start prepared and non-terminal.".
    const mrSeed = await seedParent(ctx, 'fork-terminal-model-request');
    // Every fork owns copies of its Turns' frozen authority, so the request references the real one.
    const mrAuthority = (await list(ctx.database, 'AuthoritySnapshot', { turn_id: mrSeed.turnId }))[0];
    assert.ok(mrAuthority);
    const mrRecipe = await ctx.store.ingest(ctx.database, 'fork-mr-recipe', 'application/json');
    const mrOutput = await ctx.store.ingest(ctx.database, 'fork-mr-output', 'text/plain');
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').insert({
        id: 'fork-mr-request',
        turn_id: mrSeed.turnId,
        request_seq: 1n,
        status: 'prepared',
        terminal_state: null,
        provider_id: 'fork-mr-provider',
        model_id: 'fork-mr-model',
        context_window_tokens: 128000n,
        compression_threshold_tokens: 100000n,
        estimated_context_tokens: 1000n,
        authority_snapshot_id: mrAuthority.id,
        settings_snapshot_object_id: null,
        recipe_object_id: mrRecipe.id,
        usage_json: null,
        stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null },
        created_at: NOW,
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Operation').insert({
        id: 'fork-mr-operation',
        owner_kind: 'model_request',
        owner_id: 'fork-mr-request',
        operation_seq: 1n,
        tool_call_id: null,
        status: 'pending',
        created_at: NOW,
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').insert({
        id: 'fork-mr-attempt',
        operation_id: 'fork-mr-operation',
        attempt_seq: 1n,
        status: 'pending',
        created_at: NOW,
        updated_at: NOW,
        completed_at: null
      })
    ]);
    // failed 终结无需 ModelStreamFence（completed 才要求终结 fence），聚合一致性同样覆盖复制路径。
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').update('fork-mr-request', {
        status: 'terminal',
        terminal_state: 'failed',
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Operation').update('fork-mr-operation', { status: 'failed', updated_at: NOW }),
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').update('fork-mr-attempt', {
        status: 'failed',
        updated_at: NOW,
        completed_at: NOW
      })
    ]);
    const mrModelContext = await context.prepareMessageAppendMutation({
      conversationId: mrSeed.conversationId,
      messageRevisionId: 'fork-mr-model-revision',
      contentObjectId: mrOutput.id,
      contentByteLength: mrOutput.byte_length
    });
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
        id: 'fork-mr-model-message',
        created_at: NOW,
        updated_at: NOW,
        deleted_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
        id: 'fork-mr-model-revision',
        message_id: 'fork-mr-model-message',
        role: 'model',
        content_object_id: mrOutput.id,
        created_at: NOW
      }, { column: 'revision_seq', scope: { message_id: 'fork-mr-model-message' } }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
        id: 'fork-mr-model-current',
        message_id: 'fork-mr-model-message',
        revision_id: 'fork-mr-model-revision',
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
        id: 'fork-mr-model-membership',
        conversation_id: mrSeed.conversationId,
        message_id: 'fork-mr-model-message',
        created_at: NOW
      }, { column: 'message_seq', scope: { conversation_id: mrSeed.conversationId } }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
        id: 'fork-mr-model-turn-link',
        turn_id: mrSeed.turnId,
        message_id: 'fork-mr-model-message',
        role: 'model',
        created_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').insert({
        id: 'fork-mr-model-request-link',
        model_request_id: 'fork-mr-request',
        message_id: 'fork-mr-model-message',
        created_at: NOW
      }),
      ...mrModelContext.steps
    ]);
    const mrModelSegment = (await list(ctx.database, 'ContextSegmentSource', {
      source_kind: 'message_revision',
      source_id: 'fork-mr-model-revision'
    }))[0];
    assert.ok(mrModelSegment);
    await mrSeed.control.terminal({
      source: { kind: 'callback', key: 'fork-terminal-model-request-terminal' },
      turnId: mrSeed.turnId,
      terminalStatus: 'failed',
      reason: 'provider_failed_before_output'
    });
    const mrFork = await forks.fork({
      idempotencyKey: 'fork-terminal-model-request',
      reuseKey: 'reuse-fork-terminal-model-request',
      sourceConversationId: mrSeed.conversationId,
      sourceContextRootId: await context.currentHeadRootId(mrSeed.conversationId),
      sourceContextEndSegmentId: mrModelSegment.segment_id,
      sourceMessageRevisionId: 'fork-mr-model-revision',
      expectedCurrentMessageRevisionId: 'fork-mr-model-revision',
      sourceTurnId: mrSeed.turnId,
      targetTitle: 'Fork with terminal ModelRequest',
      targetAgentId: mrSeed.agentId
    });
    assert.ok(mrFork.targetConversationId);
    const copiedRequests = (await list(ctx.database, 'ModelRequest', {}))
      .filter((row) => row.id !== 'fork-mr-request');
    assert.equal(copiedRequests.length, 1);
    assert.equal(copiedRequests[0].status, 'terminal');
    assert.equal(copiedRequests[0].terminal_state, 'failed');
    assert.notEqual(copiedRequests[0].turn_id, mrSeed.turnId);
    const copiedOperations = (await list(ctx.database, 'Operation', { owner_kind: 'model_request' }))
      .filter((row) => row.id !== 'fork-mr-operation');
    assert.equal(copiedOperations.length, 1);
    assert.equal(copiedOperations[0].status, 'failed');
    const copiedAttempts = (await list(ctx.database, 'Attempt', {}))
      .filter((row) => row.operation_id === copiedOperations[0].id);
    assert.equal(copiedAttempts.length, 1);
    assert.equal(copiedAttempts[0].status, 'failed');
    const copiedRequestLinks = (await list(ctx.database, 'ModelRequestMessageLink', {}))
      .filter((row) => row.id !== 'fork-mr-model-request-link');
    assert.equal(copiedRequestLinks.length, 1);
    assert.equal(copiedRequestLinks[0].model_request_id, copiedRequests[0].id);
    assertions.push('含终结ModelRequest/Operation/Attempt的历史转录经historicalCopy通道复制进fork目标，不再撞创建不变量');

    await assert.rejects(forks.fork({
      ...baseCommand,
      idempotencyKey: 'fork-stale',
      reuseKey: 'reuse-fork-stale'
    }), /expected head is stale/);
    assert.equal((await list(ctx.database, 'ConversationReuseLink', { reuse_key: 'reuse-fork-stale' })).length, 0);
    faults.push('stale expected source head');

    const concurrent = await Promise.all(['left', 'right'].map((side) => forks.fork({
      ...baseCommand,
      idempotencyKey: `fork-${side}`,
      reuseKey: `reuse-fork-${side}`,
      expectedSourceHeadRootId: undefined,
      targetTitle: `Concurrent ${side}`
    })));
    assert.equal(new Set(concurrent.map((entry) => entry.targetConversationId)).size, 2);
    assert.ok(concurrent.every((entry) => entry.sharedRootNodeId === sourceRoot.root_node_id));
    for (const entry of concurrent) {
      const projectLink = (await list(ctx.database, 'ConversationProjectLink', {
        conversation_id: entry.targetConversationId
      }))[0];
      assert.equal(projectLink.project_context_id, sourceProjectLink.project_context_id);
    }
    metrics.concurrentForks = concurrent.length;
    metrics.sharedPrefixCopiedNodes = 0;
    assertions.push('同一parent并发fork创建独立target且均引用同一共享前缀，没有复制历史正文或节点');
    await seeded.control.delete({
      source: { kind: 'command', key: 'fork-soft-delete-source' },
      conversationId: seeded.conversationId,
      messageId: seeded.messageId
    });
    await assert.rejects(forks.fork({
      ...baseCommand,
      idempotencyKey: 'fork-historical',
      reuseKey: 'reuse-fork-historical',
      expectedSourceHeadRootId: undefined,
      targetTitle: 'Historical fork'
    }), (error) => error instanceof kernel.ConversationForkRejectedError && /分支点消息已被删除/.test(error.message));
    assert.equal((await get(ctx.database, 'Message', seeded.messageId)).deleted_at !== null, true);
    assert.equal((await list(ctx.database, 'ConversationReuseLink', { reuse_key: 'reuse-fork-historical' })).length, 0);
    faults.push('fork point soft-deleted after selection');
    assertions.push('分支只复制可见转录：分支点消息软删除后，写入器按旧Revision分支以ConversationForkRejectedError永久拒绝且不写复用关系');

    return { assertions, faults, metrics };
  });
}

async function checkAnswerRestartDelivery() {
  return withRuntime('answer-delivery', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const seeded = await seedParent(ctx, 'answer');
    await ctx.database.transaction(kernel.projectFolderAssignmentSteps({
      conversationId: seeded.conversationId,
      folder: { uri: 'file:///workspace/answer-parent', name: 'answer-parent' },
      now: NOW
    }));
    const spawned = await spawnStartedChild(ctx, seeded.turnId, 'answer', 'wait_for_answer', {
      deadline: '2026-08-01T02:00:00.000Z'
    });
    const parentProjectLink = (await list(ctx.database, 'ConversationProjectLink', {
      conversation_id: seeded.conversationId
    }))[0];
    const childProjectLink = (await list(ctx.database, 'ConversationProjectLink', {
      conversation_id: spawned.childConversationId
    }))[0];
    assert.equal(childProjectLink.project_context_id, parentProjectLink.project_context_id);
    assertions.push('Child Conversation 与 spawn 谱系在同一事务继承 Parent 的独立 ProjectContext 关系');
    const bridgeBefore = await get(ctx.database, 'AnswerBridge', spawned.answerBridgeId);
    const casBefore = await casFileCount(ctx.binding.paths.casRootPath);
    const originalTransaction = ctx.database.transaction.bind(ctx.database);
    let injected = false;
    ctx.database.transaction = async (steps) => {
      if (!injected && steps.some((step) => step.kind === 'insert' && step.domain === 'AnswerSubmission')) {
        injected = true;
        return originalTransaction([
          ...steps,
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').assert('missing-answer-fault', { status: 'active' })
        ]);
      }
      return originalTransaction(steps);
    };
    const answerCommand = {
      answerBridgeId: spawned.answerBridgeId,
      submissionId: 'answer-submission-one',
      sourceTurnId: spawned.childTurnId,
      title: 'First answer',
      content: 'durable child answer'
    };
    await assert.rejects(ctx.services.answers.submit(answerCommand), /assertion failed/);
    ctx.database.transaction = originalTransaction;
    assert.equal(await maybeGet(ctx.database, 'AnswerSubmission', answerCommand.submissionId), null);
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', { source_id: answerCommand.submissionId })).length, 0);
    assert.equal((await get(ctx.database, 'AnswerBridge', spawned.answerBridgeId)).current_submission_id, bridgeBefore.current_submission_id);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: spawned.toolCallId })).length, 0);
    assert.ok(await casFileCount(ctx.binding.paths.casRootPath) > casBefore);
    assertions.push('答案CAS publish后SQLite故障只留下raw orphan CAS，Submission/Bridge/Inbox/ToolResult均无半提交');
    faults.push('answer CAS publish followed by SQLite transaction rollback');

    const submitted = await ctx.services.answers.submit(answerCommand);
    const duplicate = await ctx.services.answers.submit(answerCommand);
    assert.equal(submitted.foregroundSettled, true);
    assert.equal(duplicate.deduplicated, true);
    await assert.rejects(ctx.services.answers.submit({
      ...answerCommand,
      content: 'conflicting replay content'
    }), /replayed with different facts/);
    assert.equal((await list(ctx.database, 'AnswerSubmission', { answer_bridge_id: spawned.answerBridgeId })).length, 1);
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', { dedupe_key: `answer:${spawned.answerBridgeId}:${answerCommand.submissionId}` })).length, 1);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: spawned.toolCallId })).length, 1);
    assert.equal((await ctx.services.answers.classifyDeliveryRecovery(submitted.submissionId)).kind, 'settled_by_answer');
    assert.equal((await list(ctx.database, 'RuntimeDelivery', { inbox_item_id: submitted.inboxItemId })).length, 0);
    assertions.push('AnswerSubmission insert、Bridge flip、Inbox dedupe与前台ToolCall结算原子提交，重复callback收敛且只有一个ToolModelResult');
    assertions.push('恢复分类读取精确ToolOutcome答案身份，前台已消费的Submission不会被误投为第二份RuntimeDelivery');

    const notify = await ctx.services.deliveries.create({
      inboxItemId: submitted.inboxItemId,
      targetConversationId: seeded.conversationId,
      phase: 'notify_only'
    });
    const second = await ctx.services.answers.submit({
      answerBridgeId: spawned.answerBridgeId,
      submissionId: 'answer-submission-two',
      sourceTurnId: spawned.childTurnId,
      content: 'newer bridge answer'
    });
    assert.equal((await get(ctx.database, 'AnswerBridge', spawned.answerBridgeId)).current_submission_id, second.submissionId);
    assert.equal((await get(ctx.database, 'RuntimeDelivery', notify.delivery.id)).state, 'pending');
    assert.equal((await get(ctx.database, 'AnswerSubmission', submitted.submissionId)).id, submitted.submissionId);
    assertions.push('Bridge切换到新submission后历史submission及其旧pending delivery继续保留');

    const current = await ctx.services.deliveries.create({
      inboxItemId: second.inboxItemId,
      targetConversationId: seeded.conversationId,
      targetTurnId: seeded.turnId,
      phase: 'current_turn'
    });
    const currentReplay = await ctx.services.deliveries.create({
      inboxItemId: second.inboxItemId,
      targetConversationId: seeded.conversationId,
      targetTurnId: seeded.turnId,
      phase: 'current_turn'
    });
    assert.equal(currentReplay.deduplicated, true);
    const injectedDelivery = await ctx.services.deliveries.advance(current.delivery.id);
    assert.equal(injectedDelivery.delivery.state, 'consumed');
    assert.equal(injectedDelivery.parentHandlingState, 'unhandled');
    assert.ok(injectedDelivery.inputLink);
    const unrelatedContent = await ctx.store.ingest(ctx.database, 'unrelated input', 'text/plain');
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
        id: 'unrelated-parent-input', turn_id: seeded.turnId, input_kind: 'other',
        content_object_id: unrelatedContent.id, state: 'consumed',
        created_at: NOW, updated_at: NOW
      })
    ]);
    assert.equal((await ctx.services.deliveries.summary(current.delivery.id)).parentHandlingState, 'unhandled');
    const handled = await ctx.services.deliveries.markInputHandled(injectedDelivery.inputLink.pending_turn_input_id);
    assert.equal(handled.parentHandlingState, 'handled');
    assertions.push('Delivery注入与InputLink同事务，handled_at只响应精确input，无关PendingTurnInput不能猜测父处理完成');

    const third = await ctx.services.answers.submit({
      answerBridgeId: spawned.answerBridgeId,
      submissionId: 'answer-submission-three',
      sourceTurnId: spawned.childTurnId,
      content: 'next-turn delivery identity'
    });
    const nullTarget = await ctx.services.deliveries.create({
      inboxItemId: third.inboxItemId,
      targetConversationId: seeded.conversationId,
      phase: 'next_turn'
    });
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('RuntimeDelivery').insert({
        id: 'duplicate-null-delivery',
        inbox_item_id: third.inboxItemId,
        target_conversation_id: seeded.conversationId,
        target_turn_id: null,
        phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null,
        state: 'pending', failure_reason: null, created_at: NOW, updated_at: NOW
      })
    ]), /UNIQUE constraint failed/);
    assert.equal((await get(ctx.database, 'RuntimeDelivery', nullTarget.delivery.id)).target_turn_id, null);
    assertions.push('Delivery以inbox、目标Conversation和attempt为逻辑身份，phase/target变化不能制造重复首个attempt');

    const matrixChild = await spawnStartedChild(ctx, seeded.turnId, 'delivery-matrix', 'background');
    const matrixContinuationTool = await createRunAgentTool(ctx, seeded.turnId, 'delivery-matrix-continuation');
    const matrixQueued = await ctx.services.children.send({
      sourceKey: 'delivery-matrix-continuation',
      sourceToolCallId: matrixContinuationTool.toolCallId,
      childExecutionId: matrixChild.childExecutionId,
      mode: 'queue_next_turn',
      content: 'admit delivery matrix continuation',
      completionPolicy: 'background'
    });
    const matrixSubmissions = [];
    for (const suffix of ['current-terminal', 'next-terminal', 'next-none', 'notify']) {
      matrixSubmissions.push(await ctx.services.answers.submit({
        answerBridgeId: matrixChild.answerBridgeId,
        submissionId: `delivery-matrix-${suffix}`,
        sourceTurnId: matrixChild.childTurnId,
        content: `matrix answer ${suffix}`
      }));
    }
    const matrixCurrent = await ctx.services.deliveries.create({
      inboxItemId: matrixSubmissions[0].inboxItemId,
      targetConversationId: matrixChild.childConversationId,
      targetTurnId: matrixChild.childTurnId,
      phase: 'current_turn'
    });
    const matrixNextTerminal = await ctx.services.deliveries.create({
      inboxItemId: matrixSubmissions[1].inboxItemId,
      targetConversationId: matrixChild.childConversationId,
      targetTurnId: matrixChild.childTurnId,
      phase: 'next_turn'
    });
    const matrixNextNone = await ctx.services.deliveries.create({
      inboxItemId: matrixSubmissions[2].inboxItemId,
      targetConversationId: matrixChild.childConversationId,
      phase: 'next_turn'
    });
    const matrixNotify = await ctx.services.deliveries.create({
      inboxItemId: matrixSubmissions[3].inboxItemId,
      targetConversationId: matrixChild.childConversationId,
      phase: 'notify_only'
    });
    const matrixTurnControl = createTurnControl(ctx, 'delivery-matrix-child');
    await matrixTurnControl.terminal({
      source: { kind: 'callback', key: 'delivery-matrix-terminal' },
      turnId: matrixChild.childTurnId,
      terminalStatus: 'completed',
      reason: 'delivery advancement matrix fixture'
    });
    const retargetedCurrent = await ctx.services.deliveries.advance(matrixCurrent.delivery.id);
    const retargetedNext = await ctx.services.deliveries.advance(matrixNextTerminal.delivery.id);
    const waitingNext = await ctx.services.deliveries.advance(matrixNextNone.delivery.id);
    const waitingNotify = await ctx.services.deliveries.advance(matrixNotify.delivery.id);
    assert.equal(retargetedCurrent.delivery.phase, 'next_turn');
    assert.equal(retargetedCurrent.delivery.target_turn_id, null);
    assert.equal(retargetedNext.delivery.phase, 'next_turn');
    assert.equal(retargetedNext.delivery.target_turn_id, null);
    assert.equal(waitingNext.changed, false);
    assert.equal(waitingNext.delivery.state, 'pending');
    assert.equal(waitingNotify.changed, false);
    assert.equal((await ctx.services.deliveries.acknowledgeNotification(matrixNotify.delivery.id)).parentHandlingState, 'not_applicable');
    await assert.rejects(ctx.services.answers.submit({
      answerBridgeId: matrixChild.answerBridgeId,
      submissionId: 'delivery-matrix-late-interrupted',
      sourceTurnId: matrixChild.childTurnId,
      content: 'stale terminal generation answer'
    }), /stale or terminal Child Turn/);
    assert.equal((await get(ctx.database, 'Turn', matrixChild.childTurnId)).status, 'terminated');
    const matrixContinuation = await ctx.services.children.admitQueuedIntent({
      sourceKey: 'delivery-matrix-admit',
      childExecutionId: matrixChild.childExecutionId,
      turnIntentId: matrixQueued.turnIntentId,
      leaseOwnerId: 'delivery-matrix-owner',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    });
    for (const deliveryId of [matrixCurrent.delivery.id, matrixNextTerminal.delivery.id, matrixNextNone.delivery.id]) {
      const summary = await ctx.services.deliveries.summary(deliveryId);
      assert.equal(summary.delivery.state, 'consumed');
      assert.equal(summary.delivery.target_turn_id, matrixContinuation.turnId);
      assert.ok(summary.inputLink);
    }
    const continuationAnswer = await ctx.services.answers.submit({
      answerBridgeId: matrixChild.answerBridgeId,
      submissionId: 'delivery-matrix-continuation-answer',
      sourceTurnId: matrixContinuation.turnId,
      content: 'continuation generation answer'
    });
    const matrixNextActive = await ctx.services.deliveries.create({
      inboxItemId: continuationAnswer.inboxItemId,
      targetConversationId: matrixChild.childConversationId,
      targetTurnId: matrixContinuation.turnId,
      phase: 'next_turn'
    });
    assert.equal((await ctx.services.deliveries.advance(matrixNextActive.delivery.id)).delivery.state, 'consumed');
    assert.equal((await get(ctx.database, 'Turn', matrixChild.childTurnId)).status, 'terminated');
    assertions.push('current/next/notify advancement matrix逐项走真实Turn状态：terminal改投、NULL等待、新Turn启动事务回写注入、active注入、notify显式确认；旧generation提交被拒绝且新generation可提交');
    faults.push('delivery advancement across terminal-to-continuation boundary');

    const gone = await ctx.services.deliveries.create({
      inboxItemId: second.inboxItemId,
      targetConversationId: 'gone-conversation',
      phase: 'notify_only'
    });
    assert.equal(gone.delivery.state, 'failed');
    assert.equal(gone.delivery.failure_reason, 'target-gone');
    const retried = await ctx.services.deliveries.redeliver(gone.delivery.id);
    assert.equal(retried.delivery.attempt_seq, 2n);
    assert.equal(retried.delivery.retry_of_delivery_id, gone.delivery.id);
    assert.equal((await get(ctx.database, 'RuntimeDelivery', gone.delivery.id)).state, 'failed');
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(gone.delivery.id, {
        state: 'pending', failure_reason: null, updated_at: NOW
      })
    ]), /cannot transition from failed to pending/);
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').update(injectedDelivery.inputLink.id, {
        handled_at: '2026-08-01T00:01:00.000Z', updated_at: '2026-08-01T00:01:00.000Z'
      })
    ]), /may only transition once/);
    assertions.push('target-gone保留Inbox并置failed；人工redeliver创建attempt+1/retry_of新行；writer拒绝复活旧failed或重写handled_at');

    const racedChild = await spawnStartedChild(ctx, seeded.turnId, 'answer-deadline-race', 'wait_for_answer', {
      deadline: NOW
    });
    const [raceAnswer, timeoutWon] = await Promise.all([
      ctx.services.answers.submit({
        answerBridgeId: racedChild.answerBridgeId,
        submissionId: 'answer-deadline-race-submission',
        sourceTurnId: racedChild.childTurnId,
        content: 'first wins race answer'
      }),
      ctx.services.children.settleForegroundTimeout(racedChild.childExecutionId, NOW)
    ]);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: racedChild.toolCallId })).length, 1);
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', { source_id: raceAnswer.submissionId })).length, 1);
    assert.equal(Number(raceAnswer.foregroundSettled) + Number(timeoutWon) <= 1, true);
    assertions.push('答案提交与deadline sweep并发由SQLite assertion/UNIQUE durable first-wins，原ToolCall严格一个模型结果，败方答案仍入Inbox');
    faults.push('answer arrival concurrent with foreground deadline sweep');

    const generationParent = await seedParent(ctx, 'answer-generation-owner');
    const generationChild = await spawnStartedChild(
      ctx,
      generationParent.turnId,
      'answer-generation-owner',
      'wait_for_answer',
      { deadline: '2026-08-01T02:00:00.000Z' }
    );
    await createTurnControl(ctx, 'answer-generation-initial-terminal').terminal({
      source: { kind: 'callback', key: 'answer-generation-initial-terminal' },
      turnId: generationChild.childTurnId,
      terminalStatus: 'completed',
      reason: 'advance fixture to first continuation generation'
    });
    await ctx.services.children.observeTurnTerminal(
      generationChild.childExecutionId,
      generationChild.childTurnId
    );
    const generationToolA = await createRunAgentTool(
      ctx,
      generationParent.turnId,
      'answer-generation-a'
    );
    const generationWaitA = await ctx.services.children.send({
      sourceKey: 'answer-generation-a',
      sourceToolCallId: generationToolA.toolCallId,
      childExecutionId: generationChild.childExecutionId,
      mode: 'queue_next_turn',
      content: 'generation A',
      completionPolicy: 'wait_for_answer',
      waitDeadlineAt: '2026-08-01T02:00:00.000Z'
    });
    const generationA = await ctx.services.children.admitQueuedIntent({
      sourceKey: 'answer-generation-admit-a',
      childExecutionId: generationChild.childExecutionId,
      turnIntentId: generationWaitA.turnIntentId,
      leaseOwnerId: 'answer-generation-owner-a',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    });
    const generationToolB = await createRunAgentTool(
      ctx,
      generationParent.turnId,
      'answer-generation-b'
    );
    const generationWaitB = await ctx.services.children.send({
      sourceKey: 'answer-generation-b',
      sourceToolCallId: generationToolB.toolCallId,
      childExecutionId: generationChild.childExecutionId,
      mode: 'queue_next_turn',
      content: 'generation B',
      completionPolicy: 'wait_for_answer',
      waitDeadlineAt: '2026-08-01T02:00:00.000Z'
    });
    const operationA = await get(ctx.database, 'Operation', generationWaitA.operationId);
    const operationB = await get(ctx.database, 'Operation', generationWaitB.operationId);
    assert.equal(operationA.owner_kind, 'child_turn_answer_wait');
    assert.equal(operationA.owner_id, generationA.turnId);
    assert.equal(operationA.created_at, operationB.created_at);
    assert.notEqual(operationA.owner_id, operationB.owner_id);
    const generationAnswerA = await ctx.services.answers.submit({
      answerBridgeId: generationChild.answerBridgeId,
      submissionId: 'answer-generation-submission-a',
      sourceTurnId: generationA.turnId,
      content: 'answer from generation A'
    });
    const generationSettledA = await ctx.services.answers.reconcileCommittedWaits(
      generationAnswerA.submissionId
    );
    assert.equal(generationAnswerA.foregroundSettled, true);
    assert.deepEqual(generationSettledA.newlySettledToolCallIds, [generationToolA.toolCallId]);
    assert.equal((await get(ctx.database, 'Operation', generationWaitA.operationId)).status, 'succeeded');
    assert.equal((await get(ctx.database, 'Operation', generationWaitB.operationId)).status, 'waiting_answer');
    await createTurnControl(ctx, 'answer-generation-a-terminal').terminal({
      source: { kind: 'callback', key: 'answer-generation-a-terminal' },
      turnId: generationA.turnId,
      terminalStatus: 'completed',
      reason: 'advance fixture to second continuation generation'
    });
    const generationB = await ctx.services.children.admitQueuedIntent({
      sourceKey: 'answer-generation-admit-b',
      childExecutionId: generationChild.childExecutionId,
      turnIntentId: generationWaitB.turnIntentId,
      leaseOwnerId: 'answer-generation-owner-b',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    });
    assert.equal((await get(ctx.database, 'Operation', generationWaitB.operationId)).owner_id, generationB.turnId);
    const generationAnswerB = await ctx.services.answers.submit({
      answerBridgeId: generationChild.answerBridgeId,
      submissionId: 'answer-generation-submission-b',
      sourceTurnId: generationB.turnId,
      content: 'answer from generation B'
    });
    const generationSettledB = await ctx.services.answers.reconcileCommittedWaits(
      generationAnswerB.submissionId
    );
    assert.deepEqual(generationSettledB.newlySettledToolCallIds, [generationToolB.toolCallId]);
    assert.equal((await get(ctx.database, 'Operation', generationWaitB.operationId)).status, 'succeeded');
    assertions.push('同毫秒创建的两代continuation wait以未来Turn稳定身份隔离；A答案独立结算初始wait与A wait而不触碰B，B仅由B来源Turn答案结算');
    faults.push('same-millisecond continuation generations with multiple independently settling waits');

    const legacyParent = await seedParent(ctx, 'answer-legacy-owner');
    const legacyChild = await spawnStartedChild(
      ctx,
      legacyParent.turnId,
      'answer-legacy-owner',
      'background'
    );
    await createTurnControl(ctx, 'answer-legacy-initial-terminal').terminal({
      source: { kind: 'callback', key: 'answer-legacy-initial-terminal' },
      turnId: legacyChild.childTurnId,
      terminalStatus: 'completed',
      reason: 'advance fixture to legacy continuation'
    });
    await ctx.services.children.observeTurnTerminal(
      legacyChild.childExecutionId,
      legacyChild.childTurnId
    );
    const legacyTool = await createRunAgentTool(ctx, legacyParent.turnId, 'answer-legacy-wait');
    const legacyWait = await ctx.services.children.send({
      sourceKey: 'answer-legacy-wait',
      sourceToolCallId: legacyTool.toolCallId,
      childExecutionId: legacyChild.childExecutionId,
      mode: 'queue_next_turn',
      content: 'legacy wait',
      completionPolicy: 'wait_for_answer',
      waitDeadlineAt: '2026-08-01T02:00:00.000Z'
    });
    const legacyGeneration = await ctx.services.children.admitQueuedIntent({
      sourceKey: 'answer-legacy-admit',
      childExecutionId: legacyChild.childExecutionId,
      turnIntentId: legacyWait.turnIntentId,
      leaseOwnerId: 'answer-legacy-generation-owner',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    });
    for (let offset = 0; offset < 1001; offset += 250) {
      await ctx.database.transaction(Array.from(
        { length: Math.min(250, 1001 - offset) },
        (_unused, index) => {
          const sequence = offset + index;
          const padded = String(sequence).padStart(4, '0');
          return kernel.DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
            id: `000-legacy-noise-${padded}`,
            source_kind: 'command',
            source_key: `answer-legacy-noise-${padded}`,
            conversation_id: legacyParent.conversationId,
            turn_id: legacyParent.turnId,
            created_at: NOW
          });
        }
      ));
    }
    await closeRuntime(ctx);
    mutateSqlite(ctx.binding.paths.databasePath, (database) => {
      database.prepare(`
        UPDATE operation
        SET owner_kind = 'answer_bridge_wait', owner_id = ?
        WHERE id = ?
      `).run(legacyChild.answerBridgeId, legacyWait.operationId);
    });
    await reopenRuntime(ctx, 'answer-legacy-owner-restart');
    const legacyAnswer = await ctx.services.answers.submit({
      answerBridgeId: legacyChild.answerBridgeId,
      submissionId: 'answer-legacy-owner-submission',
      sourceTurnId: legacyGeneration.turnId,
      content: 'recover exact legacy wait'
    });
    const legacySettlement = await ctx.services.answers.reconcileCommittedWaits(
      legacyAnswer.submissionId
    );
    assert.deepEqual(legacySettlement.newlySettledToolCallIds, [legacyTool.toolCallId]);
    assert.equal((await get(ctx.database, 'Operation', legacyWait.operationId)).status, 'succeeded');
    assertions.push('持久legacy answer_bridge_wait在同parent Turn的1001条干扰CommandReceipt之后，仍由Operation/Receipt/Intent/immutable mode preset完整稳定身份精确恢复');
    faults.push('legacy answer_bridge_wait persisted across restart beyond a 1000-row identity boundary');

    const longHistoryParent = await seedParent(ctx, 'answer-long-child-history');
    const longHistoryChild = await spawnStartedChild(
      ctx,
      longHistoryParent.turnId,
      'answer-long-child-history',
      'background'
    );
    await createTurnControl(ctx, 'answer-long-child-history-terminal').terminal({
      source: { kind: 'callback', key: 'answer-long-child-history-terminal' },
      turnId: longHistoryChild.childTurnId,
      terminalStatus: 'completed',
      reason: 'prepare uncapped child history fixture'
    });
    await ctx.services.children.observeTurnTerminal(
      longHistoryChild.childExecutionId,
      longHistoryChild.childTurnId
    );
    await closeRuntime(ctx);
    mutateSqlite(ctx.binding.paths.databasePath, (database) => {
      const insertTurn = database.prepare(`
        INSERT INTO turn (id, conversation_id, status, created_at, updated_at, terminal_at)
        VALUES (?, ?, 'terminated', ?, ?, ?)
      `);
      const insertMembership = database.prepare(`
        INSERT INTO child_execution_turn_link
          (id, child_execution_id, turn_seq, turn_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (let index = 0; index < 1001; index += 1) {
        const turnId = `long-history-turn-${String(index).padStart(4, '0')}`;
        insertTurn.run(turnId, longHistoryChild.childConversationId, NOW, NOW, NOW);
        insertMembership.run(
          `long-history-link-${String(index).padStart(4, '0')}`,
          longHistoryChild.childExecutionId,
          BigInt(index + 2),
          turnId,
          NOW
        );
      }
    });
    await reopenRuntime(ctx, 'answer-delivery-restart');
    assert.equal((await get(ctx.database, 'AnswerSubmission', second.submissionId)).interrupted, 0n);
    assert.equal((await ctx.services.deliveries.summary(current.delivery.id)).parentHandlingState, 'handled');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: spawned.toolCallId })).length, 1);
    const longHistorySnapshot = await ctx.services.children.readExecutionSnapshot(
      longHistoryChild.childExecutionId
    );
    assert.equal(longHistorySnapshot.turnLinks.length, 1002);
    assert.equal(String(longHistorySnapshot.turnLinks.at(-1).turn_seq), '1002');
    assertions.push('关闭数据库并新建RuntimeDatabase/services后答案、历史delivery、InputLink.handled_at和唯一ToolResult全部由SQLite恢复');
    assertions.push('ChildExecution精确历史读取跨越1000条Turn membership，保留第1002代而不依赖全局LIMIT或目标行排序');
    faults.push('Extension Host database/service restart');
    metrics.answerSubmissions = (await list(ctx.database, 'AnswerSubmission', { answer_bridge_id: spawned.answerBridgeId })).length;
    metrics.deliveryAttemptsForGoneTarget = (await list(ctx.database, 'RuntimeDelivery', {
      inbox_item_id: second.inboxItemId,
      target_conversation_id: 'gone-conversation'
    })).length;
    return { assertions, faults, metrics };
  });
}

async function checkCancelSubtree() {
  return withRuntime('cancel-subtree', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const parent = await seedParent(ctx, 'cancel');
    const atomicTool = await createRunAgentTool(ctx, parent.turnId, 'spawn-atomic');
    const atomicSpawnCommand = {
      sourceToolCallId: atomicTool.toolCallId,
      childAgentId: 'child-agent-spawn-atomic',
      modelFallback: CHILD_MODEL_FALLBACK,
      sourceSettlement: 'child_handle',
      prompt: 'atomic concurrent spawn',
      completionPolicy: 'background',
      leaseOwnerId: 'child-owner-spawn-atomic',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    };
    const originalTransaction = ctx.database.transaction.bind(ctx.database);
    // spawn retries a transaction assertion failure (a concurrent capacity or membership change),
    // so the fault stays armed for the whole call: every attempt must roll back its lineage facts.
    let spawnFaultAttempts = 0;
    ctx.database.transaction = async (steps) => {
      if (steps.some((step) => step.kind === 'insert' && step.domain === 'ChildExecution')) {
        spawnFaultAttempts += 1;
        return originalTransaction([
          ...steps,
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').assert('missing-spawn-fault', { status: 'active' })
        ]);
      }
      return originalTransaction(steps);
    };
    try {
      await assert.rejects(ctx.services.children.spawn(atomicSpawnCommand), /assertion failed/);
    } finally {
      ctx.database.transaction = originalTransaction;
    }
    assert.ok(spawnFaultAttempts > 1, 'spawn retries an assertion failure before giving up');
    assert.equal((await list(ctx.database, 'ChildExecutionParentLink', {
      source_tool_call_id: atomicTool.toolCallId
    })).length, 0);
    assert.equal((await list(ctx.database, 'ChildExecution', {})).length, 0);
    assert.equal((await get(ctx.database, 'ToolCall', atomicTool.toolCallId)).status, 'pending');
    const concurrentSpawns = await Promise.all([
      ctx.services.children.spawn(atomicSpawnCommand),
      ctx.services.children.spawn(atomicSpawnCommand)
    ]);
    assert.equal(new Set(concurrentSpawns.map((entry) => entry.childExecutionId)).size, 1);
    assert.deepEqual(concurrentSpawns.map((entry) => entry.deduplicated).sort(), [false, true]);
    const preparedSpawn = concurrentSpawns[0];
    assert.equal(await ctx.services.children.claimSpawnDispatch(preparedSpawn.effectIntentId), true);
    assert.equal(await ctx.services.children.claimSpawnDispatch(preparedSpawn.effectIntentId), false);
    const spawnReceiptOne = await ctx.services.children.recordSpawnReceipt({
      sourceKey: 'spawn-atomic-callback',
      attemptId: preparedSpawn.attemptId,
      outcome: 'succeeded',
      detail: { adapter: 'deterministic-fake' }
    });
    const spawnReceiptTwo = await ctx.services.children.recordSpawnReceipt({
      sourceKey: 'spawn-atomic-callback',
      attemptId: preparedSpawn.attemptId,
      outcome: 'succeeded',
      detail: { adapter: 'deterministic-fake' }
    });
    assert.equal(spawnReceiptTwo.effectReceiptId, spawnReceiptOne.effectReceiptId);
    const spawnSettlementOne = await ctx.services.children.reconcileSpawnReceipt(spawnReceiptOne.effectReceiptId);
    const spawnSettlementTwo = await ctx.services.children.reconcileSpawnReceipt(spawnReceiptOne.effectReceiptId);
    assert.equal(spawnSettlementOne.terminalToolResult, true);
    assert.equal(spawnSettlementTwo.deduplicated, true);
    const spawnedOrigin = (await list(ctx.database, 'ConversationOriginLink', {
      conversation_id: preparedSpawn.childConversationId
    }))[0];
    assert.ok(spawnedOrigin);
    assert.equal(spawnedOrigin.source_conversation_id, parent.conversationId);
    assert.equal(spawnedOrigin.source_turn_id, parent.turnId);
    assert.equal(spawnedOrigin.source_tool_call_id, atomicTool.toolCallId);
    assert.equal((await ctx.services.children.ensureConversationOrigin(preparedSpawn.childExecutionId)).created, false);

    const legacyOriginToolCallId = 'run-agent-call-legacy-origin-backfill';
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'conversation-legacy-child-origin',
        title: 'legacy child without origin projection',
        status: 'active',
        created_at: NOW,
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ChildExecution').insert({
        id: 'child-execution-legacy-origin',
        child_conversation_id: 'conversation-legacy-child-origin',
        status: 'idle',
        created_at: NOW,
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').insert({
        id: 'child-parent-link-legacy-origin',
        child_execution_id: 'child-execution-legacy-origin',
        source_tool_call_id: legacyOriginToolCallId,
        parent_child_execution_id: null,
        parent_turn_id: parent.turnId,
        created_at: NOW
      })
    ]);
    assert.equal((await list(ctx.database, 'ConversationOriginLink', {
      conversation_id: 'conversation-legacy-child-origin'
    })).length, 0);
    await ctx.services.recovery.runAll();
    const repairedOrigin = (await list(ctx.database, 'ConversationOriginLink', {
      conversation_id: 'conversation-legacy-child-origin'
    }))[0];
    assert.ok(repairedOrigin);
    assert.equal(repairedOrigin.source_conversation_id, parent.conversationId);
    assert.equal(repairedOrigin.source_turn_id, parent.turnId);
    assert.equal(repairedOrigin.source_tool_call_id, legacyOriginToolCallId);
    await assert.rejects(ctx.services.children.spawn({
      ...atomicSpawnCommand,
      prompt: 'conflicting replay prompt'
    }), /replayed with different facts/);
    assertions.push('spawn原子写入ConversationOriginLink；启动恢复为旧ChildExecution补建稳定父对话lineage；并发同源spawn、重复dispatch/callback/reconcile按稳定identity收敛且不同请求不伪装dedupe');
    faults.push('spawn writer transaction fault after lineage/effect facts');
    faults.push('concurrent identical spawn and duplicate callback');

    const childA = await spawnStartedChild(ctx, parent.turnId, 'tree-a', 'background');
    const childB = await spawnStartedChild(ctx, childA.childTurnId, 'tree-b', 'background');
    const sibling = await spawnStartedChild(ctx, parent.turnId, 'tree-sibling', 'background');

    const queuedATool = await createRunAgentTool(ctx, parent.turnId, 'queue-a-continuation');
    const queuedA = await ctx.services.children.send({
      sourceKey: 'queue-a-continuation',
      sourceToolCallId: queuedATool.toolCallId,
      childExecutionId: childA.childExecutionId,
      mode: 'queue_next_turn',
      content: 'continue A',
      completionPolicy: 'background'
    });
    const childTurnControl = createTurnControl(ctx, 'child-a');
    await childTurnControl.terminal({
      source: { kind: 'callback', key: 'terminal-a-old-turn' },
      turnId: childA.childTurnId,
      terminalStatus: 'completed',
      reason: 'continuation fixture'
    });
    const continuedA = await ctx.services.children.admitQueuedIntent({
      sourceKey: 'admit-a-continuation',
      childExecutionId: childA.childExecutionId,
      turnIntentId: queuedA.turnIntentId,
      leaseOwnerId: 'continued-a-owner',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    });
    // Only B's own parent Conversation (A) may queue a continuation for it.
    const pendingBTool = await createRunAgentTool(ctx, continuedA.turnId, 'queue-b-pending');
    const pendingB = await ctx.services.children.send({
      sourceKey: 'queue-b-pending',
      sourceToolCallId: pendingBTool.toolCallId,
      childExecutionId: childB.childExecutionId,
      mode: 'queue_next_turn',
      content: 'pending B',
      completionPolicy: 'background'
    });
    const parentLinkB = (await list(ctx.database, 'ChildExecutionParentLink', {
      child_execution_id: childB.childExecutionId
    }))[0];
    assert.equal(parentLinkB.parent_child_execution_id, childA.childExecutionId);
    assert.equal(parentLinkB.parent_turn_id, childA.childTurnId);
    assertions.push('ChildExecution稳定ParentLink不随A continuation改写，B仍从旧Turn历史来源归属A树');

    const racedDescendantTool = await createRunAgentTool(ctx, continuedA.turnId, 'tree-raced-descendant');
    const racedDescendantCommand = {
      sourceToolCallId: racedDescendantTool.toolCallId,
      childAgentId: 'child-agent-tree-raced-descendant',
      modelFallback: CHILD_MODEL_FALLBACK,
      sourceSettlement: 'child_handle',
      prompt: 'commit exactly between cancel tree read and writer transaction',
      completionPolicy: 'background',
      leaseOwnerId: 'child-owner-tree-raced-descendant',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    };
    let racedDescendant;
    let cancelRaceInjected = false;
    ctx.database.transaction = async (steps) => {
      if (
        !cancelRaceInjected
        && steps.some((step) => step.kind === 'assertExactIds' && step.domain === 'ChildExecutionParentLink')
      ) {
        cancelRaceInjected = true;
        racedDescendant = await ctx.services.children.spawn(racedDescendantCommand);
        ctx.database.transaction = originalTransaction;
      }
      return originalTransaction(steps);
    };
    const cancelled = await ctx.services.children.interruptSubtree({
      sourceKey: 'cancel-tree-a',
      childExecutionId: childA.childExecutionId,
      reason: 'test subtree cancellation'
    });
    ctx.database.transaction = originalTransaction;
    assert.ok(racedDescendant);
    assert.deepEqual(new Set(cancelled.lineageIds), new Set([
      childA.childExecutionId,
      childB.childExecutionId,
      racedDescendant.childExecutionId
    ]));
    assert.ok(cancelled.activeTurnIds.includes(continuedA.turnId));
    assert.ok(cancelled.activeTurnIds.includes(childB.childTurnId));
    assert.ok(cancelled.activeTurnIds.includes(racedDescendant.childTurnId));
    assert.ok(cancelled.cancelledIntentIds.includes(pendingB.turnIntentId));
    const cancellationInputs = await list(ctx.database, 'PendingTurnInput', { input_kind: 'termination_request' });
    assert.ok(cancellationInputs.some((row) => row.turn_id === continuedA.turnId));
    assert.ok(cancellationInputs.some((row) => row.turn_id === childB.childTurnId));
    assert.ok(cancellationInputs.some((row) => row.turn_id === racedDescendant.childTurnId));
    assert.equal((await get(ctx.database, 'ChildExecutionIntentLink', pendingB.intentLinkId)).state, 'cancelled');
    assert.equal((await get(ctx.database, 'TurnIntent', pendingB.turnIntentId)).state, 'cancelled');
    assert.equal((await get(ctx.database, 'Turn', continuedA.turnId)).status, 'active');
    assert.equal((await list(ctx.database, 'TurnTermination', { turn_id: continuedA.turnId })).length, 0);
    assertions.push('interrupt_subtree用writer exact-set封住读写间并发spawn，重读稳定ParentLink后在同一成功事务覆盖全部active targets并取消pending Intent；请求本身不伪造Turn终态');

    assert.equal((await get(ctx.database, 'ChildExecution', sibling.childExecutionId)).status, 'active');
    assert.equal((await list(ctx.database, 'PendingTurnInput', {
      turn_id: sibling.childTurnId,
      input_kind: 'termination_request'
    })).length, 0);
    const siblingCancel = await ctx.services.children.interruptSubtree({
      sourceKey: 'single-cancel-sibling',
      childExecutionId: sibling.childExecutionId,
      reason: 'single cancel'
    });
    assert.deepEqual(siblingCancel.activeTurnIds, [sibling.childTurnId]);
    assertions.push('A子树中断不误伤sibling/其他根树；叶节点interrupt_subtree只向该谱系当前ActiveTurnLink target写正常终止请求');

    const pendingDescendantTool = await createRunAgentTool(ctx, continuedA.turnId, 'blocked-descendant');
    await assert.rejects(ctx.services.children.spawn({
      sourceToolCallId: pendingDescendantTool.toolCallId,
      childAgentId: 'blocked-agent',
      modelFallback: CHILD_MODEL_FALLBACK,
      sourceSettlement: 'child_handle',
      prompt: 'must not spawn',
      completionPolicy: 'background',
      leaseOwnerId: 'blocked-owner',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    }), /parent lineage is terminating/);
    assert.equal((await list(ctx.database, 'ChildExecutionParentLink', {
      source_tool_call_id: pendingDescendantTool.toolCallId
    })).length, 0);
    assertions.push('父树登记interrupt_subtree后spawn在写入前拒绝，不留下半创建lineage');

    const planParent = await seedParent(ctx, 'plan-external-settlement');
    const planRequest = {
      plan: '把已批准 Plan 交给独立 Agent 对话执行。',
      taskList: {
        mode: 'rewrite',
        items: [
          { title: '创建可靠子执行', status: 'in_progress' },
          { title: '保留 PlanReview 唯一结算权', status: 'pending' }
        ]
      }
    };
    const planTool = await ctx.services.effects.createToolCall({
      source: { kind: 'callback', key: 'plan-external-tool' },
      toolCallId: 'submit-plan-call-external-settlement',
      turnId: planParent.turnId,
      toolName: 'submit_plan',
      arguments: planRequest
    });
    const planInteractions = new kernel.ToolInteractionControlPlane(
      ctx.database,
      ctx.store,
      ctx.services.effects
    );
    const planPause = await planInteractions.pauseForPlanReview({
      source: { kind: 'internal', key: 'plan-external-pause' },
      toolCallId: planTool.toolCallId,
      request: planRequest
    });
    const planOperation = await get(ctx.database, 'Operation', planPause.operationId);
    assert.equal(planOperation.status, 'waiting_answer');
    const externalIdentity = kernel.childExecutionSpawnIdentity({
      sourceToolCallId: planTool.toolCallId
    });
    let externalEnsureAttempts = 0;
    let externalSpawn;
    let delegatedPlanPrompt;
    planInteractions.setPlanDelegator({
      preview: async ({ requestedAgentId }) => ({
        ...externalIdentity,
        agentId: requestedAgentId,
        agentType: 'plan-external'
      }),
      ensure: async (request) => {
        externalEnsureAttempts += 1;
        delegatedPlanPrompt = request.prompt;
        assert.deepEqual(request.expected, {
          childExecutionId: externalIdentity.childExecutionId,
          childConversationId: externalIdentity.childConversationId,
          answerBridgeId: externalIdentity.answerBridgeId,
          agentId: 'agent-plan-external',
          agentType: 'plan-external'
        });
        externalSpawn = await ctx.services.children.spawn({
          sourceToolCallId: planTool.toolCallId,
          childAgentId: 'agent-plan-external',
          modelFallback: CHILD_MODEL_FALLBACK,
          sourceSettlement: 'external',
          prompt: `${request.prompt}\n\n[Agent answer bridge]\n本次任务已绑定默认回答通道。需要提交阶段性结论或最终正文时调用 submit_agent_answer({ title, content })，并省略 childRef；Runtime 会使用当前子任务的默认通道。显式 childRef 也必须属于当前子任务，不能提交到其它任务的答案通道。同伴交流使用 send_agent_message，向已有同伴续派任务使用 followup_agent_task。继续同一子对话、中断或重试不会改变默认通道。`,
          completionPolicy: 'background',
          leaseOwnerId: `child-owner-plan-external-${externalEnsureAttempts}`,
          leaseExpiresAt: `2026-08-0${externalEnsureAttempts + 1}T00:00:00.000Z`
        });
        if (externalEnsureAttempts === 1) {
          throw new Error('fault-after-plan-child-spawn-before-launch');
        }
        const claimed = await ctx.services.children.claimSpawnDispatch(externalSpawn.effectIntentId);
        if (claimed) {
          const externalReceipt = await ctx.services.children.recordSpawnReceipt({
            sourceKey: 'plan-external-spawn-receipt',
            attemptId: externalSpawn.attemptId,
            outcome: 'succeeded',
            detail: { adapter: 'deterministic-plan-external' }
          });
          const externalSettlement = await ctx.services.children.reconcileSpawnReceipt(
            externalReceipt.effectReceiptId
          );
          assert.equal(externalSettlement.terminalToolResult, false);
        } else {
          const recovered = await ctx.services.children.recoverSpawnIntent(externalSpawn.effectIntentId);
          assert.equal(recovered.childStatus, 'active');
        }
        return {
          childExecutionId: externalSpawn.childExecutionId,
          childConversationId: externalSpawn.childConversationId,
          childTurnId: externalSpawn.childTurnId,
          answerBridgeId: externalSpawn.answerBridgeId,
          agentId: request.requestedAgentId,
          agentType: 'plan-external'
        };
      }
    });
    const approvedPlanInput = {
      source: { kind: 'command', key: 'plan-external-approve' },
      requestId: planPause.requestId,
      decision: 'accept',
      response: {
        planProposalId: planPause.proposalId,
        executionTarget: 'new_conversation',
        agentType: 'agent-plan-external'
      }
    };
    await assert.rejects(
      planInteractions.resolvePlanReview(approvedPlanInput),
      /fault-after-plan-child-spawn-before-launch/
    );
    assert.equal(externalEnsureAttempts, 1);
    assert.equal((await list(ctx.database, 'InteractionResponse', {
      request_id: planPause.requestId
    })).length, 1);
    assert.equal((await list(ctx.database, 'ChildExecutionParentLink', {
      source_tool_call_id: planTool.toolCallId
    })).length, 1);
    assert.equal((await get(ctx.database, 'ChildExecution', externalSpawn.childExecutionId)).status, 'starting');
    assert.equal((await get(ctx.database, 'Operation', externalSpawn.operationId)).status, 'pending');
    assert.equal((await get(ctx.database, 'Operation', externalSpawn.operationId)).tool_call_id, null);
    assert.equal((await get(ctx.database, 'ToolCall', planTool.toolCallId)).status, 'waiting_answer');
    assert.equal((await list(ctx.database, 'ToolExecution', {
      tool_call_id: planTool.toolCallId
    }))[0].status, 'waiting_answer');
    assert.equal((await get(ctx.database, 'Operation', planPause.operationId)).status, 'waiting_answer');
    assert.equal((await list(ctx.database, 'ToolResultArtifact', {
      tool_call_id: planTool.toolCallId
    })).length, 0);
    assert.equal((await list(ctx.database, 'ToolModelResult', {
      tool_call_id: planTool.toolCallId
    })).length, 0);

    const approvedPlan = await planInteractions.resolvePlanReview(approvedPlanInput);
    assert.equal(approvedPlan.won, true);
    assert.equal(approvedPlan.deduplicated, true);
    assert.equal(externalEnsureAttempts, 2);
    assert.equal((await list(ctx.database, 'ChildExecutionParentLink', {
      source_tool_call_id: planTool.toolCallId
    })).length, 1);
    assert.equal((await get(ctx.database, 'Operation', externalSpawn.operationId)).status, 'succeeded');
    assert.equal((await get(ctx.database, 'Operation', externalSpawn.operationId)).tool_call_id, null);
    assert.equal((await get(ctx.database, 'ChildExecution', externalSpawn.childExecutionId)).status, 'active');
    assert.equal((await get(ctx.database, 'AnswerBridge', externalSpawn.answerBridgeId)).status, 'open');
    assert.equal((await get(ctx.database, 'Operation', planPause.operationId)).status, 'succeeded');
    assert.equal((await list(ctx.database, 'ToolResultArtifact', {
      tool_call_id: planTool.toolCallId
    })).length, 1);
    assert.equal((await list(ctx.database, 'ToolModelResult', {
      tool_call_id: planTool.toolCallId
    })).length, 1);
    await planInteractions.resolvePlanReview(approvedPlanInput);
    assert.equal(externalEnsureAttempts, 3);
    assert.equal((await list(ctx.database, 'ChildExecutionParentLink', {
      source_tool_call_id: planTool.toolCallId
    })).length, 1);
    await createTurnControl(ctx, 'plan-external-child-terminal').terminal({
      source: { kind: 'callback', key: 'plan-external-child-terminal' },
      turnId: externalSpawn.childTurnId,
      terminalStatus: 'completed',
      reason: 'plan external child completed before replay'
    });
    assert.equal(await ctx.services.children.observeTurnTerminal(
      externalSpawn.childExecutionId,
      externalSpawn.childTurnId
    ), true);
    assert.equal((await get(ctx.database, 'ChildExecution', externalSpawn.childExecutionId)).status, 'idle');
    let terminalReplayLaunches = 0;
    const terminalReplayCoordinator = new kernel.ReliableChildAgentCoordinator({
      database: ctx.database,
      effects: ctx.services.effects,
      children: ctx.services.children,
      answers: ctx.services.answers,
      deliveries: ctx.services.deliveries,
      modelProvider: {},
      turns: createTurnControl(ctx, 'plan-external-terminal-replay'),
      agentLoop: { async drive() { assert.fail('terminal Plan replay must not drive the child again'); } },
      agents: {
        async resolve({ agentId }) {
          return { agentId, agentType: 'plan-external' };
        }
      },
      modelProfiles: {
        async initializeConversation() { return { created: false }; }
      },
      manualCompression: {
        async admit() { throw new Error('unused'); },
        async inspect() { return null; },
        async driveIfPresent() { return null; }
      },
      now: ctx.now
    });
    terminalReplayCoordinator.launch = () => { terminalReplayLaunches += 1; };
    try {
      const terminalReplay = await terminalReplayCoordinator.ensureApprovedPlan({
        sourceToolCallId: planTool.toolCallId,
        parentTurnId: planParent.turnId,
        requestedAgentId: 'agent-plan-external',
        prompt: delegatedPlanPrompt,
        expected: {
          childExecutionId: externalIdentity.childExecutionId,
          childConversationId: externalIdentity.childConversationId,
          answerBridgeId: externalIdentity.answerBridgeId,
          agentId: 'agent-plan-external',
          agentType: 'plan-external'
        }
      });
      assert.equal(terminalReplay.childExecutionId, externalSpawn.childExecutionId);
      assert.equal(terminalReplayLaunches, 0);
      assert.equal((await get(ctx.database, 'ChildExecution', externalSpawn.childExecutionId)).status, 'idle');
    } finally {
      await terminalReplayCoordinator.dispose();
    }
    assertions.push('Plan winning commit是durable child intent；首次spawn后launch故障可幂等恢复，child已idle后的replay确认同一lineage且不重启');
    faults.push('continuation after descendant creation');
    faults.push('descendant spawn committed between cancel tree read and writer transaction');
    faults.push('pending intent and active turns cancelled atomically');
    faults.push('approved Plan commit before child launch with idempotent replay recovery');
    metrics.cancelledLineages = cancelled.lineageIds.length;
    metrics.siblingTerminationInputs = (await list(ctx.database, 'PendingTurnInput', {
      turn_id: sibling.childTurnId,
      input_kind: 'termination_request'
    })).length;
    return { assertions, faults, metrics };
  });
}

async function checkClientSnapshotBounds() {
  return withRuntime('client-snapshot', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const seeded = await seedParent(ctx, 'snapshot');
    const taskTool = await ctx.services.effects.createToolCall({
      source: { kind: 'callback', key: 'snapshot-task-tool' },
      toolCallId: 'snapshot-task-list-call',
      turnId: seeded.turnId,
      toolName: 'update_task_list',
      arguments: { mode: 'rewrite', items: [{ title: 'bounded projection', status: 'in_progress' }] }
    });
    await ctx.services.effects.settleWithoutEffect({
      source: { kind: 'internal', key: 'snapshot-task-settle' },
      toolCallId: taskTool.toolCallId,
      status: 'succeeded',
      detail: {
        kind: 'task-list',
        operation: {
          kind: 'task_list.operation',
          mode: 'rewrite',
          items: [{ title: 'bounded projection', status: 'in_progress' }]
        }
      }
    });
    // createToolCall is a callback fixture and therefore has no Provider source relation. Add the
    // minimal source facts required by currentTaskList's production ordering path.
    const [taskToolRow] = await list(ctx.database, 'ToolCall', { id: taskTool.toolCallId });
    const [taskAuthority] = await list(ctx.database, 'AuthoritySnapshot', { turn_id: seeded.turnId });
    assert.ok(taskToolRow);
    assert.ok(taskAuthority);
    const taskModelRequestId = 'snapshot-task-model-request';
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').insert({
        id: taskModelRequestId,
        turn_id: seeded.turnId,
        request_seq: 1n,
        status: 'prepared',
        terminal_state: null,
        provider_id: 'fake-local',
        model_id: 'fake-model',
        context_window_tokens: 200000n,
        compression_threshold_tokens: 100000n,
        estimated_context_tokens: 0n,
        authority_snapshot_id: taskAuthority.id,
        settings_snapshot_object_id: null,
        recipe_object_id: taskToolRow.arguments_object_id,
        usage_json: null,
        stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null },
        created_at: NOW,
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Operation').insert({
        id: 'snapshot-task-model-operation',
        owner_kind: 'model_request',
        owner_id: taskModelRequestId,
        operation_seq: 1n,
        tool_call_id: null,
        status: 'pending',
        created_at: NOW,
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').insert({
        id: 'snapshot-task-model-attempt',
        operation_id: 'snapshot-task-model-operation',
        attempt_seq: 1n,
        status: 'pending',
        created_at: NOW,
        updated_at: NOW,
        completed_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').insert({
        id: 'snapshot-task-source-link',
        tool_call_id: taskTool.toolCallId,
        model_request_id: taskModelRequestId,
        message_id: seeded.messageId,
        provider_call_id: 'snapshot-task-provider-call',
        provider_ordinal: 0n,
        batch_id: 'snapshot-task-batch',
        batch_ordinal: 0n,
        thought_signature: null,
        created_at: NOW
      })
    ]);
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').update(taskModelRequestId, {
        status: 'terminal',
        terminal_state: 'failed',
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Operation').update('snapshot-task-model-operation', {
        status: 'failed',
        updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').update('snapshot-task-model-attempt', {
        status: 'failed',
        updated_at: NOW,
        completed_at: NOW
      })
    ]);
    const failedTaskTool = await ctx.services.effects.createToolCall({
      source: { kind: 'callback', key: 'snapshot-failed-task-tool' },
      toolCallId: 'snapshot-failed-task-list-call',
      turnId: seeded.turnId,
      toolName: 'update_task_list',
      arguments: { mode: 'update', items: [{ title: 'must not apply', status: 'pending' }] }
    });
    await ctx.services.effects.settleWithoutEffect({
      source: { kind: 'internal', key: 'snapshot-failed-task-settle' },
      toolCallId: failedTaskTool.toolCallId,
      status: 'failed',
      detail: {
        kind: 'task-list',
        operation: { deliberately: 'not canonical' }
      }
    });
    const currentMemberships = await list(ctx.database, 'MessagePartOfConversation', { conversation_id: seeded.conversationId });
    const maxSeq = currentMemberships.reduce((max, row) => row.message_seq > max ? row.message_seq : max, 0n);
    const targetMessageCount = 10_000;
    const seedStartedAt = Date.now();
    await seedMessageRows(
      ctx,
      seeded.conversationId,
      targetMessageCount - currentMemberships.length,
      Number(maxSeq) + 1,
      'snapshot'
    );
    let targetRawMessageSeq = Number(maxSeq) + targetMessageCount - currentMemberships.length;
    const preflight = await ctx.database.clientProjectionSnapshot(seeded.conversationId);
    const visibleSeedCount = Number(preflight.snapshot.activeConversationWindow.visibleMessageCount);
    assert.ok(visibleSeedCount <= targetMessageCount);
    if (visibleSeedCount < targetMessageCount) {
      const visibleGap = targetMessageCount - visibleSeedCount;
      await seedMessageRows(
        ctx,
        seeded.conversationId,
        visibleGap,
        targetRawMessageSeq + 1,
        'snapshot-visible-fill'
      );
      targetRawMessageSeq += visibleGap;
    }
    metrics.seedTenThousandMs = Date.now() - seedStartedAt;
    const longTitle = '长'.repeat(4000);
    const navSteps = [];
    for (let index = 0; index < 210; index += 1) {
      navSteps.push(kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: `snapshot-nav-${String(index).padStart(3, '0')}`,
        title: `${longTitle}-${index}`,
        status: 'active',
        created_at: `2026-08-01T00:10:${String(index % 60).padStart(2, '0')}.000Z`,
        updated_at: `2026-08-01T00:10:${String(index % 60).padStart(2, '0')}.000Z`
      }));
    }
    await ctx.database.transaction(navSteps);
    const contextHeads = await list(ctx.database, 'ConversationContextHeadLink', {
      conversation_id: seeded.conversationId
    });
    assert.equal(contextHeads.length, 1);
    const contextProjectionId = 'snapshot-context-projection';
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelContextProjection').insert({
        id: contextProjectionId,
        owner_kind: 'turn',
        owner_id: seeded.turnId,
        root_id: contextHeads[0].root_id,
        purpose: 'request',
        created_at: NOW
      })
    ]);

    const sent = [];
    const snapshotStartedAt = Date.now();
    const connection = await ctx.services.clientFeed.connect({
      activeConversationId: seeded.conversationId,
      send: (message) => sent.push(message)
    });
    metrics.snapshotTenThousandMs = Date.now() - snapshotStartedAt;
    assert.equal(sent.length, 1);
    const snapshot = sent[0];
    assert.equal(snapshot.type, 'reliable-kernel.snapshot');
    assert.equal(snapshot.sessionId, connection.sessionId);
    assert.equal(snapshot.hostBootId, ctx.database.hostBootId);
    assert.match(snapshot.snapshotCommitSeq, /^(?:0|[1-9]\d*)$/);
    const windowMessages = snapshot.projections.activeConversationWindow.messages;
    assert.equal(windowMessages.length, 200);
    assert.equal(String(windowMessages[0].message_seq), String(targetRawMessageSeq - 199));
    assert.equal(String(windowMessages.at(-1).message_seq), String(targetRawMessageSeq));
    assert.equal(String(windowMessages[0].display_seq), '9801');
    assert.equal(String(windowMessages.at(-1).display_seq), '10000');
    assert.equal(String(snapshot.projections.activeConversationWindow.visibleMessageCount), '10000');
    assert.ok(snapshot.projections.navigationSummary.conversations.length <= 200);
    assert.ok(maxArrayLength(snapshot.projections) <= 200);
    assert.ok(maxRecordBytes(snapshot.projections) <= 2048);
    assert.ok(wireBytes(snapshot) <= 5_242_880);
    assert.equal(snapshot.projections.activeConversationWindow.taskList.length, 2);
    assert.deepEqual(snapshot.projections.activeConversationWindow.taskList[0].items, [
      { title: 'bounded projection', status: 'in_progress' }
    ]);
    assert.equal(snapshot.projections.activeConversationWindow.taskList[0].detail_on_demand, false);
    assert.equal(snapshot.projections.activeConversationWindow.taskList[1].outcome, 'failed');
    assert.equal(snapshot.projections.activeConversationWindow.taskList[1].items, null);
    assert.equal(snapshot.projections.activeConversationWindow.taskList[1].detail_on_demand, false);
    const taskListBeforeNewTurn = structuredClone(
      snapshot.projections.activeConversationWindow.currentTaskList
    );
    assert.ok(taskListBeforeNewTurn);
    assert.deepEqual(taskListBeforeNewTurn.items.map((item) => [item.title, item.status]), [
      ['bounded projection', 'in_progress']
    ]);
    assert.equal(JSON.stringify(snapshot).includes('user-input-snapshot'), false);
    assert.ok(metrics.snapshotTenThousandMs < 5_000, `10k snapshot took ${metrics.snapshotTenThousandMs}ms`);
    assertions.push('10,000个可见楼层的snapshot仍只发送最新200条且保留绝对display_seq=9801..10000；五类projection/单记录摘要/实际UTF-8总字节均受硬上限，task list不含正文/full Context；failed task artifact不做canonical解析且不阻断snapshot');

    const oversizedProjection = emptyClientProjection('bundle-conversation');
    const nav = oversizedProjection.navigationSummary;
    const active = oversizedProjection.activeConversationWindow;
    const activeTurns = oversizedProjection.activeTurnSummary;
    const activeTools = oversizedProjection.activeToolAndInteractionSummary;
    const pad = (record, seed) => ({
      ...record,
      padding_a: `${seed}:${'a'.repeat(220)}`,
      padding_b: `${seed}:${'b'.repeat(220)}`,
      padding_c: `${seed}:${'c'.repeat(220)}`,
      padding_d: `${seed}:${'d'.repeat(220)}`,
      padding_e: `${seed}:${'e'.repeat(220)}`
    });
    for (let index = 1; index <= 200; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const messageId = `bundle-message-${suffix}`;
      const turnId = `bundle-turn-${suffix}`;
      const requestId = `bundle-request-${suffix}`;
      const toolCallId = `bundle-tool-${suffix}`;
      const processId = `bundle-process-${suffix}`;
      nav.conversations.push(pad({
        id: index === 1 ? 'bundle-conversation' : `bundle-navigation-${suffix}`,
        updated_at: `2026-08-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`
      }, `navigation-${suffix}`));
      active.messages.push(pad({
        id: messageId, conversation_id: 'bundle-conversation', message_seq: String(index),
        display_seq: String(index), revision_id: `bundle-revision-${suffix}`, role: 'model'
      }, `message-${suffix}`));
      activeTurns.turns.push(pad({ id: turnId, conversation_id: 'bundle-conversation' }, `turn-${suffix}`));
      activeTurns.modelRequests.push(pad({
        id: requestId, turn_id: turnId, request_seq: String(index), status: 'terminal'
      }, `request-${suffix}`));
      activeTurns.modelRequestMessageLinks.push(pad({
        id: `bundle-request-message-${suffix}`, model_request_id: requestId, message_id: messageId
      }, `request-message-${suffix}`));
      activeTools.messageTurnLinks.push(pad({
        id: `bundle-message-turn-${suffix}`, message_id: messageId, turn_id: turnId, role: 'model'
      }, `message-turn-${suffix}`));
      activeTools.toolCalls.push(pad({ id: toolCallId, turn_id: turnId }, `tool-${suffix}`));
      activeTools.toolCallSourceLinks.push(pad({
        id: `bundle-tool-source-${suffix}`, tool_call_id: toolCallId,
        model_request_id: requestId, message_id: messageId
      }, `tool-source-${suffix}`));
      activeTools.toolCallPolicySnapshots.push(pad({
        id: `bundle-policy-${suffix}`, tool_call_id: toolCallId
      }, `policy-${suffix}`));
      activeTools.toolCallEvents.push(pad({
        id: `bundle-event-${suffix}`, tool_call_id: toolCallId
      }, `event-${suffix}`));
      activeTools.toolExecutions.push(pad({
        id: `bundle-execution-${suffix}`, tool_call_id: toolCallId
      }, `execution-${suffix}`));
      activeTools.toolOutcomes.push(pad({
        id: `bundle-outcome-${suffix}`, tool_call_id: toolCallId
      }, `outcome-${suffix}`));
      activeTools.toolModelResults.push(pad({
        id: `bundle-model-result-${suffix}`, tool_call_id: toolCallId
      }, `model-result-${suffix}`));
      activeTools.toolResultArtifacts.push(pad({
        id: `bundle-artifact-${suffix}`, tool_call_id: toolCallId
      }, `artifact-${suffix}`));
      activeTools.interactionRequests.push(pad({ id: `bundle-interaction-${suffix}` }, `interaction-${suffix}`));
      activeTools.interactionOwnerLinks.push(pad({
        id: `bundle-interaction-owner-${suffix}`, request_id: `bundle-interaction-${suffix}`, turn_id: turnId
      }, `interaction-owner-${suffix}`));
      activeTools.interactionToolCallLinks.push(pad({
        id: `bundle-interaction-tool-${suffix}`, request_id: `bundle-interaction-${suffix}`,
        tool_call_id: toolCallId
      }, `interaction-tool-${suffix}`));
      activeTools.interactionResponses.push(pad({
        id: `bundle-interaction-response-${suffix}`, request_id: `bundle-interaction-${suffix}`
      }, `interaction-response-${suffix}`));
      activeTools.fileChangeSets.push(pad({
        id: `bundle-change-set-${suffix}`, tool_call_id: toolCallId
      }, `change-set-${suffix}`));
      activeTools.fileChangeSetMembers.push(pad({
        id: `bundle-change-member-${suffix}`, change_set_id: `bundle-change-set-${suffix}`
      }, `change-member-${suffix}`));
      activeTools.fileChangeDecisions.push(pad({
        id: `bundle-change-decision-${suffix}`, change_set_id: `bundle-change-set-${suffix}`
      }, `change-decision-${suffix}`));
      activeTools.fileMutationReceipts.push(pad({
        id: `bundle-mutation-receipt-${suffix}`, change_set_id: `bundle-change-set-${suffix}`
      }, `mutation-receipt-${suffix}`));
      activeTools.fileMutationReceiptMembers.push(pad({
        id: `bundle-mutation-member-${suffix}`, receipt_id: `bundle-mutation-receipt-${suffix}`
      }, `mutation-member-${suffix}`));
      activeTools.processes.push(pad({ id: processId }, `process-${suffix}`));
      activeTools.processOriginLinks.push(pad({
        id: `bundle-process-origin-${suffix}`, process_id: processId, tool_call_id: toolCallId
      }, `process-origin-${suffix}`));
      activeTools.processOutputChunks.push(pad({
        id: `bundle-process-output-${suffix}`, process_id: processId
      }, `process-output-${suffix}`));
      activeTools.processReceipts.push(pad({
        id: `bundle-process-receipt-${suffix}`, process_id: processId
      }, `process-receipt-${suffix}`));
    }
    for (const values of [
      nav.conversations,
      activeTurns.turns,
      activeTools.toolCalls,
      activeTools.toolCallSourceLinks,
      activeTools.toolCallPolicySnapshots,
      activeTools.toolCallEvents,
      activeTools.toolExecutions,
      activeTools.toolOutcomes,
      activeTools.toolModelResults,
      activeTools.toolResultArtifacts,
      activeTools.interactionRequests,
      activeTools.interactionOwnerLinks,
      activeTools.interactionToolCallLinks,
      activeTools.interactionResponses,
      activeTools.fileChangeSets,
      activeTools.fileChangeSetMembers,
      activeTools.fileChangeDecisions,
      activeTools.fileMutationReceipts,
      activeTools.fileMutationReceiptMembers,
      activeTools.processes,
      activeTools.processOriginLinks,
      activeTools.processOutputChunks,
      activeTools.processReceipts
    ]) values.reverse();
    active.visibleMessageCount = '200';
    active.lastMessageSeq = '200';
    assert.ok(wireBytes(oversizedProjection) > 5_242_880);
    const boundedMessages = [];
    const boundedDatabase = {
      hostBootId: 'bundle-boot',
      async externalDataVersion() { return '1'; },
      async clientProjectionSnapshotAndSubscribe(_conversationId, _listener) {
        return {
          barrier: { snapshotCommitSeq: '1', snapshot: oversizedProjection },
          unsubscribe() {}
        };
      }
    };
    const boundedFeed = new kernel.BoundedClientFeed(boundedDatabase);
    const boundedConnection = await boundedFeed.connect({
      activeConversationId: 'bundle-conversation',
      send: (message) => boundedMessages.push(message)
    });
    const boundedSnapshot = boundedMessages[0];
    assert.ok(wireBytes(boundedSnapshot) <= 5_242_880);
    const boundedWindow = boundedSnapshot.projections.activeConversationWindow;
    const boundedTurns = boundedSnapshot.projections.activeTurnSummary;
    const boundedTools = boundedSnapshot.projections.activeToolAndInteractionSummary;
    assert.ok(boundedWindow.messages.length < 200);
    assert.equal(boundedWindow.messages.at(-1).id, 'bundle-message-200');
    assert.ok(Number(boundedWindow.messages[0].message_seq) > 1);
    assert.equal(boundedTurns.modelRequests.at(-1).id, 'bundle-request-200');
    assert.equal(boundedTools.toolCalls[0].id, 'bundle-tool-200');
    assert.ok(boundedSnapshot.projections.navigationSummary.conversations.some((row) => row.id === 'bundle-conversation'));
    assertCausalSnapshotBundles(boundedSnapshot.projections);
    boundedFeed.disconnect(boundedConnection.sessionId);
    assertions.push('5MiB裁剪按明确oldest-first/newest-first方向保留最新窗口，并按Message→Request→Tool→Process闭包保留request-message/tool-source/message-turn/process-origin bundle');
    faults.push('5MiB byte pressure across oppositely ordered causal projection arrays');

    const pageLatencies = [];
    let pageStartedAt = Date.now();
    const pageOne = await ctx.services.history.page({
      query: 'message', sortId: 'message_seq', conversationId: seeded.conversationId, limit: 200
    });
    pageLatencies.push(Date.now() - pageStartedAt);
    assert.equal(pageOne.rows.length, 200);
    assert.ok(pageOne.responseBytes <= 524_288);
    await seedMessageRows(ctx, seeded.conversationId, 1, targetRawMessageSeq + 1, 'snapshot-mid-page');
    const observed = [...pageOne.rows.map((row) => row.id)];
    let cursor = pageOne;
    const paginationStartedAt = Date.now();
    while (cursor.hasMore) {
      pageStartedAt = Date.now();
      cursor = await ctx.services.history.page({
        query: 'message', sortId: 'message_seq', conversationId: seeded.conversationId, limit: 200,
        afterSortKey: cursor.nextSortKey, afterId: cursor.nextId
      });
      pageLatencies.push(Date.now() - pageStartedAt);
      observed.push(...cursor.rows.map((row) => row.id));
    }
    metrics.pageTenThousandTotalMs = Date.now() - paginationStartedAt;
    metrics.pageCount = pageLatencies.length;
    metrics.pageP95Ms = percentile(pageLatencies, 0.95);
    metrics.pageMaxMs = Math.max(...pageLatencies);
    metrics.runtimeDatabaseBytes = (await fs.stat(ctx.binding.paths.databasePath)).size;
    assert.equal(new Set(observed).size, observed.length);
    const existingIds = new Set((await listAll(ctx.database, 'MessagePartOfConversation', {
      conversation_id: seeded.conversationId
    })).map((row) => row.message_id));
    assert.deepEqual(new Set(observed), existingIds);
    await assert.rejects(ctx.services.history.page({
      query: 'message', sortId: 'message_seq', conversationId: seeded.conversationId,
      limit: 20, offset: 20
    }), /Offset pagination is forbidden/);
    assert.ok(metrics.pageP95Ms < 2_000, `10k keyset page p95 took ${metrics.pageP95Ms}ms`);
    assert.ok(metrics.pageTenThousandTotalMs < 30_000, `10k pagination took ${metrics.pageTenThousandTotalMs}ms`);
    assertions.push('超过10,000条message_seq+id keyset分页在中间插入新行后仍无重复/漏项，page rows/bytes有界、尾延迟受限且offset被拒绝');

    const detailChild = await spawnStartedChild(ctx, seeded.turnId, 'snapshot-detail', 'background');
    const largeAnswer = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const largeSubmission = await ctx.services.answers.submit({
      answerBridgeId: detailChild.answerBridgeId,
      submissionId: 'snapshot-large-answer',
      sourceTurnId: detailChild.childTurnId,
      content: largeAnswer,
      contentType: 'application/octet-stream'
    });
    const chunks = [];
    let offset = 0;
    do {
      const detail = await ctx.services.details.read({
        kind: 'answer-content', recordId: largeSubmission.submissionId,
        offset, maxBytes: 2_097_152
      });
      assert.ok(detail.responseBytes <= 2_097_152);
      chunks.push(Buffer.from(detail.chunk, 'base64'));
      if (!detail.hasMore) break;
      offset = detail.nextOffset;
    } while (true);
    assert.deepEqual(Buffer.concat(chunks), largeAnswer);
    const contextDetail = await ctx.services.details.read({
      kind: 'context-projection-detail', recordId: contextProjectionId,
      offset: 0, maxBytes: 2_097_152
    });
    assert.ok(contextDetail.responseBytes <= 2_097_152);
    const structuralContext = JSON.parse(Buffer.from(contextDetail.chunk, 'base64').toString('utf8'));
    assert.equal(structuralContext.projection.id, contextProjectionId);
    assert.equal(structuralContext.root.id, contextHeads[0].root_id);
    assert.ok(Array.isArray(structuralContext.records));
    assert.equal(JSON.stringify(structuralContext).includes('user-input-snapshot'), false);
    assertions.push('大型answer正文不进ClientState，details按recordId+offset+maxBytes分块；Context projection按root读取结构事实且不把owner误作CAS或返回正文；每个实际wire response≤2MiB');

    // Reconnect after the preceding intentionally unacknowledged fault sequence, then drive ten
    // thousand incremental floors through the normal one-inflight feed. This catches reachability
    // sets that appear row-bounded in the Webview but leak every evicted historical identity in the
    // Extension Host.
    ctx.services.clientFeed.disconnect(connection.sessionId);
    const churnMessages = [];
    const churnConnection = await ctx.services.clientFeed.connect({
      activeConversationId: seeded.conversationId,
      send: (message) => churnMessages.push(message)
    });
    const churnInitialView = ctx.services.clientFeed.inspectSession(churnConnection.sessionId);
    const churnStartRawMessageSeq = Number(churnInitialView.latestMessageSeq) + 1;
    const churnStartVisibleFloor = Number(churnInitialView.latestVisibleMessageFloor);
    acknowledge(ctx.services.clientFeed, churnConnection, churnMessages[0]);
    const churnStartedAt = Date.now();
    for (let batch = 0; batch < 100; batch += 1) {
      const before = churnMessages.length;
      await seedMessageRows(
        ctx,
        seeded.conversationId,
        100,
        churnStartRawMessageSeq + batch * 100,
        'snapshot-churn'
      );
      assert.equal(churnMessages.length, before + 1);
      const changeMessage = churnMessages.at(-1);
      assert.equal(changeMessage.type, 'reliable-kernel.changes');
      assert.ok(changeMessage.changes.length <= 500);
      assert.ok(wireBytes(changeMessage) <= 1_048_576);
      acknowledge(ctx.services.clientFeed, churnConnection, changeMessage);
    }
    metrics.incrementalTenThousandMs = Date.now() - churnStartedAt;
    const churnView = ctx.services.clientFeed.inspectSession(churnConnection.sessionId);
    metrics.incrementalActiveRecordKeys = churnView.activeRecordKeyCount;
    metrics.incrementalMaterializedRecords = churnView.materializedRecordCount;
    metrics.incrementalMaxRecordsPerType = churnView.maxMaterializedRecordsPerType;
    metrics.incrementalLastMessageSeq = Number(churnView.latestMessageSeq);
    metrics.incrementalLastVisibleFloor = Number(churnView.latestVisibleMessageFloor);
    assert.equal(churnMessages.length, 101);
    assert.equal(churnMessages.filter((message) => message.type === 'reliable-kernel.snapshot').length, 1);
    assert.ok(churnView.maxMaterializedRecordsPerType <= 200);
    assert.equal(churnView.latestMessageSeq, String(churnStartRawMessageSeq + 9_999));
    assert.equal(churnView.latestVisibleMessageFloor, String(churnStartVisibleFloor + 10_000));
    assert.ok(
      churnView.activeRecordKeyCount <= churnView.materializedRecordCount * 12 + 50,
      `active reachability leaked: active=${churnView.activeRecordKeyCount}, materialized=${churnView.materializedRecordCount}`
    );
    assert.ok(metrics.incrementalTenThousandMs < 30_000, `10k incremental feed took ${metrics.incrementalTenThousandMs}ms`);
    assertions.push('连续10,000条增量消息只产生100个有界atomic changes且不退化为snapshot风暴；Webview物化记录和Extension Host可达键均随200条窗口保持常数上限');
    ctx.services.clientFeed.disconnect(churnConnection.sessionId);

    const messageListSource = await fs.readFile(path.join(root, 'webview/src/components/conversation/ReliableMessageList.vue'), 'utf8');
    const segmentSource = await fs.readFile(path.join(root, 'webview/src/components/conversation/segmentedTimeline.ts'), 'utf8');
    const projectionSource = await fs.readFile(path.join(root, 'webview/src/domain/reliableConversationProjection.ts'), 'utf8');
    const transientModelSource = await fs.readFile(path.join(root, 'webview/src/domain/reliableTransientModel.ts'), 'utf8');
    const transientLifecycleSource = await fs.readFile(path.join(root, 'webview/src/domain/reliableTransientLifecycle.ts'), 'utf8');
    const transientActivitySource = await fs.readFile(path.join(root, 'webview/src/domain/reliableTransientActivity.ts'), 'utf8');
    const functionCallSource = await fs.readFile(path.join(root, 'webview/src/components/content/parts/FunctionCallPartView.vue'), 'utf8');
    const detailStoreSource = await fs.readFile(path.join(root, 'webview/src/stores/useReliableKernelClientFeedStore.ts'), 'utf8');
    const messageItemSource = await fs.readFile(path.join(root, 'webview/src/components/conversation/MessageItem.vue'), 'utf8');
    assert.match(messageListSource, /v-for="[^"]*visibleTimelineRows"/);
    assert.match(messageListSource, /scroller/);
    assert.match(segmentSource, /TIMELINE_MOUNT_LIMIT = 30/);
    assert.match(segmentSource, /PENDING_TIMELINE_MOUNT_LIMIT = 8/);
    assert.match(segmentSource, /Math\.ceil\(messageSeq\)/);
    assert.match(projectionSource, /absoluteFloorByMessageId/);
    assert.match(messageListSource, /projection\.value\.absoluteFloorByMessageId\[message\.id\]/);
    assert.match(messageListSource, /messageDetailDemandSignature/);
    assert.match(messageListSource, /kind:\s*['"]message-content['"]/);
    assert.match(messageItemSource, /v-if="detailLoading"/);
    assert.match(transientModelSource, /options\.includeFinal === true/);
    assert.match(functionCallSource, /if \(!partId \|\| !props\.messageId\) return undefined;/);
    assert.doesNotMatch(functionCallSource, /!props\.messageId \|\| toolCall\.value/);
    assert.match(functionCallSource, /interactionByToolCallId\[durableCallId\]\?\.status === 'pending'/);
    assert.match(functionCallSource, /messageDetail\?\.status === 'error'/);
    assert.match(detailStoreSource, /DETAIL_AUTO_RETRY_DELAYS_MS = \[250, 750, 2_000\]/);
    assert.match(functionCallSource, /label:\s*'重试详情'/);
    assert.match(functionCallSource, /feed\.retryDetail\(kind, recordId/);
    assert.match(functionCallSource, /includeFinal:\s*true/);
    assert.match(transientLifecycleSource, /detailReady && toolFactsReady/);
    assert.match(messageListSource, /messages\.value\[messages\.value\.length - 1\]\?\.id/);
    const durableRetryVisibility = messageListSource.indexOf("latest.status === 'retrying'");
    const transientThoughtSuppression = messageListSource.indexOf('if (hasVisibleStreamingTransientForTurn');
    assert.ok(durableRetryVisibility >= 0 && transientThoughtSuppression > durableRetryVisibility);
    assert.match(messageListSource, /LLM 输出停滞/);
    assert.match(messageListSource, /reliableRetryStreamingActivityLabel/);
    assert.match(transientActivitySource, /已启动，正在连接并等待 LLM 输出/);
    assert.match(transientActivitySource, /if \(input\.hasVisibleOutput\) return undefined;/);
    assert.ok(30 + 8 <= 40);
    const plainData = require(path.join(root, 'dist/extension/shared/plainData.js'));
    const proxy = new Proxy({ nested: [{ value: 'plain' }] }, {});
    const plain = plainData.toStructuredClonePlainData(proxy);
    assert.deepEqual(plain, { nested: [{ value: 'plain' }] });
    assert.notEqual(plain, proxy);
    assert.throws(() => plainData.toStructuredClonePlainData(new Map()), /forbidden class/);
    assert.throws(() => plainData.toStructuredClonePlainData({ callback() {} }), /unsupported function/);
    assertions.push('可靠时间线使用30+8 segmented挂载上限、projection绝对楼层和瞬态向上取整；Message+Revision+detail状态驱动正文水合并以中性骨架展示；final工具参数快照持续到Message detail与匹配Tool facts可展示，pending交互或重试耗尽时显式交接；详情读取按250/750/2000ms有界退避且工具卡提供手动重试；Attempt 2+的持久自动恢复状态在无输出时优先展示，并在对应transient可见后让位；Bridge payload递归转plain且拒绝Map/function/class');
    faults.push('keyset insertion between pages');
    faults.push('detail payload larger than maxResponseBytes');
    metrics.snapshotBytes = wireBytes(snapshot);
    metrics.snapshotMessages = windowMessages.length;
    metrics.keysetRows = observed.length;
    metrics.detailChunks = chunks.length;
    metrics.contextDetailBytes = contextDetail.responseBytes;
    metrics.maxMountedTimelineComponents = 38;
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: 'client-snapshot-newer-turn-without-task-rewrite',
        conversation_id: seeded.conversationId,
        status: 'terminal',
        created_at: '9999-12-31T23:59:59.999Z',
        updated_at: '9999-12-31T23:59:59.999Z',
        terminal_at: '9999-12-31T23:59:59.999Z'
      })
    ]);
    const newerTurnSnapshot = await ctx.database.clientProjectionSnapshot(seeded.conversationId);
    assert.deepEqual(
      newerTurnSnapshot.snapshot.activeConversationWindow.currentTaskList,
      taskListBeforeNewTurn
    );
    assertions.push('currentTaskList按Conversation延续；新Turn无rewrite时保留原基线并允许后续update-only继续');
    return { assertions, faults, metrics };
  });
}

async function checkClientChangeBatchBounds() {
  return withRuntime('client-batch', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const seeded = await seedParent(ctx, 'client-batch-links');
    const sent = [];
    const connection = await ctx.services.clientFeed.connect({
      activeConversationId: seeded.conversationId,
      send: (message) => sent.push(message)
    });
    acknowledge(ctx.services.clientFeed, connection, sent[0]);
    await ctx.database.transaction(Array.from({ length: 10 }, (_unused, index) =>
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: `batch-small-${index}`, title: `small ${index}`, status: 'active',
        created_at: NOW, updated_at: NOW
      })
    ));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].type, 'reliable-kernel.changes');
    assert.equal(sent[1].changes.length, 10);
    assert.ok(wireBytes(sent[1]) <= 1_048_576);
    const commitSeq = sent[1].commitSeq;
    acknowledge(ctx.services.clientFeed, connection, sent[1]);
    assertions.push('普通SQLite commit只产生一个typed upsert/remove atomic batch，records/实际wire bytes受限且不拆分');

    const sentBeforeInvisibleCommit = sent.length;
    await ctx.store.ingest(ctx.database, 'feed-invisible-cas-only', 'text/plain');
    assert.equal(sent.length, sentBeforeInvisibleCommit);
    assertions.push('不属于当前Client projection的commit不生成空changes、不占用单inflight ACK通道');

    await ctx.database.transaction(Array.from({ length: 501 }, (_unused, index) =>
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: `batch-oversized-${String(index).padStart(3, '0')}`, title: `oversized ${index}`,
        status: 'active', created_at: NOW, updated_at: NOW
      })
    ));
    await waitFor(() => sent.length >= 3, 5000, 'oversized commit snapshot refresh');
    assert.equal(sent[2].type, 'reliable-kernel.snapshot');
    assert.ok(BigInt(sent[2].snapshotCommitSeq) > BigInt(commitSeq));
    assert.equal(sent.filter((message) => message.type === 'reliable-kernel.changes' && message.changes.length > 500).length, 0);
    assertions.push('single commit 501 records不形成half-visible拆包，直接coalesce为新bounded snapshot');
    faults.push('single oversized commit by record count');

    acknowledge(ctx.services.clientFeed, connection, sent[2]);
    const linkCommitStart = sent.length;
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
        id: 'client-live-message-turn-link',
        turn_id: seeded.turnId,
        message_id: seeded.messageId,
        role: 'projection-test',
        created_at: NOW
      })
    ]);
    assert.equal(sent.length, linkCommitStart + 1);
    assert.ok(sent.at(-1).changes.some((change) =>
      change.type === 'MessageTurnLink' && change.id === 'client-live-message-turn-link'
    ));
    acknowledge(ctx.services.clientFeed, connection, sent.at(-1));

    const processTool = await ctx.services.effects.createToolCall({
      source: { kind: 'callback', key: 'client-process-origin-tool' },
      toolCallId: 'client-process-origin-tool',
      turnId: seeded.turnId,
      toolName: 'run_command',
      arguments: { command: 'printf live', foregroundWaitMs: 0 }
    });
    assert.ok(sent.at(-1).changes.some((change) => change.type === 'ToolCall' && change.id === processTool.toolCallId));
    acknowledge(ctx.services.clientFeed, connection, sent.at(-1));
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Process').insert({
        id: 'client-live-process', status: 'running', wrapper_nonce: 'client-wrapper', wrapper_pid: 101n,
        child_pid: 102n, process_group_id: 102n, start_fingerprint: 'client-start',
        command_digest: 'client-command', spool_locator: 'client-spool', retained_bytes: 0n,
        retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n, started_at: NOW,
        updated_at: NOW, completed_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ProcessOriginLink').insert({
        id: 'client-live-process-origin', process_id: 'client-live-process',
        tool_call_id: processTool.toolCallId, created_at: NOW
      })
    ]);
    const processChanges = sent.at(-1).changes;
    assert.ok(processChanges.some((change) => change.type === 'Process' && change.id === 'client-live-process'));
    assert.ok(processChanges.some((change) =>
      change.type === 'ProcessOriginLink' && change.id === 'client-live-process-origin'
    ));
    acknowledge(ctx.services.clientFeed, connection, sent.at(-1));
    assertions.push('已连接Conversation无需snapshot即可增量接收MessageTurnLink，以及同commit互相建立可达性的Process+ProcessOriginLink');
    faults.push('snapshot-only structural link after initial feed connection');

    const shared = require(path.join(root, 'dist/extension/shared/reliableKernelClientFeed.js'));
    const initial = shared.applyReliableKernelDataMessage(shared.createEmptyReliableKernelClientState(), {
      type: shared.RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-a', messageSeq: '1', snapshotCommitSeq: '5',
      projections: { navigationSummary: { conversations: [] } }
    });
    assert.equal(initial.snapshotRequired, false);
    const valid = shared.applyReliableKernelDataMessage(initial.state, {
      type: shared.RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-a', messageSeq: '2', commitSeq: '6',
      changes: [{ type: 'Conversation', operation: 'upsert', id: 'client-conv', record: { id: 'client-conv', status: 'active' } }]
    });
    assert.equal(valid.state.records.Conversation['client-conv'].status, 'active');
    const beforeFailure = JSON.stringify(valid.state.records);
    const failedApply = shared.applyReliableKernelDataMessage(valid.state, {
      type: shared.RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-a', messageSeq: '3', commitSeq: '7',
      changes: [
        { type: 'Conversation', operation: 'upsert', id: 'would-be-partial', record: { id: 'would-be-partial' } },
        { type: 'UnknownDomain', operation: 'upsert', id: 'bad', record: { id: 'bad' } }
      ]
    });
    assert.equal(failedApply.snapshotRequired, true);
    assert.equal(JSON.stringify(failedApply.state.records), beforeFailure);
    const commitJump = shared.applyReliableKernelDataMessage(valid.state, {
      type: shared.RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-a', messageSeq: '3', commitSeq: '8', changes: []
    });
    const messageGap = shared.applyReliableKernelDataMessage(valid.state, {
      type: shared.RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-a', messageSeq: '4', commitSeq: '9', changes: []
    });
    const commitOrder = shared.applyReliableKernelDataMessage(valid.state, {
      type: shared.RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-a', messageSeq: '3', commitSeq: '6', changes: []
    });
    const mismatch = shared.applyReliableKernelDataMessage(valid.state, {
      type: shared.RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-b', messageSeq: '3', commitSeq: '7', changes: []
    });
    assert.equal(commitJump.snapshotRequired, false);
    assert.equal(commitJump.state.lastCommitSeq, '8');
    assert.equal(messageGap.reason, 'message-gap');
    assert.equal(commitOrder.reason, 'commit-order');
    assert.equal(mismatch.reason, 'host-boot-mismatch');
    assert.equal(mismatch.state.hostBootId, null);
    assert.equal(mismatch.state.sessionId, null);
    assert.deepEqual(mismatch.state.records, {});
    assertions.push('客户端整批copy-on-write原子应用；messageSeq保证传输连续，commitSeq允许跨过不可见提交但拒绝回退；unknown type/apply failure/乱序均作废整批并请求snapshot，hostBoot/session变化同时丢弃旧增量状态');
    faults.push('unknown change type after a valid first change');
    faults.push('messageSeq gap, commitSeq regression and hostBootId change');
    metrics.normalBatchRecords = sent[1].changes.length;
    metrics.normalBatchBytes = wireBytes(sent[1]);
    ctx.services.clientFeed.disconnect(connection.sessionId);
    return { assertions, faults, metrics };
  });
}

async function checkClientQueueBounds() {
  const countEvidence = await withRuntime('client-queue-count', async (ctx) => {
    const sent = [];
    const connection = await ctx.services.clientFeed.connect({ send: (message) => sent.push(message) });
    for (let index = 0; index < 9; index += 1) {
      await ctx.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
          id: `queue-count-${index}`, title: `queue ${index}`, status: 'active',
          created_at: NOW, updated_at: NOW
        })
      ]);
    }
    const compacted = ctx.services.clientFeed.inspectSession(connection.sessionId);
    assert.equal(compacted.snapshotRequired, false);
    assert.equal(compacted.queuedBatches, 1);
    assert.equal(compacted.nextMessageSeq, '2');
    assert.equal(sent.length, 1);
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'queue-count-coalesced', title: 'coalesced', status: 'active', created_at: NOW, updated_at: NOW
      })
    ]);
    const extended = ctx.services.clientFeed.inspectSession(connection.sessionId);
    assert.equal(extended.snapshotRequired, false);
    assert.equal(extended.queuedBatches, 1);
    assert.equal(extended.nextMessageSeq, '2');
    assert.equal(sent.length, 1);
    acknowledge(ctx.services.clientFeed, connection, sent[0]);
    await waitFor(() => sent.length === 2, 5000, 'queue compacted changes handoff');
    assert.equal(sent[1].type, 'reliable-kernel.changes');
    assert.equal(sent[1].messageSeq, '2');
    assert.equal(sent[1].changes.length, 10);
    assert.equal(ctx.services.clientFeed.inspectSession(connection.sessionId).inflightMessageSeq, sent[1].messageSeq);
    ctx.services.clientFeed.disconnect(connection.sessionId);
    return { sent, compacted, extended };
  });

  const byteEvidence = await withRuntime('client-queue-bytes', async (ctx) => {
    // Seed a bounded active window before connecting, then repeatedly update the same visible rows.
    // Creating hundreds of new Conversations would correctly hit the 200-record navigation bound
    // before queuedBytes, so it cannot prove that the independent 4 MiB queue guard is active.
    const seeded = await seedParent(ctx, 'queue-bytes');
    const shared = await ctx.store.ingest(ctx.database, 'queue-byte-shared', 'application/json');
    const toolCallIds = [];
    const modelRequestIds = [];
    const seedSteps = [];
    for (let index = 0; index < 200; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const toolCallId = `queue-byte-tool-${suffix}`;
      const modelRequestId = `queue-byte-model-${suffix}`;
      toolCallIds.push(toolCallId);
      modelRequestIds.push(modelRequestId);
      seedSteps.push(
        kernel.DOMAIN_REPOSITORIES.domain('ToolCall').insert({
          id: toolCallId,
          turn_id: seeded.turnId,
          call_seq: BigInt(index + 1),
          tool_name: `seed-tool-${suffix}`,
          status: 'running',
          arguments_object_id: shared.id,
          created_at: NOW,
          updated_at: NOW
        }),
        kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').insert({
          id: modelRequestId,
          turn_id: seeded.turnId,
          request_seq: BigInt(index + 1),
          status: 'prepared',
          terminal_state: null,
          provider_id: 'queue-byte-provider',
          model_id: 'queue-byte-model',
          context_window_tokens: 128000n,
          compression_threshold_tokens: 100000n,
          estimated_context_tokens: 1000n,
          authority_snapshot_id: `queue-byte-authority-${suffix}`,
          settings_snapshot_object_id: null,
          recipe_object_id: shared.id,
          usage_json: null,
          stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null },
          created_at: NOW,
          updated_at: NOW
        }),
        kernel.DOMAIN_REPOSITORIES.domain('Operation').insert({
          id: `queue-byte-operation-${suffix}`,
          owner_kind: 'model_request',
          owner_id: modelRequestId,
          operation_seq: 1n,
          tool_call_id: null,
          status: 'pending',
          created_at: NOW,
          updated_at: NOW
        }),
        kernel.DOMAIN_REPOSITORIES.domain('Attempt').insert({
          id: `queue-byte-attempt-${suffix}`,
          operation_id: `queue-byte-operation-${suffix}`,
          attempt_seq: 1n,
          status: 'pending',
          created_at: NOW,
          updated_at: NOW,
          completed_at: null
        })
      );
    }
    await ctx.database.transaction(seedSteps);

    const sent = [];
    const connection = await ctx.services.clientFeed.connect({
      activeConversationId: seeded.conversationId,
      send: (message) => sent.push(message)
    });
    let latest;
    for (let batch = 1; batch <= 8; batch += 1) {
      const steps = [];
      for (let index = 0; index < 200; index += 1) {
        steps.push(
          kernel.DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallIds[index], {
            tool_name: `${'t'.repeat(1500)}-${batch}-${index}`,
            updated_at: NOW
          }),
          kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestIds[index], {
            usage_json: { padding: 'u'.repeat(1300), batch, index },
            updated_at: NOW
          })
        );
      }
      await ctx.database.transaction(steps);
      const current = ctx.services.clientFeed.inspectSession(connection.sessionId);
      assert.equal(current.snapshotRequired, false);
      assert.equal(current.queuedBatches, 1);
      assert.ok(current.queuedBytes > 0);
      assert.ok(current.queuedBytes <= 1_048_576, 'compacted pending changes remain inside one wire batch');
      latest = current;
    }
    assert.ok(latest);
    acknowledge(ctx.services.clientFeed, connection, sent[0]);
    await waitFor(() => sent.length === 2, 5000, 'byte-heavy compacted changes handoff');
    assert.equal(sent[1].type, 'reliable-kernel.changes');
    assert.equal(sent[1].messageSeq, '2');
    assert.equal(sent[1].changes.length, 400);
    ctx.services.clientFeed.disconnect(connection.sessionId);
    return { compactedBytes: latest.queuedBytes, changeCount: sent[1].changes.length };
  });

  return {
    assertions: [
      'slow ACK期间严格保持一个inflight；共享ACK基线的未发送changes压缩为一个最新commit range',
      '未发送changes不占用messageSeq，ACK后以连续sequence发送一份原子净变化batch',
      '重复更新相同400条可见记录时按(type,id)保留最终值，queuedBytes不随commit数量线性累加'
    ],
    faults: ['slow ACK repeated-record burst', 'slow ACK large repeated-record burst'],
    metrics: {
      maxInflight: 1,
      compactedQueuedBatches: countEvidence.compacted.queuedBatches,
      compactedWireMessages: countEvidence.sent.length,
      compactedLargeBatchBytes: byteEvidence.compactedBytes,
      compactedLargeBatchChanges: byteEvidence.changeCount
    }
  };
}

async function checkSnapshotFeedBarrier() {
  return withRuntime('client-barrier', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const sent = [];
    const originalSnapshot = ctx.database.clientProjectionSnapshot.bind(ctx.database);
    let injectedCommitSeq;
    let injected = false;
    ctx.database.clientProjectionSnapshot = async (activeConversationId) => {
      const barrier = await originalSnapshot(activeConversationId);
      if (!injected) {
        injected = true;
        const commit = await ctx.database.transaction([
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
            id: 'barrier-between-read-register', title: 'barrier', status: 'active',
            created_at: NOW, updated_at: NOW
          })
        ]);
        injectedCommitSeq = commit.commitSeq;
      }
      return barrier;
    };
    const connection = await ctx.services.clientFeed.connect({ send: (message) => sent.push(message) });
    ctx.database.clientProjectionSnapshot = originalSnapshot;
    assert.equal(sent.length, 1);
    const snapshotSeq = sent[0].snapshotCommitSeq;
    assert.equal(BigInt(injectedCommitSeq), BigInt(snapshotSeq) + 1n);
    acknowledge(ctx.services.clientFeed, connection, sent[0]);
    await waitFor(() => sent.length === 2, 5000, 'barrier buffered change');
    assert.equal(sent[1].type, 'reliable-kernel.changes');
    assert.equal(sent[1].commitSeq, injectedCommitSeq);
    assert.ok(sent[1].changes.some((change) => change.id === 'barrier-between-read-register'));
    assertions.push('snapshot读完但订阅handoff尚未返回时受控提交真实事务，listener预注册缓冲使第一批commitSeq严格=snapshotCommitSeq+1且无遗漏');
    faults.push('deterministic commit between snapshot read and feed handoff');
    metrics.snapshotCommitSeq = snapshotSeq;
    metrics.firstChangeCommitSeq = sent[1].commitSeq;
    ctx.services.clientFeed.disconnect(connection.sessionId);

    const refreshSent = [];
    const refreshFailures = [];
    const refreshConnection = await ctx.services.clientFeed.connect({
      send: (message) => refreshSent.push(message),
      onFailure: (error) => refreshFailures.push(error)
    });
    acknowledge(ctx.services.clientFeed, refreshConnection, refreshSent[0]);
    const refreshSnapshot = ctx.database.clientProjectionSnapshot.bind(ctx.database);
    ctx.database.clientProjectionSnapshot = async () => {
      throw new Error('injected snapshot refresh failure');
    };
    ctx.services.clientFeed.requestSnapshot(refreshConnection.sessionId);
    await waitFor(() => refreshFailures.length === 1, 5000, 'snapshot refresh failure notification');
    ctx.database.clientProjectionSnapshot = refreshSnapshot;
    assert.match(String(refreshFailures[0]), /injected snapshot refresh failure/);
    assert.throws(
      () => ctx.services.clientFeed.inspectSession(refreshConnection.sessionId),
      /Unknown bounded client feed session/
    );
    assertions.push('已连接Feed的snapshot refresh失败会关闭坏session并显式通知Bridge恢复，不再静默删除后永久冻结');
    faults.push('asynchronous snapshot refresh rejection after connect resolved');

    const bridgeAttempts = [];
    const bridgeDisconnects = [];
    const bridgeAcks = [];
    const bridgeDiagnostics = [];
    const bridgeErrors = [];
    const bridgePosts = [];
    const successfulInputs = [];
    let bridgeAckFlush;
    const fakeFeed = {
      async connect(input) {
        const attempt = bridgeAttempts.length + 1;
        bridgeAttempts.push(Date.now());
        if (attempt === 1) throw new Error('injected initial bridge connect failure');
        successfulInputs.push(input);
        const sessionId = `bridge-session-${attempt}`;
        input.send({
          type: 'reliable-kernel.snapshot', sessionId, hostBootId: 'bridge-boot', messageSeq: '1',
          snapshotCommitSeq: String(attempt), projections: emptyClientProjection(null)
        });
        return { sessionId, hostBootId: 'bridge-boot' };
      },
      disconnect(sessionId) { bridgeDisconnects.push(sessionId); },
      acknowledge(ack) {
        bridgeAcks.push(ack);
        const flush = bridgeAckFlush;
        bridgeAckFlush = undefined;
        flush?.(ack);
      },
      requestSnapshot() {}
    };
    const fakeDetails = { async read() { throw new Error('detail not used'); } };
    const fakeWebview = {
      postMessage(message) {
        bridgePosts.push(message);
        return Promise.resolve(true);
      }
    };
    const bridge = new kernel.ReliableKernelWebviewFeedBridge(
      fakeFeed,
      fakeDetails,
      (error, context) => bridgeErrors.push({ error, context }),
      { observe(event) { bridgeDiagnostics.push(event); } }
    );
    const bridgeStartedAt = Date.now();
    const bridgeClientId = bridge.attach(fakeWebview, {
      kind: 'mainPanel',
      conversationId: 'bridge-conversation'
    });
    bridge.reconnect(bridgeClientId);
    await waitFor(() => bridgeAttempts.length === 2, 3500, 'bridge initial connect backoff recovery');
    metrics.bridgeInitialRecoveryMs = bridgeAttempts[1] - bridgeStartedAt;
    assert.ok(metrics.bridgeInitialRecoveryMs >= 900 && metrics.bridgeInitialRecoveryMs < 3500);
    const firstBridgeSnapshot = bridgePosts.find((message) => message.sessionId === 'bridge-session-2');
    assert.ok(firstBridgeSnapshot);
    await bridge.handleControl(bridgeClientId, {
      type: 'reliable-kernel.ack', sessionId: 'bridge-session-2', hostBootId: 'bridge-boot', messageSeq: '1'
    });
    assert.equal(bridgeAcks.length, 1);
    successfulInputs.at(-1).onFailure(new Error('injected connected feed failure'));
    await waitFor(() => bridgeAttempts.length === 3, 3500, 'bridge connected-session recovery');
    const recoveredBridgeSnapshot = bridgePosts.find((message) => message.sessionId === 'bridge-session-3');
    assert.ok(recoveredBridgeSnapshot);
    await bridge.handleControl(bridgeClientId, {
      type: 'reliable-kernel.ack', sessionId: 'bridge-session-3', hostBootId: 'bridge-boot', messageSeq: '1'
    });

    const activeBridgeInput = successfulInputs.at(-1);
    const bridgeChanges = (messageSeq, commitSeq, id) => ({
      type: 'reliable-kernel.changes',
      sessionId: 'bridge-session-3',
      hostBootId: 'bridge-boot',
      messageSeq,
      commitSeq,
      changes: [{ type: 'Conversation', operation: 'remove', id }]
    });
    activeBridgeInput.send(bridgeChanges('2', '4', 'bridge-ack-one'));
    bridgeAckFlush = () => activeBridgeInput.send(bridgeChanges('3', '5', 'bridge-ack-two'));
    await bridge.handleControl(bridgeClientId, {
      type: 'reliable-kernel.ack', sessionId: 'bridge-session-3', hostBootId: 'bridge-boot', messageSeq: '2'
    });
    await bridge.handleControl(bridgeClientId, {
      type: 'reliable-kernel.ack', sessionId: 'bridge-session-3', hostBootId: 'bridge-boot', messageSeq: '3'
    });
    assert.ok(bridgeDiagnostics.some((event) =>
      event.eventKind === 'feed.data.acked' && event.correlationId === '2'
    ));
    assert.ok(bridgeDiagnostics.some((event) =>
      event.eventKind === 'feed.data.acked' && event.correlationId === '3'
    ));

    for (let streamSeq = 1; streamSeq <= 9; streamSeq += 1) {
      bridge.broadcastTransient({
        conversationId: 'bridge-conversation',
        turnId: 'bridge-turn',
        modelRequestId: 'bridge-model-request',
        requestSeq: '1',
        providerId: 'bridge-provider',
        modelId: 'bridge-model',
        attemptSeq: '1',
        socketGeneration: '1',
        afterCommitSeq: '5',
        observedAt: NOW,
        event: {
          kind: 'output_delta',
          streamSeq: String(streamSeq),
          content: { type: 'text_delta', text: String(streamSeq) }
        }
      });
    }
    await waitFor(
      () => bridgePosts.some((message) => message.type === 'reliable-kernel.transient-batch'),
      1_000,
      'transient batch flush'
    );
    const transientBatch = bridgePosts.find((message) =>
      message.type === 'reliable-kernel.transient-batch'
    );
    assert.equal(transientBatch.events.length, 9);
    assert.deepEqual(
      transientBatch.events.map((event) => event.event.streamSeq),
      Array.from({ length: 9 }, (_, index) => String(index + 1))
    );
    bridge.close();
    assert.equal(bridgeErrors.length, 2);
    assert.deepEqual(bridgeErrors.map((entry) => entry.context.operation), ['connect', 'connect']);
    assert.ok(bridgeDisconnects.includes('bridge-session-2'));
    assertions.push('Bridge首次connect单次失败时connection保持待恢复并沿同一封顶退避成功；已连接session故障通知也复用该恢复路径');
    assertions.push('ACK同步flush下一帧时旧帧诊断不丢且不清除新watchdog；同ModelRequest突发transient按32ms窗口合并为一条有序batch');
    faults.push('one-shot initial bridge connect failure and post-connect session failure');
    faults.push('queued ACK synchronous refill and nine-event transient IPC burst');
    return { assertions, faults, metrics };
  });
}

async function checkOldWriterNotRouted() {
  const assertions = [];
  const faults = [];
  const metrics = {};
  const entry = path.join(root, 'dist/extension/vscode/extension.js');
  const graph = emittedRequireClosure(entry);
  const forbidden = [
    '/backend/reliability/',
    '/backend/application/BackendApplication.js',
    '/backend/world/modules/agentRun/',
    '/backend/application/conversationFork.js',
    '/backend/capabilities/vscodeStorage/clientStateStore.js',
    '/shared/runLifecycle.js',
    '/shared/agentRunActivity.js'
  ];
  for (const file of graph) {
    const normalized = file.split(path.sep).join('/');
    for (const selector of forbidden) assert.equal(normalized.includes(selector), false, `${normalized} reaches ${selector}`);
  }
  const source = await fs.readFile('backend/reliableKernel/runtimeServices.ts', 'utf8');
  assert.doesNotMatch(source, /dual.?write|AgentRunRecord|includeApiKey|streamSeq|ClientStateDb/);
  assert.match(source, /Unsupported run_agent operation/);
  const domains = new Set(kernel.RUNTIME_DOMAIN_SCHEMAS.map((entry) => entry.key));
  for (const forbiddenDomain of ['AgentRun', 'TaskList', 'ClientChangeLog', 'ProviderContinuation']) {
    assert.equal(domains.has(forbiddenDomain), false);
  }
  assertions.push('真实VS Code extension main emitted require closure不可达旧file writer、BackendApplication、AgentRun/run-history/full ClientState入口');
  assertions.push('未知可靠Runtime route显式失败且无旧路由/双写/importer；Runtime exact set无AgentRun/TaskList/ClientChangeLog/ProviderContinuation');

  const transition = JSON.parse(await fs.readFile('docs/architecture/reliable-kernel/contracts/transition-ledger.json', 'utf8'));
  const phaseFEntries = transition.entries.filter((entry) => entry.replacementStage === 'F');
  assert.ok(phaseFEntries.length >= 10);
  for (const entryRecord of phaseFEntries) {
    // shared/protocol.ts is the current Bridge/configuration contract as well as the historical home
    // of several erased TypeScript-only legacy interfaces. File-level require closure cannot prove
    // reachability of an erased symbol, so only executable module selectors are gated by path.
    if (entryRecord.selector.path === 'shared/protocol.ts') continue;
    assert.equal(
      graph.has(path.resolve(root, 'dist/extension', entryRecord.selector.path.replace(/\.ts$/, '.js'))),
      false,
      `${entryRecord.key} still reaches ${entryRecord.selector.path}`
    );
  }
  const bridgeSource = await fs.readFile('webview/src/transport/bridge.ts', 'utf8');
  assert.doesNotMatch(bridgeSource.match(/interface BridgePersistedState \{[\s\S]*?\}/)?.[0] ?? '', /clientId/);
  assert.match(bridgeSource, /toStructuredClonePlainData/);
  const clientFeedSource = await fs.readFile('shared/reliableKernelClientFeed.ts', 'utf8');
  const snapshotSeedMap = clientFeedSource.match(/const arrayKeyToType:[\s\S]*?\n  \};/)?.[0] ?? '';
  assert.match(snapshotSeedMap, /\bmessages:\s*['"]Message['"]/);
  const runAgentDisplay = await fs.readFile('webview/src/components/content/toolDisplay/runAgentToolDisplay.ts', 'utf8');
  for (const fact of ['childExecutionState', 'activeChildTurnState', 'answerSubmissionState', 'runtimeDeliveryState', 'parentHandlingState', 'terminationState']) {
    assert.match(runAgentDisplay, new RegExp(fact));
  }
  assert.doesNotMatch(runAgentDisplay, /activityStage|notificationRun|runIdFrom/);
  const conversationProjection = await fs.readFile('webview/src/domain/reliableConversationProjection.ts', 'utf8');
  assert.match(conversationProjection, /call\.tool_name === 'run_agent' \? 'awaiting_child' : 'awaiting_user_input'/);
  const functionCallView = await fs.readFile('webview/src/components/content/parts/FunctionCallPartView.vue', 'utf8');
  assert.match(functionCallView, /awaiting_child: '等待子 Agent 回答'/);
  assert.match(functionCallView, /子 Agent 已在后台运行/);
  const conversationRunner = await fs.readFile('backend/application/reliableKernel/ReliableConversationRunner.ts', 'utf8');
  assert.match(conversationRunner, /if \(intents\.length === 0\) return null;/);
  assert.doesNotMatch(conversationRunner, /must have exactly one admitted TurnIntent/);
  const childCoordinator = await fs.readFile('backend/reliableKernel/childAgentCoordinator.ts', 'utf8');
  assert.match(childCoordinator, /reconcileFailedTurn/);
  assert.doesNotMatch(childCoordinator, /const recover = failed \|\|/);
  const answerDelivery = await fs.readFile('backend/reliableKernel/answerDelivery.ts', 'utf8');
  assert.match(answerDelivery, /settleForegroundFailure/);
  assert.match(answerDelivery, /ensureFailed/);
  const completionDelivery = await fs.readFile('backend/reliableKernel/processCompletionDelivery.ts', 'utf8');
  assert.match(completionDelivery, /child_failure/);
  const productRuntime = await fs.readFile(
    'backend/application/reliableKernel/VscodeReliableKernelProductRuntime.ts',
    'utf8'
  );
  assert.match(productRuntime, /sourceKind === 'child_failure'/);
  assert.match(productRuntime, /showErrorMessage/);
  assertions.push('F executable transition selectors不进入production graph；shared\/protocol中的已擦除类型不按整文件误判；Bridge session只驻内存、快照messages恢复Message bucket，run_agent等待子Agent\/转后台语义明确，初始Child无TurnIntent直接进入AgentLoop且后台失败走failed AnswerSubmission\/RuntimeDeliveryWake');
  metrics.productionEntry = path.relative(root, entry).split(path.sep).join('/');
  metrics.emittedClosureFiles = graph.size;
  metrics.phaseFTransitionEntries = phaseFEntries.length;
  faults.push('candidate import-graph traversal against all Phase F legacy selectors');
  return { assertions, faults, metrics };
}

async function checkRecoveryAnswerInbox() {
  return withRuntime('recovery-answer', async (ctx) => {
    const assertions = [];
    const faults = [];
    const parent = await seedParent(ctx, 'recovery-answer');
    const child = await spawnStartedChild(ctx, parent.turnId, 'recovery-answer', 'background');
    const submitted = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'recovery-answer-submission',
      sourceTurnId: child.childTurnId,
      content: 'repair me'
    });
    mutateSqlite(ctx.binding.paths.databasePath, (database) => {
      database.prepare('DELETE FROM runtime_inbox_item WHERE id = ?').run(submitted.inboxItemId);
    });
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', {
      source_id: submitted.submissionId
    })).length, 0);
    const liveOwnerScan = await ctx.services.recovery.run(
      kernel.PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT
    );
    assert.equal(liveOwnerScan.reconciled, 0);
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', {
      source_id: submitted.submissionId
    })).length, 0);
    assert.equal((await list(ctx.database, 'RuntimeDelivery', {
      inbox_item_id: submitted.inboxItemId
    })).length, 0);
    await closeRuntime(ctx);
    await reopenRuntime(ctx, 'recovery-answer-restart');
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', { source_id: submitted.submissionId })).length, 0);
    const first = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT);
    const second = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT);
    assert.equal(first.reconciled, 1);
    assert.equal(second.reconciled, 0);
    const inbox = (await list(ctx.database, 'RuntimeInboxItem', { source_id: submitted.submissionId }))[0];
    assert.equal(inbox.dedupe_key, `answer:${child.answerBridgeId}:${submitted.submissionId}`);
    const activeDeliveries = await list(ctx.database, 'RuntimeDelivery', { inbox_item_id: inbox.id });
    assert.equal(activeDeliveries.length, 1);
    assert.equal(activeDeliveries[0].phase, 'current_turn');
    assert.equal(activeDeliveries[0].target_turn_id, parent.turnId);
    assert.equal((await get(ctx.database, 'AnswerBridge', child.answerBridgeId)).current_submission_id, submitted.submissionId);
    assertions.push('跨真实数据库关闭/重开按bridge+submission稳定身份补建缺失InboxItem与父目标Delivery且不改AnswerSubmission/Bridge');
    assertions.push('answer-inbox scanner重复运行幂等，不产生重复Inbox、Delivery或外部effect');
    assertions.push('来源子Turn仍由可验证live Host持有时，即使Inbox缺失，恢复扫描也保持只读；owner退出后才以Turn/Lease authority fence补建');

    const terminalAnswer = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'recovery-answer-terminal-parent',
      sourceTurnId: child.childTurnId,
      content: 'parent already terminated before delivery orchestration'
    });
    await createTurnControl(ctx, 'recovery-answer-parent-terminal').terminal({
      source: { kind: 'callback', key: 'recovery-answer-parent-terminal' },
      turnId: parent.turnId,
      terminalStatus: 'completed',
      reason: 'simulate parent completion before answer delivery creation'
    });
    await closeRuntime(ctx);
    await reopenRuntime(ctx, 'recovery-answer-terminal-restart');
    const concurrent = await Promise.all([
      ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT),
      ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT)
    ]);
    const terminalDeliveries = await list(ctx.database, 'RuntimeDelivery', {
      inbox_item_id: terminalAnswer.inboxItemId
    });
    assert.equal(terminalDeliveries.length, 1);
    assert.equal(terminalDeliveries[0].phase, 'next_turn');
    assert.equal(terminalDeliveries[0].target_turn_id, null);
    assert.equal(terminalDeliveries[0].state, 'pending');
    assert.equal(
      (await ctx.services.deliveries.summary(terminalDeliveries[0].id)).parentHandlingState,
      'unhandled'
    );
    const allAfterConcurrent = await ctx.services.recovery.runAll();
    assert.equal((await list(ctx.database, 'RuntimeDelivery', {
      inbox_item_id: terminalAnswer.inboxItemId
    })).length, 1);
    assert.equal(
      allAfterConcurrent.find((entry) => entry.id === kernel.PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT).reconciled,
      0
    );
    assertions.push('父Turn以completed终止后的缺失Delivery恢复为next_turn且不续写旧Turn，等待专属调度器启动新Turn');
    assertions.push('两个并发恢复扫描经稳定Delivery identity与authority CAS收敛为唯一pending next_turn，后续runAll保持幂等');
    faults.push(
      'committed AnswerSubmission with missing RuntimeInboxItem and RuntimeDelivery across restart',
      'parent Turn completed before next-turn delivery creation'
    );
    return {
      assertions,
      faults,
      metrics: {
        firstReconciled: first.reconciled,
        secondReconciled: second.reconciled,
        concurrentReconciled: concurrent.reduce((sum, result) => sum + result.reconciled, 0),
        terminalDeliveries: terminalDeliveries.length
      }
    };
  });
}

async function checkRecoveryPendingDelivery() {
  return withRuntime('recovery-delivery', async (ctx) => {
    const assertions = [];
    const faults = [];
    const parent = await seedParent(ctx, 'recovery-delivery');
    const child = await spawnStartedChild(ctx, parent.turnId, 'recovery-delivery', 'background');
    const answer = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'recovery-delivery-answer',
      sourceTurnId: child.childTurnId,
      content: 'deliver after restart'
    });
    const delivery = await ctx.services.deliveries.create({
      inboxItemId: answer.inboxItemId,
      targetConversationId: parent.conversationId,
      targetTurnId: parent.turnId,
      phase: 'current_turn'
    });
    const notifyAnswer = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'recovery-delivery-notify-answer',
      sourceTurnId: child.childTurnId,
      content: 'notify after restart'
    });
    const notify = await ctx.services.deliveries.create({
      inboxItemId: notifyAnswer.inboxItemId,
      targetConversationId: parent.conversationId,
      phase: 'notify_only'
    });
    await closeRuntime(ctx);
    await reopenRuntime(ctx, 'recovery-delivery-restart');
    const first = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_DELIVERY_PENDING);
    const second = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_DELIVERY_PENDING);
    const summary = await ctx.services.deliveries.summary(delivery.delivery.id);
    assert.equal(first.reconciled, 1);
    assert.equal(second.reconciled, 0);
    assert.equal(summary.delivery.state, 'consumed');
    assert.ok(summary.inputLink);
    assert.equal(summary.parentHandlingState, 'unhandled');
    const pendingNotify = await ctx.services.deliveries.summary(notify.delivery.id);
    assert.equal(pendingNotify.delivery.state, 'pending');
    assert.equal(pendingNotify.delivery.phase, 'notify_only');
    assert.equal(pendingNotify.inputLink, null);
    assert.equal(
      (await ctx.services.deliveries.acknowledgeNotification(notify.delivery.id)).delivery.state,
      'consumed'
    );
    assertions.push('restart后pending delivery按advancement matrix注入真实PendingTurnInput+InputLink并置consumed');
    assertions.push('delivery recovery重复扫描不重复注入、不重复推进且不消费handled_at');
    assertions.push('notify_only恢复扫描保持pending且不伪造InputLink，直到真实产品通知路径显式ACK');
    faults.push('pending current_turn and notify_only deliveries across Extension Host restart');
    return { assertions, faults, metrics: { inputLinks: (await list(ctx.database, 'RuntimeDeliveryInputLink', { delivery_id: delivery.delivery.id })).length } };
  });
}

async function checkRecoveryForegroundWait() {
  return withRuntime('recovery-foreground', async (ctx) => {
    const assertions = [];
    const faults = [];

    assert.equal(MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN, 8);
    const admissionValues = Array.from({ length: 9 }, (_, index) => index);
    const admissionStarts = [];
    const admissionControls = new Map();
    const admissionCompletions = new Map();
    const admissionOperation = mapSettledWithBoundedAdmissionConcurrency(
      admissionValues,
      MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN,
      async (value, _index, _signal, admission) => {
        admissionStarts.push(value);
        admissionControls.set(value, admission);
        await new Promise((resolve) => admissionCompletions.set(value, resolve));
        return value;
      }
    );
    await waitFor(() => admissionStarts.length === 8, 1_000, 'first eight child admissions');
    assert.deepEqual(admissionStarts, admissionValues.slice(0, 8));
    admissionControls.get(0).release();
    await waitFor(() => admissionStarts.length === 9, 1_000, 'ninth child admission');
    assert.deepEqual(admissionStarts, admissionValues);
    for (const resolve of admissionCompletions.values()) resolve();
    assert.deepEqual(
      await admissionOperation,
      admissionValues.map((value) => ({ status: 'fulfilled', value }))
    );

    const admissionAbort = new AbortController();
    const admissionAbortReason = new Error('phase-f parent cancellation after durable child spawn');
    const admissionAbortSignals = [];
    const admissionAbortStarts = [];
    const admissionAbortOperation = mapSettledWithBoundedAdmissionConcurrency(
      [0, 1, 2],
      2,
      (value, _index, signal, admission) => {
        admissionAbortStarts.push(value);
        admissionAbortSignals.push(signal);
        if (value === 0) admission.release();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      admissionAbort.signal
    );
    await waitFor(() => admissionAbortStarts.length === 3, 1_000, 'released admission cancellation');
    admissionAbort.abort(admissionAbortReason);
    await assert.rejects(admissionAbortOperation, (error) => error === admissionAbortReason);
    assert.ok(admissionAbortSignals.every((signal) =>
      signal.aborted && signal.reason === admissionAbortReason
    ));
    assertions.push('run_agent启动槽固定为8；第9个在durable admission release后立即启动而不等待foreground结果，已释放槽的worker仍接收父取消');
    faults.push('nine long foreground child starts with parent cancellation after durable admission release');

    const parent = await seedParent(ctx, 'recovery-foreground');
    const child = await spawnStartedChild(ctx, parent.turnId, 'recovery-foreground', 'wait_for_answer', {
      deadline: '2026-08-01T00:01:00.000Z'
    });
    await closeRuntime(ctx);
    await reopenRuntime(ctx, 'recovery-foreground-restart', () => '2026-08-01T00:02:00.000Z');
    const first = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED);
    const second = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED);
    assert.equal(first.reconciled, 1);
    assert.equal(second.reconciled, 0);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: child.toolCallId })).length, 1);
    const terminal = await ctx.services.effects.readTerminalResult(child.toolCallId, false);
    assert.equal(terminal.status, 'succeeded');

    const parallel = [];
    for (const suffix of ['one', 'two', 'three']) {
      parallel.push(await spawnStartedChild(
        ctx,
        parent.turnId,
        `parallel-foreground-${suffix}`,
        'wait_for_answer',
        { deadline: '2026-08-01T00:02:00.000Z' }
      ));
    }
    const reverseSettlements = await Promise.all([...parallel].reverse().map((entry) =>
      ctx.services.children.settleForegroundTimeout(entry.childExecutionId, '2026-08-01T00:02:00.000Z')
    ));
    assert.deepEqual(reverseSettlements, [true, true, true]);
    const orderedResults = [];
    for (const entry of parallel) {
      const call = await get(ctx.database, 'ToolCall', entry.toolCallId);
      const operation = (await list(ctx.database, 'Operation', { tool_call_id: entry.toolCallId }))[0];
      const artifact = (await list(ctx.database, 'ToolResultArtifact', {
        tool_call_id: entry.toolCallId,
        role: 'no_effect_result'
      }))[0];
      const result = (await list(ctx.database, 'ToolModelResult', { tool_call_id: entry.toolCallId }))[0];
      assert.equal(operation.status, 'succeeded');
      assert.ok(artifact);
      assert.ok(result);
      const revision = await get(ctx.database, 'MessageRevision', result.message_revision_id);
      const membership = (await list(ctx.database, 'MessagePartOfConversation', {
        message_id: revision.message_id
      }))[0];
      orderedResults.push({ callSeq: call.call_seq, messageSeq: membership.message_seq });
    }
    const byCallSeq = [...orderedResults].sort((left, right) => left.callSeq < right.callSeq ? -1 : 1);
    assert.ok(byCallSeq.every((entry, index) =>
      index === 0 || byCallSeq[index - 1].messageSeq < entry.messageSeq
    ));
    assertions.push('三个并行run_agent按逆call_seq同时超时：Operation/Artifact先独立结算，随后无需reload按call_seq物化全部ToolModelResult');
    faults.push('three parallel foreground deadlines settle in reverse call_seq');

    const liveParallel = [];
    const answerByTurn = new Map();
    const coordinatorLeaseOwner = `child-driver:${ctx.database.hostBootId}`;
    for (const suffix of ['one', 'two', 'three']) {
      const entry = await spawnStartedChild(
        ctx,
        parent.turnId,
        `parallel-initial-child-${suffix}`,
        'wait_for_answer',
        {
          deadline: '2026-08-01T00:05:00.000Z',
          leaseOwnerId: coordinatorLeaseOwner
        }
      );
      liveParallel.push(entry);
      answerByTurn.set(entry.childTurnId, entry.answerBridgeId);
      assert.equal((await list(ctx.database, 'TurnIntent', { turn_id: entry.childTurnId })).length, 0);
    }
    const conversations = new ReliableConversationRunner(
      { database: ctx.database },
      `phase-f-initial-child:${ctx.database.hostBootId}`
    );
    let coordinator;
    let liveDriveCount = 0;
    try {
      coordinator = new kernel.ReliableChildAgentCoordinator({
        database: ctx.database,
        effects: ctx.services.effects,
        children: ctx.services.children,
        answers: ctx.services.answers,
        deliveries: ctx.services.deliveries,
        modelProvider: {},
        now: ctx.now,
        turns: createTurnControl(ctx, 'parallel-initial-child'),
        agentLoop: {
          async drive(turnId) {
            liveDriveCount += 1;
            const answerBridgeId = answerByTurn.get(turnId);
            assert.ok(answerBridgeId);
            const submitted = await ctx.services.answers.submit({
              answerBridgeId,
              submissionId: `parallel-initial-child-answer-${turnId}`,
              sourceTurnId: turnId,
              content: `completed ${turnId}`
            });
            assert.equal(submitted.foregroundSettled, true);
            await createTurnControl(ctx, `parallel-initial-child-${turnId}`).terminal({
              source: { kind: 'callback', key: `parallel-initial-child-terminal-${turnId}` },
              turnId,
              terminalStatus: 'completed',
              reason: 'phase-f initial child completed'
            });
            return {
              turnId,
              terminalStatus: 'completed',
              modelRequestIds: [`model-request-${turnId}`],
              assistantMessageIds: [],
              toolCallIds: []
            };
          }
        },
        agents: {
          async resolve() {
            return { agentId: 'phase-f-child-agent', agentType: 'worker' };
          }
        },
        modelProfiles: {
          async initializeConversation() { return { created: false }; }
        },
        manualCompression: {
          async admit() { throw new Error('unused'); },
          async inspect() { return null; },
          driveIfPresent: (input) => conversations.driveManualCompressionIfPresent(input)
        }
      });
      coordinator.disposing = true;
      const liveResults = await Promise.all(liveParallel.map((entry) =>
        coordinator.driveChild(entry.childExecutionId, entry.childTurnId)
      ));
      assert.ok(liveResults.every((result) => result.terminalStatus === 'completed'));
      assert.equal(liveDriveCount, 3);
      for (const entry of liveParallel) {
        assert.equal((await list(ctx.database, 'ModelRequest', { turn_id: entry.childTurnId })).length, 0);
        assert.equal((await list(ctx.database, 'TurnTermination', { turn_id: entry.childTurnId }))[0].terminal_status, 'completed');
        assert.equal((await list(ctx.database, 'ToolOutcome', { tool_call_id: entry.toolCallId }))[0].status, 'succeeded');
        assert.equal((await list(ctx.database, 'ChildExecutionActiveTurnLink', {
          child_execution_id: entry.childExecutionId
        })).length, 0);
      }
    } finally {
      await coordinator?.dispose();
      conversations.dispose();
      await conversations.waitForIdle();
    }
    assertions.push('三个并发初始Child均无TurnIntent，production维护分类返回null并全部进入AgentLoop完成，而非卡在准备上下文');
    faults.push('three parallel initial child turns have no TurnIntent when maintenance dispatch runs');

    const failedChild = await spawnStartedChild(
      ctx,
      parent.turnId,
      'child-drive-terminal-failure',
      'wait_for_answer',
      {
        deadline: '2026-08-01T00:05:00.000Z',
        leaseOwnerId: coordinatorLeaseOwner
      }
    );
    let failedCoordinator;
    try {
      failedCoordinator = new kernel.ReliableChildAgentCoordinator({
        database: ctx.database,
        effects: ctx.services.effects,
        children: ctx.services.children,
        answers: ctx.services.answers,
        deliveries: ctx.services.deliveries,
        modelProvider: {},
        now: ctx.now,
        turns: createTurnControl(ctx, 'child-drive-terminal-failure'),
        agentLoop: {
          async drive() {
            assert.fail('maintenance failure must not fall through to AgentLoop');
          }
        },
        agents: {
          async resolve() {
            return { agentId: 'phase-f-failing-child', agentType: 'worker' };
          }
        },
        modelProfiles: {
          async initializeConversation() { return { created: false }; }
        },
        manualCompression: {
          async admit() { throw new Error('unused'); },
          async inspect() { return null; },
          async driveIfPresent() { throw new Error('phase-f deterministic child drive failure'); }
        }
      });
      failedCoordinator.disposing = true;
      const failedResult = await failedCoordinator.driveChild(
        failedChild.childExecutionId,
        failedChild.childTurnId
      );
      assert.equal(failedResult.terminalStatus, 'failed');
      const failedTerminations = await list(ctx.database, 'TurnTermination', {
        turn_id: failedChild.childTurnId
      });
      const failedOutcomes = await list(ctx.database, 'ToolOutcome', {
        tool_call_id: failedChild.toolCallId
      });
      const failedExecutions = await list(ctx.database, 'ToolExecution', {
        tool_call_id: failedChild.toolCallId
      });
      assert.equal(failedTerminations.length, 1);
      assert.equal(failedTerminations[0].terminal_status, 'failed');
      assert.equal(failedOutcomes.length, 1);
      assert.equal(failedOutcomes[0].status, 'failed');
      assert.equal(failedExecutions[0].status, 'completed');
      assert.equal((await list(ctx.database, 'ChildExecutionActiveTurnLink', {
        child_execution_id: failedChild.childExecutionId
      })).length, 0);
      assert.equal((await list(ctx.database, 'ExecutionLease', {
        turn_id: failedChild.childTurnId
      })).length, 0);
      const failedSubmissions = await list(ctx.database, 'AnswerSubmission', {
        turn_id: failedChild.childTurnId
      });
      assert.equal(failedSubmissions.length, 1);
      assert.equal(failedSubmissions[0].interrupted, 0n);
      const failedInbox = (await list(ctx.database, 'RuntimeInboxItem', {
        source_id: failedSubmissions[0].id
      }))[0];
      assert.equal(failedInbox.state, 'settled');
      assert.equal((await list(ctx.database, 'RuntimeDelivery', {
        inbox_item_id: failedInbox.id
      })).length, 0);
      assert.equal((await ctx.services.answers.readCurrent(failedChild.answerBridgeId)).status, 'failed');

      const backgroundFailedChild = await spawnStartedChild(
        ctx,
        parent.turnId,
        'child-drive-background-failure',
        'background',
        { leaseOwnerId: coordinatorLeaseOwner }
      );
      const backgroundFailedResult = await failedCoordinator.driveChild(
        backgroundFailedChild.childExecutionId,
        backgroundFailedChild.childTurnId
      );
      assert.equal(backgroundFailedResult.terminalStatus, 'failed');
      assert.equal((await list(ctx.database, 'ToolOutcome', {
        tool_call_id: backgroundFailedChild.toolCallId
      }))[0].status, 'succeeded');
      const backgroundFailedSubmissions = await list(ctx.database, 'AnswerSubmission', {
        turn_id: backgroundFailedChild.childTurnId
      });
      assert.equal(backgroundFailedSubmissions.length, 1);
      assert.equal(backgroundFailedSubmissions[0].interrupted, 0n);
      const backgroundFailedInbox = (await list(ctx.database, 'RuntimeInboxItem', {
        source_id: backgroundFailedSubmissions[0].id
      }))[0];
      const backgroundFailedDeliveries = await list(ctx.database, 'RuntimeDelivery', {
        inbox_item_id: backgroundFailedInbox.id
      });
      assert.equal(backgroundFailedDeliveries.length, 1);
      const backgroundFailedInputLinks = await list(ctx.database, 'RuntimeDeliveryInputLink', {
        delivery_id: backgroundFailedDeliveries[0].id
      });
      const wakeRequests = [];
      const wakeScheduler = new kernel.ProcessCompletionDeliveryControlPlane(
        ctx.database,
        ctx.store,
        {},
        ctx.services.deliveries,
        {
          now: ctx.now,
          scanIntervalMs: 60_000,
          async wakeHandler(request) {
            wakeRequests.push(request);
            return { acknowledged: true };
          }
        }
      );
      try {
        await wakeScheduler.start();
        assert.equal(wakeRequests.length, 1);
        assert.equal(wakeRequests[0].sourceKind, 'child_failure');
        assert.equal(wakeRequests[0].sourceTurnId, parent.turnId);
      } finally {
        await wakeScheduler.dispose();
      }
      if (backgroundFailedInputLinks.length === 1) {
        await ctx.services.deliveries.markInputHandled(
          backgroundFailedInputLinks[0].pending_turn_input_id
        );
      }
      assert.equal((await ctx.services.answers.readCurrent(
        backgroundFailedChild.answerBridgeId
      )).status, 'failed');
    } finally {
      await failedCoordinator?.dispose();
    }

    const restartFailedChild = await spawnStartedChild(
      ctx,
      parent.turnId,
      'child-drive-failure-restart-boundary',
      'background'
    );
    await createTurnControl(ctx, 'child-drive-failure-restart-boundary').terminal({
      source: { kind: 'callback', key: 'child-drive-failure-restart-boundary' },
      turnId: restartFailedChild.childTurnId,
      terminalStatus: 'failed',
      reason: 'phase-f failure committed before coordinator reconciliation'
    });
    assert.equal((await list(ctx.database, 'ChildExecutionActiveTurnLink', {
      child_execution_id: restartFailedChild.childExecutionId
    })).length, 1);
    await closeRuntime(ctx);
    await reopenRuntime(ctx, 'recovery-foreground-failed-child-restart', () => '2026-08-01T00:02:00.000Z');
    await ctx.services.recovery.runAll();
    assert.equal((await list(ctx.database, 'ChildExecutionActiveTurnLink', {
      child_execution_id: restartFailedChild.childExecutionId
    })).length, 0);
    const restartFailedSubmissions = await list(ctx.database, 'AnswerSubmission', {
      turn_id: restartFailedChild.childTurnId
    });
    assert.equal(restartFailedSubmissions.length, 1);
    assert.equal(restartFailedSubmissions[0].interrupted, 0n);
    const restartFailedInbox = (await list(ctx.database, 'RuntimeInboxItem', {
      source_id: restartFailedSubmissions[0].id
    }))[0];
    const restartFailedDeliveries = await list(ctx.database, 'RuntimeDelivery', {
      inbox_item_id: restartFailedInbox.id
    });
    assert.equal(restartFailedDeliveries.length, 1);
    const restartFailedInputLinks = await list(ctx.database, 'RuntimeDeliveryInputLink', {
      delivery_id: restartFailedDeliveries[0].id
    });
    if (restartFailedInputLinks.length === 1) {
      await ctx.services.deliveries.markInputHandled(restartFailedInputLinks[0].pending_turn_input_id);
    }
    assertions.push('Extension Host在failed TurnTermination后崩溃时，startup recovery先补failed AnswerSubmission/RuntimeDelivery再清active pointer');
    faults.push('host restart after failed TurnTermination commit and before child reconciliation');

    assertions.push('非handoff child drive异常立即失败前台ToolCall并释放active link/lease；后台模式提交failed AnswerSubmission与RuntimeDelivery，不等待deadline');
    faults.push('non-handoff child drive throws before AgentLoop in foreground and background');

    const backgroundPrepared = [];
    for (const suffix of ['one', 'two', 'three']) {
      const tool = await createRunAgentTool(ctx, parent.turnId, `parallel-background-${suffix}`);
      const spawned = await ctx.services.children.spawn({
        sourceToolCallId: tool.toolCallId,
        childAgentId: `child-agent-parallel-background-${suffix}`,
        modelFallback: CHILD_MODEL_FALLBACK,
        sourceSettlement: 'child_handle',
        prompt: `parallel background ${suffix}`,
        completionPolicy: 'background',
        leaseOwnerId: `child-owner-parallel-background-${suffix}`,
        leaseExpiresAt: '2026-08-02T00:00:00.000Z'
      });
      assert.equal(await ctx.services.children.claimSpawnDispatch(spawned.effectIntentId), true);
      const receipt = await ctx.services.children.recordSpawnReceipt({
        sourceKey: `spawn-callback-parallel-background-${suffix}`,
        attemptId: spawned.attemptId,
        outcome: 'succeeded'
      });
      backgroundPrepared.push({ ...spawned, toolCallId: tool.toolCallId, receiptId: receipt.effectReceiptId });
    }
    await Promise.all([...backgroundPrepared].reverse().map((entry) =>
      ctx.services.children.reconcileSpawnReceipt(entry.receiptId)
    ));
    for (const entry of backgroundPrepared) {
      assert.ok((await list(ctx.database, 'ToolResultArtifact', {
        tool_call_id: entry.toolCallId,
        role: 'no_effect_result'
      }))[0]);
      assert.ok((await list(ctx.database, 'ToolModelResult', { tool_call_id: entry.toolCallId }))[0]);
    }
    assertions.push('三个并行background spawn逆call_seq结算时先写Operation/Artifact，再按序物化且无需reload');
    faults.push('parallel background spawn settlement behind call-order barrier');

    const continuationPrepared = [];
    for (const [index, entry] of backgroundPrepared.entries()) {
      const suffix = `parallel-background-continuation-${index + 1}`;
      const tool = await createRunAgentTool(ctx, parent.turnId, suffix);
      continuationPrepared.push({
        toolCallId: tool.toolCallId,
        childExecutionId: entry.childExecutionId,
        suffix
      });
    }
    await Promise.all([...continuationPrepared].reverse().map((entry) =>
      ctx.services.children.send({
        sourceKey: `send-${entry.suffix}`,
        sourceToolCallId: entry.toolCallId,
        childExecutionId: entry.childExecutionId,
        mode: 'queue_next_turn',
        content: entry.suffix,
        completionPolicy: 'background'
      })
    ));
    for (const entry of continuationPrepared) {
      const settled = await ctx.services.children.finalizeWaitSettlement(entry.toolCallId);
      assert.equal(settled?.status, 'succeeded');
      assert.ok((await list(ctx.database, 'ToolModelResult', { tool_call_id: entry.toolCallId }))[0]);
    }
    assertions.push('三个并行background continuation逆call_seq提交时同样通过Operation/Artifact两阶段结算');
    faults.push('parallel background continuation settlement behind call-order barrier');

    const cancelledFirst = await spawnStartedChild(
      ctx,
      parent.turnId,
      'foreground-cancel-first-wins',
      'wait_for_answer',
      { deadline: '2026-08-01T00:02:00.000Z' }
    );
    assert.equal(await ctx.services.children.cancelForegroundWaitForToolCall({
      toolCallId: cancelledFirst.toolCallId,
      reason: 'fixture parent interrupt',
      sourceIdentity: 'fixture-parent-interrupt'
    }), true);
    assert.equal(
      await ctx.services.children.settleForegroundTimeout(
        cancelledFirst.childExecutionId,
        '2026-08-01T00:02:00.000Z'
      ),
      false
    );
    const answerAfterCancel = await ctx.services.answers.submit({
      answerBridgeId: cancelledFirst.answerBridgeId,
      submissionId: 'answer-after-foreground-cancel',
      sourceTurnId: cancelledFirst.childTurnId,
      content: 'answer remains durable after parent wait cancellation'
    });
    assert.equal(answerAfterCancel.foregroundSettled, false);
    assert.equal((await get(ctx.database, 'Operation', cancelledFirst.operationId)).status, 'cancelled');
    assert.equal((await ctx.services.effects.readTerminalResult(cancelledFirst.toolCallId, false)).status, 'cancelled');
    assert.equal((await list(ctx.database, 'ToolResultArtifact', {
      tool_call_id: cancelledFirst.toolCallId,
      role: 'no_effect_result'
    })).length, 1);
    assertions.push('parent cancel先提交后，timeout与late answer均不能覆盖cancelled Operation/Artifact，first-wins保持单一结果');
    faults.push('cancel wins before foreground timeout and late answer');

    await createTurnControl(ctx, 'recovery-foreground-terminal').terminal({
      source: { kind: 'callback', key: 'recovery-foreground-parent-terminal' },
      turnId: parent.turnId,
      terminalStatus: 'completed',
      reason: 'parent completed after background handle'
    });
    const late = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'late-after-foreground-timeout',
      sourceTurnId: child.childTurnId,
      content: 'late answer'
    });
    assert.equal(late.foregroundSettled, false);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: child.toolCallId })).length, 1);
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', { source_id: late.submissionId })).length, 1);
    assert.equal((await get(ctx.database, 'Turn', parent.turnId)).status, 'terminated');
    assertions.push('过期waiting_answer跨restart转后台控制句柄并只结算原ToolCall一次，deadline持久化事实被真实扫描');
    assertions.push('late answer仅进入AnswerSubmission/Inbox，不产生第二ToolModelResult也不强制启动父模型');
    faults.push('foreground wait deadline elapsed while Extension Host was down');
    return {
      assertions,
      faults,
      metrics: {
        firstReconciled: first.reconciled,
        parallelToolModelResults: parallel.length,
        cancelledArtifacts: 1
      }
    };
  });
}

async function checkRecoveryInterruptedSubtree() {
  return withRuntime('recovery-interrupt', async (ctx) => {
    const assertions = [];
    const faults = [];
    const parent = await seedParent(ctx, 'recovery-interrupt');
    const child = await spawnStartedChild(ctx, parent.turnId, 'recovery-interrupt', 'background');
    const terminalPointerChild = await spawnStartedChild(
      ctx,
      parent.turnId,
      'recovery-terminal-active-pointer',
      'background'
    );
    await createTurnControl(ctx, 'recovery-terminal-active-pointer').terminal({
      source: { kind: 'callback', key: 'recovery-terminal-active-pointer:terminal' },
      turnId: terminalPointerChild.childTurnId,
      terminalStatus: 'completed',
      reason: 'fixture simulates Host loss before observeTurnTerminal'
    });
    assert.equal((await list(ctx.database, 'ChildExecutionActiveTurnLink', {
      child_execution_id: terminalPointerChild.childExecutionId
    })).length, 1);
    const recoveryContinuationTool = await createRunAgentTool(ctx, parent.turnId, 'recovery-interrupt-pending-intent');
    const pending = await ctx.services.children.send({
      sourceKey: 'recovery-interrupt-pending-intent',
      sourceToolCallId: recoveryContinuationTool.toolCallId,
      childExecutionId: child.childExecutionId,
      mode: 'queue_next_turn',
      content: 'pending continuation',
      completionPolicy: 'wait_for_answer',
      waitDeadlineAt: '2026-08-02T00:00:00.000Z'
    });
    const effectsBefore = (await list(ctx.database, 'EffectIntent', {})).length;
    const originalTransaction = ctx.database.transaction.bind(ctx.database);
    let interruptionCommitted = false;
    let settlementFaultInjected = false;
    ctx.database.transaction = async (steps) => {
      if (
        interruptionCommitted
        && !settlementFaultInjected
        && steps.some((step) => step.kind === 'insert' && step.domain === 'ToolOutcome')
      ) {
        settlementFaultInjected = true;
        throw new Error('simulated Host loss before interrupted wait settlement');
      }
      const commit = await originalTransaction(steps);
      if (steps.some((step) => step.kind === 'insert' && step.domain === 'ChildInterruptionRequest')) {
        interruptionCommitted = true;
      }
      return commit;
    };
    await assert.rejects(ctx.services.children.interruptSubtree({
      sourceKey: 'recovery-interrupt-before-wait-settlement',
      childExecutionId: child.childExecutionId,
      reason: 'fixture interruption survives Host loss'
    }), /simulated Host loss before interrupted wait settlement/);
    ctx.database.transaction = originalTransaction;
    assert.equal(settlementFaultInjected, true);
    assert.equal((await get(ctx.database, 'ChildExecution', child.childExecutionId)).status, 'interrupting');
    assert.equal((await get(ctx.database, 'ChildExecutionIntentLink', pending.intentLinkId)).state, 'cancelled');
    assert.equal((await list(ctx.database, 'ChildInterruptionRequest', {
      root_child_execution_id: child.childExecutionId
    })).length, 1);
    assert.equal((await list(ctx.database, 'ChildInterruptionLineageLink', {
      child_execution_id: child.childExecutionId
    })).length, 1);
    assert.equal((await list(ctx.database, 'ChildInterruptionTurnLink', {
      child_execution_id: child.childExecutionId
    })).length, 1);
    assert.equal((await list(ctx.database, 'ChildInterruptionIntentLink', {
      child_execution_id: child.childExecutionId
    })).length, 1);
    assert.equal((await list(ctx.database, 'ToolModelResult', {
      tool_call_id: recoveryContinuationTool.toolCallId
    })).length, 0);
    await closeRuntime(ctx);
    await reopenRuntime(ctx, 'recovery-cancel-restart');
    const all = await ctx.services.recovery.runAll();
    const first = all.find((result) => result.id === kernel.PHASE_F_RECOVERY_INTERRUPTED_SUBTREE_INCOMPLETE);
    assert.ok(first);
    const second = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_INTERRUPTED_SUBTREE_INCOMPLETE);
    assert.equal(first.reconciled, 1);
    assert.equal((await list(ctx.database, 'ChildExecutionActiveTurnLink', {
      child_execution_id: terminalPointerChild.childExecutionId
    })).length, 0);
    assert.equal((await get(ctx.database, 'ChildExecution', terminalPointerChild.childExecutionId)).status, 'idle');
    assert.equal((await get(ctx.database, 'ChildExecution', child.childExecutionId)).status, 'interrupting');
    assert.equal((await get(ctx.database, 'ChildExecutionIntentLink', pending.intentLinkId)).state, 'cancelled');
    assert.equal((await list(ctx.database, 'PendingTurnInput', {
      turn_id: child.childTurnId,
      input_kind: 'termination_request'
    })).length, 1);
    assert.equal((await list(ctx.database, 'EffectIntent', {})).length, effectsBefore);
    assert.equal((await list(ctx.database, 'ToolModelResult', {
      tool_call_id: recoveryContinuationTool.toolCallId
    })).length, 1);
    assert.equal(
      (await ctx.services.effects.readTerminalResult(recoveryContinuationTool.toolCallId, false)).status,
      'cancelled'
    );
    assert.equal(second.reconciled, 0);
    assert.equal((await list(ctx.database, 'PendingTurnInput', {
      turn_id: child.childTurnId,
      input_kind: 'termination_request'
    })).length, 1);
    assertions.push('interrupt_subtree将Request及lineage/turn/intent目标、终止输入和Intent取消原子提交，Host在父等待结算前退出时恢复扫描只补齐缺失ToolOutcome');
    assertions.push('子Turn已终止但Host丢失observe回调时，runAll按持久终态清除ActiveTurnLink并恢复idle');
    assertions.push('重复扫描不重复Interruption目标、termination input或ToolOutcome，不派发外部effect；active中断Turn仍等待正常终止回执');
    faults.push('interruption transaction committed before parent wait settlement', 'child Turn terminal committed before active pointer cleanup');
    return { assertions, faults, metrics: { firstReconciled: first.reconciled, secondScanned: second.scanned } };
  });
}

async function checkParentHandlingMatrix() {
  const pureCases = [
    [{ state: 'pending', phase: 'current_turn', inputLink: null }, 'unhandled'],
    [{ state: 'failed', phase: 'next_turn', inputLink: null }, 'unhandled'],
    [{ state: 'consumed', phase: 'notify_only', inputLink: null }, 'not_applicable'],
    [{ state: 'consumed', phase: 'current_turn', inputLink: { handled_at: null } }, 'unhandled'],
    [{ state: 'consumed', phase: 'next_turn', inputLink: { handled_at: NOW } }, 'handled']
  ];
  for (const [input, expected] of pureCases) assert.equal(kernel.deriveParentHandlingState(input), expected);
  assert.throws(() => kernel.deriveParentHandlingState({
    state: 'consumed', phase: 'current_turn', inputLink: null
  }), /invalid phase\/InputLink/);

  return withRuntime('parent-handling', async (ctx) => {
    const assertions = ['parentHandling完整precedence矩阵逐组合由Repository函数验证，非法consumed current/next无InputLink被拒绝'];
    const faults = [];
    const parent = await seedParent(ctx, 'parent-handling');
    const child = await spawnStartedChild(ctx, parent.turnId, 'parent-handling', 'background');
    const answer = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'parent-handling-answer',
      sourceTurnId: child.childTurnId,
      content: 'answer'
    });
    const pending = await ctx.services.deliveries.create({
      inboxItemId: answer.inboxItemId,
      targetConversationId: parent.conversationId,
      targetTurnId: parent.turnId,
      phase: 'current_turn'
    });
    assert.equal(pending.parentHandlingState, 'unhandled');
    const consumed = await ctx.services.deliveries.advance(pending.delivery.id);
    assert.equal(consumed.parentHandlingState, 'unhandled');
    const unrelatedContent = await ctx.store.ingest(ctx.database, 'unrelated', 'text/plain');
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
        id: 'matrix-unrelated-input', turn_id: parent.turnId, input_kind: 'other',
        content_object_id: unrelatedContent.id, state: 'consumed', created_at: NOW, updated_at: NOW
      })
    ]);
    assert.equal((await ctx.services.deliveries.summary(pending.delivery.id)).parentHandlingState, 'unhandled');
    const handled = await ctx.services.deliveries.markInputHandled(consumed.inputLink.pending_turn_input_id);
    assert.equal(handled.parentHandlingState, 'handled');

    const notifyAnswer = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'parent-handling-notify-answer',
      sourceTurnId: child.childTurnId,
      content: 'notification'
    });
    const notify = await ctx.services.deliveries.create({
      inboxItemId: notifyAnswer.inboxItemId,
      targetConversationId: parent.conversationId,
      phase: 'notify_only'
    });
    const acknowledged = await ctx.services.deliveries.acknowledgeNotification(notify.delivery.id);
    assert.equal(acknowledged.parentHandlingState, 'not_applicable');
    const failed = await ctx.services.deliveries.create({
      inboxItemId: answer.inboxItemId,
      targetConversationId: 'matrix-gone-target',
      phase: 'notify_only'
    });
    assert.equal(failed.parentHandlingState, 'unhandled');
    assertions.push('真实SQLite delivery覆盖pending/failed、notify consumed、current consumed未处理/已处理，且无关input不影响结果');

    const extraAnswer = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'parent-handling-extra-answer',
      sourceTurnId: child.childTurnId,
      content: 'extra notification'
    });
    const deliveryChanges = [];
    const unsubscribe = ctx.database.onCommit((commit) => deliveryChanges.push(...commit.changes.filter((change) => change.domain === 'RuntimeDelivery')));
    const extraNotify = await ctx.services.deliveries.create({
      inboxItemId: extraAnswer.inboxItemId,
      targetConversationId: parent.conversationId,
      phase: 'notify_only'
    });
    await ctx.services.deliveries.acknowledgeNotification(extraNotify.delivery.id);
    unsubscribe();
    const projected = deliveryChanges.findLast((change) => change.id === extraNotify.delivery.id)?.record;
    assert.equal(projected.parent_handling_state, 'not_applicable');
    assertions.push('前端只读取commit/Repository物化的parent_handling_state，不在Webview自行推导');
    faults.push('unrelated PendingTurnInput consumed before exact delivery input');
    return { assertions, faults, metrics: { matrixCases: pureCases.length + 1, projectedState: projected.parent_handling_state } };
  });
}

async function withRuntime(label, body) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-phase-f-${label}-`));
  const candidate = await kernel.resetCandidateRuntimeRoot(parent);
  const ctx = {
    ...candidate,
    parent,
    database: null,
    store: null,
    services: null,
    now: () => NOW
  };
  try {
    await reopenRuntime(ctx, `phase-f-${label}`);
    return await body(ctx);
  } finally {
    if (ctx.services?.clientFeed) ctx.services.clientFeed.close();
    if (ctx.database) await ctx.database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function reopenRuntime(ctx, hostBootId, now = ctx.now) {
  if (ctx.database) throw new Error('Runtime database must be closed before reopen.');
  ctx.now = now;
  ctx.database = await kernel.RuntimeDatabase.open(ctx.authority, { hostBootId });
  ctx.store = new kernel.ContentAddressedStore(ctx.authority, ctx.binding);
  ctx.services = kernel.createReliableKernelRuntimeServices(ctx.database, ctx.store, {
    now,
    authorityCompiler: phaseFAuthorityCompiler('runtime-services')
  });
}

async function closeRuntime(ctx) {
  ctx.services?.clientFeed.close();
  if (ctx.database) await ctx.database.close();
  ctx.database = null;
  ctx.store = null;
  ctx.services = null;
}

async function seedParent(ctx, suffix) {
  const conversationId = `conversation-${suffix}`;
  const agentId = `agent-${suffix}`;
  await ctx.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId, title: conversationId, status: 'active', created_at: NOW, updated_at: NOW
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `agent-link-${suffix}`, conversation_id: conversationId, agent_id: agentId,
      role: 'default', created_at: NOW, updated_at: NOW
    })
  ]);
  const control = createTurnControl(ctx, suffix);
  const started = await control.input({
    source: { kind: 'command', key: `input-${suffix}` },
    conversationId,
    leaseOwnerId: `executor-${suffix}`,
    hostBootId: ctx.database.hostBootId,
    leaseExpiresAt: '2026-08-02T00:00:00.000Z',
    content: `user-input-${suffix}`
  });
  return {
    conversationId,
    agentId,
    turnId: started.turnId,
    messageId: started.messageId,
    messageRevisionId: started.messageRevisionId,
    control
  };
}

function createTurnControl(ctx, suffix) {
  return new kernel.TurnControlPlane(ctx.database, ctx.store, {
    authorityCompiler: phaseFAuthorityCompiler(suffix),
    now: ctx.now
  });
}

function phaseFAuthorityCompiler(suffix) {
  return {
    async compile(request) {
      return {
        turnId: request.turnId,
        executorAgentId: request.executorAgentId,
        executionPreset: {
          content: JSON.stringify({ providerConfigId: 'fake-local', modelId: 'fake-model', suffix })
        },
        authoritySnapshot: {
          content: JSON.stringify({
            turnId: request.turnId,
            executorAgentId: request.executorAgentId,
            suffix,
            modelProfile: {
              compressionThresholdTokens: 100_000,
              contextWindowTokens: 200_000,
              tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
            },
            model: {
              providerConfigId: 'fake-local',
              provider: 'openai-compatible',
              modelId: 'fake-model'
            }
          })
        }
      };
    }
  };
}

async function createRunAgentTool(ctx, turnId, suffix) {
  return ctx.services.effects.createToolCall({
    source: { kind: 'callback', key: `run-agent-tool-${suffix}` },
    toolCallId: `run-agent-call-${suffix}`,
    turnId,
    toolName: 'run_agent',
    arguments: { prompt: suffix }
  });
}

async function spawnStartedChild(ctx, parentTurnId, suffix, completionPolicy, options = {}) {
  const tool = await createRunAgentTool(ctx, parentTurnId, suffix);
  const spawned = await ctx.services.children.spawn({
    sourceToolCallId: tool.toolCallId,
    childAgentId: `child-agent-${suffix}`,
    modelFallback: CHILD_MODEL_FALLBACK,
    sourceSettlement: 'child_handle',
    prompt: `child prompt ${suffix}`,
    completionPolicy,
    ...(completionPolicy === 'wait_for_answer'
      ? { waitDeadlineAt: options.deadline ?? '2026-08-01T01:00:00.000Z' }
      : {}),
    leaseOwnerId: options.leaseOwnerId ?? `child-owner-${suffix}`,
    leaseExpiresAt: '2026-08-02T00:00:00.000Z'
  });
  assert.equal(await ctx.services.children.claimSpawnDispatch(spawned.effectIntentId), true);
  const receipt = await ctx.services.children.recordSpawnReceipt({
    sourceKey: `spawn-callback-${suffix}`,
    attemptId: spawned.attemptId,
    outcome: 'succeeded',
    detail: { adapter: 'fake-capability-boundary' }
  });
  await ctx.services.children.reconcileSpawnReceipt(receipt.effectReceiptId);
  return { ...spawned, toolCallId: tool.toolCallId };
}

async function seedMessageRows(ctx, conversationId, count, startSeq, suffix) {
  if (count <= 0) return;
  const content = await ctx.store.ingest(ctx.database, `shared-${suffix}`, 'text/plain');
  const batchSize = 500;
  for (let batchStart = 0; batchStart < count; batchStart += batchSize) {
    const steps = [];
    const batchEnd = Math.min(count, batchStart + batchSize);
    for (let index = batchStart; index < batchEnd; index += 1) {
      const seq = startSeq + index;
      const id = `message-${suffix}-${String(seq).padStart(6, '0')}`;
      const revisionId = `revision-${suffix}-${String(seq).padStart(6, '0')}`;
      steps.push(
        kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
          id, created_at: NOW, updated_at: NOW, deleted_at: null
        }),
        kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
          id: revisionId, message_id: id, revision_seq: 1n, role: seq % 2 ? 'user' : 'model',
          content_object_id: content.id, created_at: NOW
        }),
        kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
          id: `current-${suffix}-${String(seq).padStart(6, '0')}`,
          message_id: id, revision_id: revisionId, updated_at: NOW
        }),
        kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insert({
          id: `membership-${suffix}-${String(seq).padStart(6, '0')}`,
          conversation_id: conversationId, message_id: id, message_seq: BigInt(seq), created_at: NOW
        })
      );
    }
    await ctx.database.transaction(steps);
  }
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

async function list(database, domain, where = {}) {
  const barrier = await database.snapshot([
    kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, limit: 1000 })
  ]);
  return barrier.snapshot[0];
}

async function listAll(database, domain, where = {}) {
  const barrier = await database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1000
  }));
  return barrier.snapshot;
}

async function get(database, domain, id) {
  const row = await maybeGet(database, domain, id);
  assert.ok(row, `${domain} ${id} should exist`);
  return row;
}

async function maybeGet(database, domain, id) {
  const barrier = await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain(domain).get(id)]);
  return barrier.snapshot[0];
}

function acknowledge(feed, connection, message) {
  feed.acknowledge({
    sessionId: connection.sessionId,
    hostBootId: connection.hostBootId,
    messageSeq: message.messageSeq
  });
}

function wireBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function emptyClientProjection(conversationId) {
  return {
    navigationSummary: { conversations: [] },
    activeConversationWindow: {
      conversationId, messages: [], visibleMessageCount: '0', lastMessageSeq: '0',
      projectContexts: [], conversationProjectLinks: [], conversationReuseLinks: [],
      conversationBranchLinks: [], conversationOriginLinks: [], agentConversationLinks: [],
      commandReceipts: [], queuedTurnIntents: [], compressionBlocks: [], conversationContextStatuses: [],
      taskList: [], currentTaskList: null
    },
    activeTurnSummary: {
      turns: [], executionLeases: [], turnTerminations: [], turnExecutorLinks: [],
      modelRequests: [], modelContextProjections: [], modelRequestMessageLinks: []
    },
    activeToolAndInteractionSummary: {
      messageTurnLinks: [], toolCalls: [], toolCallSourceLinks: [], toolCallPolicySnapshots: [],
      toolCallEvents: [], toolExecutions: [], toolOutcomes: [], toolModelResults: [],
      toolResultArtifacts: [], interactionRequests: [], interactionOwnerLinks: [],
      interactionToolCallLinks: [], interactionResponses: [], fileChangeSets: [],
      fileChangeSetMembers: [], fileChangeDecisions: [], fileMutationReceipts: [],
      fileMutationReceiptMembers: [], processes: [], processOriginLinks: [], processOutputChunks: [],
      processReceipts: []
    },
    subagentDeliverySummary: {
      childExecutions: [], childExecutionParentLinks: [], childExecutionTurnLinks: [],
      childExecutionActiveTurnLinks: [], childExecutionActivities: [], childTurns: [], childExecutionLeases: [],
      childTurnTerminations: [], childTurnExecutorLinks: [], answerBridges: [],
      answerSubmissions: [], runtimeInboxItems: [], runtimeDeliveries: [], runtimeDeliveryIntentLinks: [],
      collaborationMessages: [], collaborationMessageSourceLinks: [], collaborationMessageTargetLinks: [],
      collaborationMessageReplyLinks: [], collaborationRequests: [], collaborationRequestTurnLinks: [],
      collaborationPeerConversations: []
    }
  };
}

function assertCausalSnapshotBundles(projections) {
  const window = projections.activeConversationWindow;
  const turns = projections.activeTurnSummary;
  const tools = projections.activeToolAndInteractionSummary;
  const messageIds = new Set(window.messages.map((row) => row.id));
  const turnIds = new Set(turns.turns.map((row) => row.id));
  const requestIds = new Set(turns.modelRequests.map((row) => row.id));
  const toolCallIds = new Set(tools.toolCalls.map((row) => row.id));
  const processIds = new Set(tools.processes.map((row) => row.id));
  const requestLinkIds = new Set();
  for (const link of turns.modelRequestMessageLinks) {
    assert.ok(requestIds.has(link.model_request_id));
    assert.ok(messageIds.has(link.message_id));
    requestLinkIds.add(link.model_request_id);
  }
  for (const requestId of requestIds) assert.ok(requestLinkIds.has(requestId));
  const messageTurnIds = new Set();
  for (const link of tools.messageTurnLinks) {
    assert.ok(messageIds.has(link.message_id));
    assert.ok(turnIds.has(link.turn_id));
    messageTurnIds.add(link.message_id);
  }
  for (const messageId of messageIds) assert.ok(messageTurnIds.has(messageId));
  const sourceToolIds = new Set();
  for (const link of tools.toolCallSourceLinks) {
    assert.ok(toolCallIds.has(link.tool_call_id));
    assert.ok(requestIds.has(link.model_request_id));
    assert.ok(messageIds.has(link.message_id));
    sourceToolIds.add(link.tool_call_id);
  }
  for (const toolCallId of toolCallIds) assert.ok(sourceToolIds.has(toolCallId));
  const originProcessIds = new Set();
  for (const link of tools.processOriginLinks) {
    assert.ok(processIds.has(link.process_id));
    assert.ok(toolCallIds.has(link.tool_call_id));
    originProcessIds.add(link.process_id);
  }
  for (const processId of processIds) assert.ok(originProcessIds.has(processId));
}

function maxArrayLength(value) {
  if (Array.isArray(value)) return Math.max(value.length, ...value.map(maxArrayLength), 0);
  if (!value || typeof value !== 'object') return 0;
  return Math.max(0, ...Object.values(value).map(maxArrayLength));
}

function maxRecordBytes(value) {
  let maximum = 0;
  const visit = (nested) => {
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) maximum = Math.max(maximum, wireBytes(entry));
        visit(entry);
      }
    } else if (nested && typeof nested === 'object') {
      for (const entry of Object.values(nested)) visit(entry);
    }
  };
  visit(value);
  return maximum;
}

async function casFileCount(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await casFileCount(absolute);
    else if (entry.isFile()) total += 1;
  }
  return total;
}

function mutateSqlite(databasePath, mutation) {
  const database = new Database(databasePath, { fileMustExist: true });
  database.defaultSafeIntegers(true);
  database.pragma('foreign_keys = ON');
  try {
    database.exec('BEGIN IMMEDIATE');
    mutation(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

function emittedRequireClosure(entryPath) {
  const visited = new Set();
  const visit = (file) => {
    const absolute = path.resolve(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = fsSync.readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      if (!match[1].startsWith('.')) continue;
      const candidate = path.resolve(path.dirname(absolute), match[1]);
      const resolved = fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()
        ? candidate
        : fsSync.existsSync(`${candidate}.js`)
          ? `${candidate}.js`
          : fsSync.existsSync(path.join(candidate, 'index.js'))
            ? path.join(candidate, 'index.js')
            : null;
      if (resolved) visit(resolved);
    }
  };
  visit(entryPath);
  return visited;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} did not complete within ${timeoutMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writeEvidence(stableId, evidence, commitSha) {
  const fileName = `${stableId.replaceAll('.', '-')}.json`;
  const evidencePath = path.join(root, 'tests/reliable-kernel/evidence', fileName);
  const runnerPath = path.join(root, 'scripts/reliable-kernel/run-phase-f-check.mjs');
  const compileProvenancePath = path.join(root, RELIABLE_KERNEL_COMPILE_PROVENANCE);
  const worktreeStatus = childProcess.execFileSync(
    'git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }
  ).trim();
  const compileProvenance = JSON.parse(await fs.readFile(compileProvenancePath, 'utf8'));
  const sourceManifest = reliableKernelSourceManifest(root);
  const compiledManifest = reliableKernelCompiledManifest(root);
  const sourceFilesTracked = manifestFilesAreTracked(root, sourceManifest);
  const compiledClosureMatches = compileProvenance.kind === 'limcode-reliable-kernel-compile-provenance'
    && compileProvenance.commitSha === commitSha
    && compileProvenance.sourceFilesTracked === true
    && compileProvenance.sourceTreeSha256 === sourceManifest.sha256
    && compileProvenance.compiledClosureSha256 === compiledManifest.sha256;
  const sqlite = new Database(':memory:');
  let sqliteVersion;
  try {
    sqliteVersion = sqlite.prepare('SELECT sqlite_version() AS version').get().version;
  } finally {
    sqlite.close();
  }
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify({
    kind: 'limcode-phase-f-candidate-evidence',
    checkId: stableId,
    stableId,
    passed: true,
    commitSha,
    measuredAt: new Date().toISOString(),
    assertionCount: evidence.assertions.length,
    provenance: {
      worktreeClean: worktreeStatus.length === 0,
      commitExplicitlyBound: requestedCommit === commitSha,
      authoritative: worktreeStatus.length === 0
        && requestedCommit === commitSha
        && sourceFilesTracked
        && compileProvenance.worktreeClean === true
        && compiledClosureMatches,
      runnerSha256: await fileSha256(runnerPath),
      sourceTreeSha256: sourceManifest.sha256,
      sourceFileCount: sourceManifest.files.length,
      sourceFilesTracked,
      compiledKernelSha256: compiledManifest.sha256,
      compiledFileCount: compiledManifest.files.length,
      compileProvenance: path.relative(root, compileProvenancePath),
      compileWorktreeClean: compileProvenance.worktreeClean === true,
      compiledClosureMatches,
      invocation: [process.execPath, ...process.argv.slice(1)],
      node: process.version,
      sqlite: sqliteVersion,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? 'unknown'
    },
    ...evidence
  }, bigintJson, 2)}\n`);
  return evidencePath;
}

async function fileSha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function bigintJson(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
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
