import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import {
  RELIABLE_KERNEL_COMPILE_PROVENANCE,
  manifestFilesAreTracked,
  reliableKernelCompiledManifest,
  reliableKernelSourceManifest
} from './lib/compile-provenance.mjs';

const root = process.cwd();
const checkId = option('check');
const phaseEChecks = new Set([
  'candidate.context-storage-growth',
  'candidate.context-compression-node-bound',
  'candidate.provider-continuation-disabled-full-request',
  'candidate.compression-immutable-replacement'
]);
if (!checkId || !phaseEChecks.has(checkId)) {
  console.error('用法：node scripts/reliable-kernel/run-phase-e-check.mjs --check=<Phase-E-stable-id> [--commit=<sha>]');
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
let modelCapabilities;
let Database;
try {
  kernel = require(path.join(root, 'dist/extension/backend/reliableKernel/index.js'));
  modelCapabilities = require(path.join(root, 'dist/extension/shared/modelCapabilities.js'));
  Database = require('better-sqlite3');
} catch (error) {
  console.error(`无法加载已编译Phase E内核；请先运行npm run compile：${error.message}`);
  process.exit(1);
}

const handlers = new Map([
  ['candidate.context-storage-growth', checkContextStorageGrowth],
  ['candidate.context-compression-node-bound', checkCompressionNodeBound],
  ['candidate.provider-continuation-disabled-full-request', checkProviderFullRequest],
  ['candidate.compression-immutable-replacement', checkImmutableReplacement]
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

async function checkContextStorageGrowth() {
  const assertions = [];
  const faults = [];
  const metrics = {};
  const nodeSchema = kernel.RUNTIME_DOMAIN_SCHEMAS.find((entry) => entry.key === 'ContextSequenceNode');
  const rootSchema = kernel.RUNTIME_DOMAIN_SCHEMAS.find((entry) => entry.key === 'ContextSequenceRoot');
  assert.deepEqual([...nodeSchema.indexes], [
    'parent_node_id',
    'parent_node_id,segment_id UNIQUE',
    'segment_id UNIQUE WHERE parent_node_id IS NULL'
  ]);
  assert.deepEqual([...rootSchema.indexes], ['conversation_id,root_seq UNIQUE', 'root_node_id']);
  assert.ok(!nodeSchema.indexes.includes('parent_node_id UNIQUE'));
  assert.ok(!rootSchema.indexes.includes('root_node_id UNIQUE'));

  await withRuntime('context-races', async (ctx) => {
    const seeded = await seedTurn(ctx, 'race');
    const context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    const casBeforeInvalidAppend = await casFileCount(ctx.binding.paths.casRootPath);
    await assert.rejects(context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'invalid-revision', sourceRevision: '7' },
      content: 'MUST-NOT-PUBLISH-INVALID-REVISION',
      contentType: 'text/plain'
    }), /source_revision must be 0/);
    await assert.rejects(context.appendContent({
      conversationId: 'missing-conversation-before-cas',
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'missing-conversation', sourceRevision: '0' },
      content: 'MUST-NOT-PUBLISH-MISSING-CONVERSATION',
      contentType: 'text/plain'
    }), /does not exist/);
    assert.equal(await casFileCount(ctx.binding.paths.casRootPath), casBeforeInvalidAppend);
    const beforeSource = await count(ctx.database, 'ContextSegmentSource', {
      source_kind: 'runtime_context', source_id: 'same-source', source_revision: 0n
    });
    const baseRootId = await context.currentHeadRootId(seeded.conversationId);
    const sameCommand = {
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'same-source', sourceRevision: '0' },
      content: 'stable concurrent occurrence',
      contentType: 'text/plain',
      baseRootId,
      expectedHeadRootId: baseRootId,
      activate: true
    };
    let slowPrepareStartedResolve;
    const slowPrepareStarted = new Promise((resolve) => { slowPrepareStartedResolve = resolve; });
    let releaseSlowPrepareResolve;
    const releaseSlowPrepare = new Promise((resolve) => { releaseSlowPrepareResolve = resolve; });
    const slowContext = new kernel.ContextSequenceControlPlane(ctx.database, storeFacade(ctx.store, {
      async prepare(...args) {
        slowPrepareStartedResolve();
        await releaseSlowPrepare;
        return ctx.store.prepare(...args);
      }
    }));
    const slowAppend = slowContext.appendContent(sameCommand);
    await slowPrepareStarted;
    const fastAppend = context.appendContent(sameCommand).then(
      (result) => {
        releaseSlowPrepareResolve();
        return result;
      },
      (error) => {
        releaseSlowPrepareResolve();
        throw error;
      }
    );
    const sameResults = await Promise.all([slowAppend, fastAppend]);
    assert.equal(new Set(sameResults.map((entry) => entry.segmentId)).size, 1);
    assert.equal(new Set(sameResults.map((entry) => entry.rootId)).size, 1);
    assert.equal(await count(ctx.database, 'ContextSegmentSource', {
      source_kind: 'runtime_context', source_id: 'same-source', source_revision: 0n
    }), beforeSource + 1);
    const sequentialReplay = await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'same-source', sourceRevision: '0' },
      content: 'stable concurrent occurrence',
      contentType: 'text/plain'
    });
    assert.equal(sequentialReplay.rootId, sameResults[0].rootId);
    assert.equal(sequentialReplay.deduplicated, true);
    assert.equal((await context.materialize(sequentialReplay.rootId)).segments.filter((entry) =>
      entry.content.toString('utf8') === 'stable concurrent occurrence'
    ).length, 1);
    assertions.push('同一source tuple并发与顺序重放都稳定收敛为一个ContextSegment/Source/root occurrence，不会把同一 occurrence 再挂一次');

    const sharedBody = 'same-body-different-source';
    const contentObjectsBeforeSharedBody = await countAll(ctx.database, 'ContentObject');
    const sharedLeft = await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'shared-body-left', sourceRevision: '0' },
      content: sharedBody,
      contentType: 'text/plain'
    });
    const sharedRight = await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'shared-body-right', sourceRevision: '0' },
      content: sharedBody,
      contentType: 'text/plain'
    });
    assert.notEqual(sharedLeft.segmentId, sharedRight.segmentId);
    const sharedSegments = await Promise.all([
      get(ctx.database, 'ContextSegment', sharedLeft.segmentId),
      get(ctx.database, 'ContextSegment', sharedRight.segmentId)
    ]);
    assert.equal(sharedSegments[0].content_object_id, sharedSegments[1].content_object_id);
    assert.equal(await countAll(ctx.database, 'ContentObject'), contentObjectsBeforeSharedBody + 1);
    assert.equal((await context.materialize(sharedRight.rootId)).segments.filter((entry) =>
      entry.content.toString('utf8') === sharedBody
    ).length, 2);
    assertions.push('相同正文不同来源只共享一个ContentObject，但产生两个ContextSegment/source occurrence并在物化中出现两次');

    const branchBase = sharedRight.rootId;
    const [left, right] = await Promise.all([
      context.appendContent({
        conversationId: seeded.conversationId,
        segmentKind: 'runtime_context',
        source: { sourceKind: 'runtime_context', sourceId: 'branch-left', sourceRevision: '0' },
        content: 'left', contentType: 'text/plain', baseRootId: branchBase, activate: false
      }),
      context.appendContent({
        conversationId: seeded.conversationId,
        segmentKind: 'runtime_context',
        source: { sourceKind: 'runtime_context', sourceId: 'branch-right', sourceRevision: '0' },
        content: 'right', contentType: 'text/plain', baseRootId: branchBase, activate: false
      })
    ]);
    assert.notEqual(left.nodeId, right.nodeId);
    assert.notEqual(left.rootId, right.rootId);
    assert.notEqual(left.rootSeq, right.rootSeq);
    const branchNodes = await Promise.all([
      get(ctx.database, 'ContextSequenceNode', left.nodeId),
      get(ctx.database, 'ContextSequenceNode', right.nodeId)
    ]);
    assert.equal(branchNodes[0].parent_node_id, branchNodes[1].parent_node_id);
    const activatedLeft = await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'branch-left', sourceRevision: '0' },
      content: 'left',
      contentType: 'text/plain',
      baseRootId: branchBase,
      expectedHeadRootId: branchBase,
      activate: true
    });
    assert.equal(activatedLeft.rootId, left.rootId);
    assert.equal(activatedLeft.deduplicated, true);
    assert.equal(await context.currentHeadRootId(seeded.conversationId), left.rootId);
    assertions.push('同一parent并发不同后继均成功，root_seq不重复且parent本身不唯一；已存在inactive branch可通过一次head CAS激活，不递归重插root');

    const suffixSeed = await seedTurn(ctx, 'shared-suffix-node');
    const suffixC = await context.appendContent({
      conversationId: suffixSeed.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'shared-suffix-c', sourceRevision: '0' },
      content: 'SHARED-SUFFIX-C', contentType: 'text/plain'
    });
    await context.appendContent({
      conversationId: suffixSeed.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'shared-suffix-d', sourceRevision: '0' },
      content: 'SHARED-SUFFIX-D', contentType: 'text/plain'
    });
    const preSharedNodeId = stableContextId('context_node', '<null>', suffixC.segmentId);
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ContextSequenceNode').insert({
        id: preSharedNodeId,
        parent_node_id: null,
        segment_id: suffixC.segmentId,
        created_at: new Date().toISOString()
      })
    ]);
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ContextSequenceNode').insert({
        id: `${preSharedNodeId}-duplicate-null-parent`,
        parent_node_id: null,
        segment_id: suffixC.segmentId,
        created_at: new Date().toISOString()
      })
    ]), /UNIQUE constraint failed/);
    await terminateSeededTurn(suffixSeed, 'shared-suffix-history-mutation');
    await suffixSeed.control.delete({
      source: { kind: 'command', key: 'delete-message-with-partially-shared-suffix' },
      conversationId: suffixSeed.conversationId,
      messageId: suffixSeed.messageId
    });
    assert.deepEqual((await context.materialize(
      await context.currentHeadRootId(suffixSeed.conversationId)
    )).segments.map((segment) => segment.content.toString('utf8')), []);
    assertions.push('NULL parent的segment_id partial UNIQUE真实阻止重复根节点；删除历史消息按结构截断其完整suffix，后续runtime segment不会残留在可物化上下文');

    const headBeforeFault = await context.currentHeadRootId(seeded.conversationId);
    const rootCountBeforeFault = await countAll(ctx.database, 'ContextSequenceRoot');
    const contentCountBeforeFault = await countAll(ctx.database, 'ContentObject');
    const faultBody = 'fault-root-head-atomicity-body';
    const faultContentIdentity = ctx.store.identity(faultBody, 'text/plain');
    const liveDatabase = ctx.database;
    let actualAppendFaultInjected = false;
    const faultDatabase = databaseFacade(liveDatabase, {
      transaction: (steps) => {
        const hasRoot = steps.some((step) => step.kind === 'insert' && step.domain === 'ContextSequenceRoot');
        const hasHead = steps.some((step) => step.kind === 'update' && step.domain === 'ConversationContextHeadLink');
        if (actualAppendFaultInjected || !hasRoot || !hasHead) return liveDatabase.transaction(steps);
        actualAppendFaultInjected = true;
        return liveDatabase.transaction([
          ...steps,
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').assert(seeded.conversationId, {
            status: 'forced-rollback-after-real-append'
          })
        ]);
      }
    });
    const faultContext = new kernel.ContextSequenceControlPlane(faultDatabase, ctx.store);
    await assert.rejects(faultContext.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'fault-real-append', sourceRevision: '0' },
      content: faultBody,
      contentType: 'text/plain'
    }), /assertion failed/);
    assert.equal(actualAppendFaultInjected, true);
    assert.equal(await countAll(ctx.database, 'ContextSequenceRoot'), rootCountBeforeFault);
    assert.equal(await countAll(ctx.database, 'ContentObject'), contentCountBeforeFault);
    assert.equal(await maybeGet(ctx.database, 'ContentObject', faultContentIdentity.id), null);
    assert.equal(await count(ctx.database, 'ContextSegmentSource', {
      source_kind: 'runtime_context', source_id: 'fault-real-append', source_revision: 0n
    }), 0);
    assert.equal(await context.currentHeadRootId(seeded.conversationId), headBeforeFault);
    assertions.push('真实append路径的segment/source/node/root/head位于同一SQLite writer事务，root+head之后故障不会留下半提交；仅允许raw CAS orphan');
    faults.push('real append after root+head before SQLite commit rollback');
  });

  const storageMetrics = await withRuntime('context-storage', async (ctx) => {
    const seeded = await seedTurn(ctx, 'storage');
    const rounds = 12;
    const contentBytes = 512 * 1024;
    const domains = ['ContentObject', 'ContextSegment', 'ContextSegmentSource', 'ContextSequenceNode', 'ContextSequenceRoot'];
    const baseCounts = Object.fromEntries(await Promise.all(domains.map(async (domain) => [domain, await countAll(ctx.database, domain)])));
    const headCount = await countAll(ctx.database, 'ConversationContextHeadLink');
    await closeAndCheckpoint(ctx);
    let previousBytes = await persistentBytes(ctx.binding);
    const growth = [];
    for (let round = 0; round < rounds; round += 1) {
      await reopen(ctx, `phase-e-storage-${round}`);
      const context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
      const bytes = deterministicBytes(`storage-round-${round}`, contentBytes);
      const beforeTransactionBytes = await persistentBytes(ctx.binding);
      await context.appendContent({
        conversationId: seeded.conversationId,
        segmentKind: 'runtime_context',
        source: { sourceKind: 'runtime_context', sourceId: `storage-${round}`, sourceRevision: '0' },
        content: bytes,
        contentType: 'application/octet-stream'
      });
      const afterTransactionBytes = await persistentBytes(ctx.binding);
      const transactionIncrement = afterTransactionBytes - beforeTransactionBytes;
      const limit = Math.floor(1.5 * contentBytes + 128 * 1024);
      assert.ok(transactionIncrement <= limit, `round ${round} DB+WAL+CAS write ${transactionIncrement} bytes > ${limit}`);
      assert.ok(transactionIncrement >= contentBytes, `round ${round} did not write the real content bytes`);
      for (const domain of domains) {
        assert.equal(await countAll(ctx.database, domain), baseCounts[domain] + round + 1, `${domain} linear row growth`);
      }
      assert.equal(await countAll(ctx.database, 'ConversationContextHeadLink'), headCount);
      await closeAndCheckpoint(ctx);
      const currentBytes = await persistentBytes(ctx.binding);
      const increment = currentBytes - previousBytes;
      assert.ok(increment <= limit, `round ${round} retained ${increment} bytes > ${limit}`);
      assert.ok(increment >= contentBytes, `round ${round} did not retain the real content bytes`);
      growth.push({
        round,
        transactionIncrement,
        retainedIncrement: increment,
        contentBytes,
        limit,
        totalBytes: currentBytes
      });
      previousBytes = currentBytes;
    }
    await reopen(ctx, 'phase-e-storage-final');
    return { rounds, contentBytes, growth };
  });
  metrics.storage = storageMetrics;
  assertions.push('12轮独立512KiB确定性正文使用真实SQLite+CAS，同时量化checkpoint前DB+WAL+CAS写入和checkpoint后retained增长，均≤1.5×正文+128KiB且五类行数严格线性');

  const performanceMetrics = await withRuntime('context-performance', async (ctx) => {
    const seeded = await seedTurn(ctx, 'performance');
    const context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    const appendOne = async (index) => context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: `perf-${index}`, sourceRevision: '0' },
      content: `perf-content-${index.toString().padStart(6, '0')}-${'x'.repeat(96)}`,
      contentType: 'text/plain'
    });
    for (let index = 0; index < 200; index += 1) await appendOne(index);
    let forbiddenHistoryReads = 0;
    let ordinarySnapshotAllCalls = 0;
    const ordinaryReads = [];
    const originalSnapshot = ctx.database.snapshot.bind(ctx.database);
    const originalSnapshotAll = ctx.database.snapshotAll.bind(ctx.database);
    const originalMaterialize = ctx.database.materializeContext.bind(ctx.database);
    const originalMaterializeContent = ctx.database.materializeContextContent.bind(ctx.database);
    const originalRead = ctx.store.read.bind(ctx.store);
    const originalReadMany = ctx.store.readMany.bind(ctx.store);
    ctx.database.snapshot = async (reads) => {
      ordinaryReads.push(...reads);
      return originalSnapshot(reads);
    };
    ctx.database.snapshotAll = async (read) => {
      ordinarySnapshotAllCalls += 1;
      ordinaryReads.push(read);
      return originalSnapshotAll(read);
    };
    ctx.database.materializeContext = async (...args) => { forbiddenHistoryReads += 1; return originalMaterialize(...args); };
    ctx.database.materializeContextContent = async (...args) => { forbiddenHistoryReads += 1; return originalMaterializeContent(...args); };
    ctx.store.read = async (...args) => { forbiddenHistoryReads += 1; return originalRead(...args); };
    ctx.store.readMany = async (...args) => { forbiddenHistoryReads += 1; return originalReadMany(...args); };
    const ordinaryDomains = [
      'ContentObject', 'ContextSegment', 'ContextSegmentSource', 'ContextSequenceNode',
      'ContextSequenceRoot', 'ConversationContextHeadLink'
    ];
    const ordinaryCountsBefore = Object.fromEntries(await Promise.all(
      ordinaryDomains.map(async (domain) => [domain, await countAll(ctx.database, domain)])
    ));
    ordinarySnapshotAllCalls = 0;
    ordinaryReads.length = 0;
    let appendCommit;
    const unsubscribe = ctx.database.onCommit((commit) => { appendCommit = commit; });
    const lower = [];
    const firstLowerStarted = performance.now();
    await appendOne(200);
    lower.push(performance.now() - firstLowerStarted);
    unsubscribe();
    ctx.database.snapshot = originalSnapshot;
    ctx.database.snapshotAll = originalSnapshotAll;
    ctx.database.materializeContext = originalMaterialize;
    ctx.database.materializeContextContent = originalMaterializeContent;
    ctx.store.read = originalRead;
    ctx.store.readMany = originalReadMany;
    assert.equal(forbiddenHistoryReads, 0, 'ordinary append must not materialize/read/hash historical Context content');
    assert.equal(ordinarySnapshotAllCalls, 0, 'ordinary append must not request an unbounded Repository snapshot');
    assert.ok(ordinaryReads.length <= 20, `ordinary append issued ${ordinaryReads.length} Repository reads`);
    for (const read of ordinaryReads) {
      if (read.kind === 'list') assert.equal(read.limit, 1, `ordinary append list ${read.domain} must be identity-bounded`);
    }
    assert.ok(appendCommit, 'ordinary append commit was not observed');
    const appendChangesByDomain = Object.groupBy(appendCommit.changes, (change) => change.domain);
    for (const domain of ordinaryDomains) {
      assert.equal(await countAll(ctx.database, domain), ordinaryCountsBefore[domain] + (domain === 'ConversationContextHeadLink' ? 0 : 1));
    }
    for (const domain of ['ContentObject', 'ContextSegment', 'ContextSequenceRoot']) {
      assert.equal(appendChangesByDomain[domain]?.length, 1, `${domain} ordinary append visible mutation count`);
    }
    assert.equal(
      appendChangesByDomain.ConversationContextStatus?.length,
      1,
      'ordinary append must atomically project exactly one derived current-context status'
    );
    assert.equal(appendCommit.changes.length, 4, 'ordinary append must not rewrite historical client-visible rows');
    for (let index = 201; index < 212; index += 1) {
      const started = performance.now();
      await appendOne(index);
      lower.push(performance.now() - started);
    }
    for (let index = 212; index < 400; index += 1) await appendOne(index);
    const upper = [];
    for (let index = 400; index < 412; index += 1) {
      const started = performance.now();
      await appendOne(index);
      upper.push(performance.now() - started);
    }
    const ratio = median(upper) / median(lower);
    assert.ok(ratio <= 2.5, `ordinary append 2x scale ratio ${ratio}`);
    for (let index = 412; index < 999; index += 1) await appendOne(index);
    const rootId = await context.currentHeadRootId(seeded.conversationId);
    for (let round = 0; round < 5; round += 1) {
      const warm = await context.materialize(rootId);
      assert.equal(warm.segments.length, 1000);
    }
    const contentStoreSource = await fs.readFile(
      path.join(root, 'backend/reliableKernel/contentAddressedStore.ts'),
      'utf8'
    );
    assert.doesNotMatch(contentStoreSource, /readFileSync|from ['"]node:fs['"]|require\(['"]node:fs['"]\)/);
    const structuralSamples = [];
    for (let round = 0; round < 20; round += 1) {
      const started = performance.now();
      const materialized = await context.materializeStructure(rootId);
      structuralSamples.push(performance.now() - started);
      assert.equal(materialized.records.length, 1000);
    }
    const structuralP95 = percentile95(structuralSamples);
    const samples = [];
    // Measure timer coverage across the whole pending batch. Warm worker responses commonly finish
    // inside one 5ms interval; requiring every call to cross a tick would make faster code fail.
    const heartbeatIntervalMs = 5;
    const minimumHeartbeatCoverage = 0.75;
    let heartbeatTicks = 0;
    const heartbeatStartedAt = performance.now();
    const heartbeat = setInterval(() => { heartbeatTicks += 1; }, heartbeatIntervalMs);
    for (let round = 0; round < 40; round += 1) {
      const started = performance.now();
      const materialized = await context.materialize(rootId);
      samples.push(performance.now() - started);
      assert.equal(materialized.segments.length, 1000);
    }
    const heartbeatElapsedMs = performance.now() - heartbeatStartedAt;
    clearInterval(heartbeat);
    const expectedHeartbeatTicks = Math.floor(heartbeatElapsedMs / heartbeatIntervalMs);
    assert.ok(expectedHeartbeatTicks > 0, 'Context materialization heartbeat window was too short to measure');
    const minimumHeartbeatTicks = Math.ceil(expectedHeartbeatTicks * minimumHeartbeatCoverage);
    const heartbeatCoverage = heartbeatTicks / expectedHeartbeatTicks;
    assert.ok(
      heartbeatTicks >= minimumHeartbeatTicks,
      `Extension Host heartbeat coverage ${heartbeatTicks}/${expectedHeartbeatTicks} `
        + `(${(heartbeatCoverage * 100).toFixed(1)}%) was below ${minimumHeartbeatCoverage * 100}% while Context materialization was pending`
    );
    const p95 = percentile95(samples);
    assert.ok(p95 < 50, `1000-node full materialization p95 ${p95}ms (structure p95 ${structuralP95}ms)`);
    const workerDiagnostics = await ctx.database.inspect();
    assert.ok(workerDiagnostics.contextCasCache.entries <= workerDiagnostics.contextCasCache.maxEntries);
    assert.ok(workerDiagnostics.contextCasCache.bytes <= workerDiagnostics.contextCasCache.maxBytes);
    assert.ok(
      workerDiagnostics.contextCasCache.hits >= 40_000,
      `expected warmed Context CAS reuse, got ${workerDiagnostics.contextCasCache.hits} hits`
    );
    assert.ok(
      workerDiagnostics.contextCasCache.misses <= 1_000,
      `expected at most one verified filesystem read per immutable Context object, got ${workerDiagnostics.contextCasCache.misses} misses`
    );
    await closeAndCheckpoint(ctx);
    await reopen(ctx, 'phase-e-performance-long-history-write');
    const longHistoryContext = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    const longHistoryContent = deterministicBytes('long-history-write-amplification', 32 * 1024);
    const longHistoryBytesBefore = await persistentBytes(ctx.binding);
    await longHistoryContext.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'long-history-write-amplification', sourceRevision: '0' },
      content: longHistoryContent,
      contentType: 'application/octet-stream'
    });
    const longHistoryWriteBytes = await persistentBytes(ctx.binding) - longHistoryBytesBefore;
    const longHistoryWriteLimit = Math.floor(1.5 * longHistoryContent.length + 128 * 1024);
    assert.ok(
      longHistoryWriteBytes <= longHistoryWriteLimit,
      `1000-node ordinary append wrote ${longHistoryWriteBytes} bytes > ${longHistoryWriteLimit}`
    );
    return {
      lowerSamplesMs: lower,
      upperSamplesMs: upper,
      lowerMedianMs: median(lower),
      upperMedianMs: median(upper),
      scaleRatio: ratio,
      structuralMaterializationSamplesMs: structuralSamples,
      structuralMaterializationP95Ms: structuralP95,
      materializationSamplesMs: samples,
      materializationP95Ms: p95,
      heartbeatIntervalMs,
      heartbeatElapsedMs,
      heartbeatTicks,
      expectedHeartbeatTicks,
      minimumHeartbeatTicks,
      minimumHeartbeatCoverage,
      heartbeatCoverage,
      contextCasCache: workerDiagnostics.contextCasCache,
      ordinaryAppendHistoricalReads: forbiddenHistoryReads,
      ordinaryAppendRepositoryReads: ordinaryReads.length,
      longHistoryWriteBytes,
      longHistoryWriteLimit
    };
  });
  metrics.performance = performanceMetrics;
  assertions.push(`普通append使用≤20次identity-bounded Repository读取且不物化/哈希历史；2x规模中位耗时比${performanceMetrics.scaleRatio.toFixed(3)}≤2.5；真实1000节点+CAS物化p95=${performanceMetrics.materializationP95Ms.toFixed(3)}ms<50ms，整批等待期间Extension Host heartbeat覆盖率=${(performanceMetrics.heartbeatCoverage * 100).toFixed(1)}%≥${performanceMetrics.minimumHeartbeatCoverage * 100}%；Context CAS缓存保持有界且命中${performanceMetrics.contextCasCache.hits}次；1000节点后的单次DB+WAL+CAS写入仍低于量化上限`);

  return { assertions, faults, metrics };
}

async function checkCompressionNodeBound() {
  return withRuntime('compression-bound', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const seeded = await seedTurn(ctx, 'compression-bound', { thresholdTokens: 2 });
    const context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    const beforeToolDelivery = runtimeDeliveryFixture('before-tool', seeded.turnId, 'before-tool-original');
    await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'before-tool', sourceRevision: '0' },
      content: beforeToolDelivery.content,
      contentType: beforeToolDelivery.contentType
    });
    const pair = await seedToolPair(ctx, seeded, 'pair-bound');
    const pairAppend = await context.appendToolPair({
      conversationId: seeded.conversationId,
      toolCallId: pair.toolCallId,
      toolModelResultId: pair.toolModelResultId
    });
    for (let index = 0; index < 4; index += 1) {
      const tailDelivery = runtimeDeliveryFixture(
        `tail-bound-${index}`,
        seeded.turnId,
        `tail-bound-${index}`
      );
      await context.appendContent({
        conversationId: seeded.conversationId,
        segmentKind: 'runtime_context',
        source: { sourceKind: 'runtime_context', sourceId: `tail-bound-${index}`, sourceRevision: '0' },
        content: tailDelivery.content,
        contentType: tailDelivery.contentType
      });
    }
    const sourceRootId = await context.currentHeadRootId(seeded.conversationId);
    const sourceMaterialized = await context.materialize(sourceRootId);
    assert.equal(sourceMaterialized.segments[2].segmentId, pairAppend.segmentId);
    const pairSources = await list(ctx.database, 'ContextSegmentSource', { segment_id: pairAppend.segmentId });
    assert.deepEqual(pairSources.map((row) => row.source_kind).sort(), ['tool_call', 'tool_model_result']);
    assertions.push('tool call与唯一ToolModelResult形成一个tool_pair segment并登记两条同call_seq source，压缩只能按整个segment选取');

    const rootBefore = await get(ctx.database, 'ContextSequenceRoot', sourceRootId);
    const durableByteEstimate = sourceMaterialized.segments.reduce(
      (sum, segment) => sum + Number((segment.contentObject.byte_length + 3n) / 4n),
      0
    );
    assert.ok(Number(rootBefore.estimated_tokens) > 0);
    const tokenEstimator = new kernel.ReliableContextTokenEstimator(ctx.database, ctx.store);
    const providerAligned = await tokenEstimator.estimateRoot(sourceRootId);
    const compression = new kernel.ContextCompressionControlPlane(ctx.database, ctx.store);
    const decision = await compression.evaluate(sourceRootId, seeded.authoritySnapshotId);
    assert.equal(decision.estimatedTokens, providerAligned.estimatedTokens);
    assert.ok(Math.abs(decision.estimatedTokens - durableByteEstimate) < 1_000);
    assert.equal(decision.shouldCompress, true);
    assert.ok(decision.estimatedTokens >= decision.thresholdTokens);
    const belowThreshold = await seedTurn(ctx, 'compression-below-threshold', {
      thresholdTokens: 1_000_000
    });
    const belowThresholdRootId = await context.currentHeadRootId(belowThreshold.conversationId);
    const belowThresholdDecision = await compression.evaluate(
      belowThresholdRootId,
      belowThreshold.authoritySnapshotId
    );
    assert.equal(belowThresholdDecision.shouldCompress, false);
    const contentRowsBeforeExplicitCompression = await countAll(ctx.database, 'ContentObject');
    const belowThresholdCompression = await compression.create({
      conversationId: belowThreshold.conversationId,
      headRootId: belowThresholdRootId,
      authoritySnapshotId: belowThreshold.authoritySnapshotId,
      compressSegmentCount: 1,
      title: 'explicit-below-threshold',
      summary: 'explicit-below-threshold',
      idempotencyKey: 'below-threshold-explicit'
    });
    assert.equal(belowThresholdCompression.sourceCount, 1);
    assert.ok(await countAll(ctx.database, 'ContentObject') > contentRowsBeforeExplicitCompression);
    assert.equal(
      await context.currentHeadRootId(belowThreshold.conversationId),
      belowThresholdCompression.rootId
    );

    const multimodal = await seedTurn(ctx, 'compression-multimodal-token-estimate', {
      thresholdTokens: 100_000
    });
    await appendMessageContextFixture(
      ctx,
      multimodal,
      'large-inline-image',
      'user',
      JSON.stringify({
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'A'.repeat(700_000) } }]
      }),
      'application/vnd.limcode.message+json'
    );
    const multimodalRootId = await context.currentHeadRootId(multimodal.conversationId);
    const multimodalRoot = await get(ctx.database, 'ContextSequenceRoot', multimodalRootId);
    assert.ok(Number(multimodalRoot.estimated_tokens) > 100_000, 'legacy durable byte cache should reproduce the false threshold crossing');
    const multimodalDecision = await compression.evaluate(multimodalRootId, multimodal.authoritySnapshotId);
    assert.equal(multimodalDecision.shouldCompress, false);
    assert.ok(multimodalDecision.estimatedTokens < 10_000);
    assertions.push('700k base64图片即使令旧root字节缓存超过100k，也按多模态语义保持低于阈值，不会触发自动压缩');
    assertions.push('压缩判定按provider语义估算重新物化Context，root旧字节缓存不再驱动阈值；显式压缩提交不再被Context-only阈值二次否决');

    const nodeBefore = await countAll(ctx.database, 'ContextSequenceNode');
    const compressCount = 4;
    const result = await compression.create({
      conversationId: seeded.conversationId,
      headRootId: sourceRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      compressSegmentCount: compressCount,
      title: 'bounded compression',
      summary: 'FINITE-SUMMARY',
      idempotencyKey: 'bounded-compression'
    });
    const nodeAfter = await countAll(ctx.database, 'ContextSequenceNode');
    assert.equal(nodeAfter - nodeBefore, 1);
    assert.ok(nodeAfter - nodeBefore <= 4);
    assert.equal(await count(ctx.database, 'CompressionBlockSource', {
      compression_block_id: result.compressionBlockId
    }), compressCount);
    metrics.nodeDelta = nodeAfter - nodeBefore;
    metrics.sourceRows = compressCount;
    const nodeScaling = [{ sourceCount: compressCount, nodeDelta: nodeAfter - nodeBefore }];
    for (const sourceCount of [1, 64, 512]) {
      const sized = await seedTurn(ctx, `compression-size-${sourceCount}`, { thresholdTokens: 1 });
      for (let index = 1; index < sourceCount; index += 1) {
        const sizedDelivery = runtimeDeliveryFixture(
          `compression-size-${sourceCount}-${index}`,
          sized.turnId,
          `compression-size-${sourceCount}-${index}`
        );
        await context.appendContent({
          conversationId: sized.conversationId,
          segmentKind: 'runtime_context',
          source: {
            sourceKind: 'runtime_context',
            sourceId: `compression-size-${sourceCount}-${index}`,
            sourceRevision: '0'
          },
          content: sizedDelivery.content,
          contentType: sizedDelivery.contentType
        });
      }
      const sizedRoot = await context.currentHeadRootId(sized.conversationId);
      const sizedNodeBefore = await countAll(ctx.database, 'ContextSequenceNode');
      const sizedResult = await compression.create({
        conversationId: sized.conversationId,
        headRootId: sizedRoot,
        authoritySnapshotId: sized.authoritySnapshotId,
        compressSegmentCount: sourceCount,
        title: `bounded-${sourceCount}`,
        summary: `BOUNDED-SUMMARY-${sourceCount}`,
        idempotencyKey: `bounded-${sourceCount}`
      });
      const sizedNodeDelta = await countAll(ctx.database, 'ContextSequenceNode') - sizedNodeBefore;
      assert.equal(sizedNodeDelta, 1);
      assert.ok(sizedNodeDelta <= 4);
      assert.equal(await count(ctx.database, 'CompressionBlockSource', {
        compression_block_id: sizedResult.compressionBlockId
      }), sourceCount);
      nodeScaling.push({ sourceCount, nodeDelta: sizedNodeDelta });
    }
    metrics.nodeScaling = nodeScaling;
    assertions.push('压缩区间k=1/4/64/512时真实ContextSequenceNode增量恒为1（≤4、O(1)），CompressionBlockSource则精确写入k行');

    const compressed = await context.materialize(result.rootId);
    const expectedTail = sourceMaterialized.segments.slice(compressCount).map((segment) => segment.content.toString('utf8'));
    assert.deepEqual(
      compressed.segments.map((segment) => segment.content.toString('utf8')),
      ['FINITE-SUMMARY', ...expectedTail]
    );
    for (const original of sourceMaterialized.segments.slice(0, compressCount)) {
      assert.ok(!compressed.segments.some((segment) => segment.segmentId === original.segmentId));
    }
    assert.equal(compressed.root.tail_segment_count, BigInt(expectedTail.length));
    assertions.push('compression root严格物化summary+finite tail，到tail_segment_count即停止且不重新带回被替换原文');

    const afterCompressionDelivery = runtimeDeliveryFixture(
      'after-compression', seeded.turnId, 'after-compression'
    );
    const appended = await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'after-compression', sourceRevision: '0' },
      content: afterCompressionDelivery.content,
      contentType: afterCompressionDelivery.contentType
    });
    const afterAppend = await context.materialize(appended.rootId);
    assert.deepEqual(afterAppend.segments.map((segment) => segment.content.toString('utf8')), [
      'FINITE-SUMMARY', ...expectedTail, afterCompressionDelivery.content
    ]);
    assertions.push('compression后普通append只延长有限tail并继续复用summary，不重接被压缩prefix');

    const nestedSeed = await seedTurn(ctx, 'compression-nested-lineage', { thresholdTokens: 1 });
    const nestedSourceRoot = await context.currentHeadRootId(nestedSeed.conversationId);
    const inner = await compression.create({
      conversationId: nestedSeed.conversationId,
      headRootId: nestedSourceRoot,
      authoritySnapshotId: nestedSeed.authoritySnapshotId,
      compressSegmentCount: 1,
      title: 'inner', summary: 'INNER-SUMMARY', idempotencyKey: 'inner'
    });
    const outer = await compression.create({
      conversationId: nestedSeed.conversationId,
      headRootId: inner.rootId,
      authoritySnapshotId: nestedSeed.authoritySnapshotId,
      compressSegmentCount: 1,
      title: 'outer', summary: 'OUTER-SUMMARY', idempotencyKey: 'outer'
    });
    await terminateSeededTurn(nestedSeed, 'nested-compression-history-mutation');
    await nestedSeed.control.edit({
      source: { kind: 'command', key: 'nested-compressed-edit' },
      conversationId: nestedSeed.conversationId,
      messageId: nestedSeed.messageId,
      content: 'NESTED-EDITED-CONTENT'
    });
    const nestedAfterEdit = await context.materialize(await context.currentHeadRootId(nestedSeed.conversationId));
    assert.deepEqual(nestedAfterEdit.segments.map((segment) => segment.content.toString('utf8')), [
      'NESTED-EDITED-CONTENT'
    ]);
    assert.equal((await get(ctx.database, 'CompressionBlock', inner.compressionBlockId)).status, 'disabled');
    assert.equal((await get(ctx.database, 'CompressionBlock', outer.compressionBlockId)).status, 'disabled');
    assert.deepEqual((await context.materialize(outer.rootId)).segments.map((segment) =>
      segment.content.toString('utf8')
    ), ['OUTER-SUMMARY']);
    await nestedSeed.control.delete({
      source: { kind: 'command', key: 'nested-compressed-delete' },
      conversationId: nestedSeed.conversationId,
      messageId: nestedSeed.messageId
    });
    assert.deepEqual((await context.materialize(
      await context.currentHeadRootId(nestedSeed.conversationId)
    )).segments, []);

    const retainedSeed = await seedTurn(ctx, 'compression-retained-inner-summary', { thresholdTokens: 1 });
    const retainedInner = await compression.create({
      conversationId: retainedSeed.conversationId,
      headRootId: await context.currentHeadRootId(retainedSeed.conversationId),
      authoritySnapshotId: retainedSeed.authoritySnapshotId,
      compressSegmentCount: 1,
      title: 'retained-inner', summary: 'RETAINED-INNER-SUMMARY', idempotencyKey: 'retained-inner'
    });
    const retainedMessage = await appendMessageContextFixture(
      ctx,
      retainedSeed,
      'retained-outer-target',
      'user',
      'RETAINED-OUTER-TARGET'
    );
    const retainedOuter = await compression.create({
      conversationId: retainedSeed.conversationId,
      headRootId: await context.currentHeadRootId(retainedSeed.conversationId),
      authoritySnapshotId: retainedSeed.authoritySnapshotId,
      compressSegmentCount: 2,
      title: 'retained-outer', summary: 'RETAINED-OUTER-SUMMARY', idempotencyKey: 'retained-outer'
    });
    await terminateSeededTurn(retainedSeed, 'retained-compression-history-mutation');
    await retainedSeed.control.edit({
      source: { kind: 'command', key: 'retained-inner-summary-edit' },
      conversationId: retainedSeed.conversationId,
      messageId: retainedMessage.messageId,
      content: 'RETAINED-OUTER-EDITED'
    });
    assert.deepEqual((await context.materialize(
      await context.currentHeadRootId(retainedSeed.conversationId)
    )).segments.map((segment) => segment.content.toString('utf8')), [
      'RETAINED-INNER-SUMMARY', 'RETAINED-OUTER-EDITED'
    ]);
    assert.equal((await get(ctx.database, 'CompressionBlock', retainedInner.compressionBlockId)).status, 'enabled');
    assert.equal((await get(ctx.database, 'CompressionBlock', retainedOuter.compressionBlockId)).status, 'disabled');
    const retainedOuterAfterEdit = await compression.create({
      conversationId: retainedSeed.conversationId,
      headRootId: await context.currentHeadRootId(retainedSeed.conversationId),
      authoritySnapshotId: retainedSeed.authoritySnapshotId,
      compressSegmentCount: 2,
      title: 'retained-outer-two', summary: 'RETAINED-OUTER-TWO', idempotencyKey: 'retained-outer-two'
    });
    await retainedSeed.control.delete({
      source: { kind: 'command', key: 'retained-inner-summary-delete' },
      conversationId: retainedSeed.conversationId,
      messageId: retainedMessage.messageId
    });
    assert.deepEqual((await context.materialize(
      await context.currentHeadRootId(retainedSeed.conversationId)
    )).segments.map((segment) => segment.content.toString('utf8')), ['RETAINED-INNER-SUMMARY']);
    assert.equal((await get(ctx.database, 'CompressionBlock', retainedInner.compressionBlockId)).status, 'enabled');
    assert.equal((await get(ctx.database, 'CompressionBlock', retainedOuterAfterEdit.compressionBlockId)).status, 'disabled');
    assert.deepEqual((await context.materialize(retainedOuter.rootId)).segments.map((segment) =>
      segment.content.toString('utf8')
    ), ['RETAINED-OUTER-SUMMARY']);
    assertions.push('嵌套compression lineage中的Message edit/delete会递归展开冻结来源；保留不含目标的内层summary时复用其NULL-parent node并构造finite tail；只禁用涉及目标的outer block，历史root不变');

    return { assertions, faults, metrics };
  });
}
async function checkProviderFullRequest() {
  const authority = JSON.parse(await fs.readFile(
    path.join(root, 'docs/architecture/reliable-kernel/contracts/authority.json'),
    'utf8'
  ));
  assert.ok(!authority.runtimeDomains.some((entry) => entry.key === 'ProviderContinuation'));
  assert.ok(!kernel.RUNTIME_DOMAIN_SCHEMAS.some((entry) =>
    entry.key === 'ProviderContinuation' || entry.table === 'provider_continuation'
  ));

  return withRuntime('provider-full', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const seeded = await seedTurn(ctx, 'provider-full', { thresholdTokens: 4 });
    let provider = new kernel.ModelProviderControlPlane(ctx.database, ctx.store);
    let context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    const assistantMessage = await appendMessageContextFixture(
      ctx,
      seeded,
      'provider-assistant',
      'assistant',
      'assistant-context-response'
    );
    const providerTool = await seedToolPair(ctx, seeded, 'provider-full');
    const toolPair = await context.appendToolPair({
      conversationId: seeded.conversationId,
      toolCallId: providerTool.toolCallId,
      toolModelResultId: providerTool.toolModelResultId
    });
    await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'system',
      source: { sourceKind: 'system', sourceId: 'provider-tail', sourceRevision: '0' },
      content: 'provider-tail', contentType: 'text/plain'
    });
    const originalRootId = await context.currentHeadRootId(seeded.conversationId);
    const messageSource = (await list(ctx.database, 'ContextSegmentSource', {
      source_kind: 'message_revision',
      source_id: seeded.messageRevisionId,
      source_revision: 1n
    }))[0];
    const tailSource = (await list(ctx.database, 'ContextSegmentSource', {
      source_kind: 'system',
      source_id: 'provider-tail',
      source_revision: 0n
    }))[0];
    assert.ok(messageSource && tailSource);
    const expectedOriginalContext = [
      {
        segmentId: messageSource.segment_id,
        segmentKind: 'message',
        messageRole: 'user',
        contentType: 'text/plain',
        content: seeded.inputContent
      },
      {
        segmentId: assistantMessage.segmentId,
        segmentKind: 'message',
        messageRole: 'assistant',
        contentType: 'text/plain',
        content: 'assistant-context-response'
      },
      {
        segmentId: toolPair.segmentId,
        segmentKind: 'tool_pair',
        messageRole: null,
        contentType: 'application/vnd.limcode.context-tool-pair+json',
        content: JSON.stringify({
          kind: 'tool_pair',
          toolCall: {
            id: providerTool.toolCallId,
            callSeq: '1',
            toolName: 'echo',
            argumentsContentType: 'application/json',
            arguments: JSON.stringify({ value: 'provider-full' })
          },
          toolModelResult: {
            id: providerTool.toolModelResultId,
            messageRevisionId: 'tool-message-revision-provider-full',
            resultContentType: 'text/plain',
            result: 'tool-result-provider-full'
          }
        })
      },
      {
        segmentId: tailSource.segment_id,
        segmentKind: 'system',
        messageRole: null,
        contentType: 'text/plain',
        content: 'provider-tail'
      }
    ];
    const expectedOriginalAuthority = {
      kind: 'effective-turn-authority',
      turnId: seeded.turnId,
      executorAgentId: seeded.agentId,
      modelProfile: {
        compressionThresholdTokens: 4,
        contextWindowTokens: 200_000,
        tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
      },
      model: { providerConfigId: 'fake-local', modelId: 'fake-model', maxOutputTokens: 16_000 },
      policies: { toolPolicyId: 'tools-default', systemPromptId: 'prompt-default' }
    };
    const created = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: originalRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: { temperature: 0, tools: [{ name: 'echo' }] },
      idempotencyKey: 'provider-request-1'
    });
    assert.ok(await get(ctx.database, 'ModelRequest', created.modelRequestId));
    const currentHeadAppend = await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'system',
      source: { sourceKind: 'system', sourceId: 'head-after-request-freeze', sourceRevision: '0' },
      content: 'CURRENT-HEAD-AFTER-FROZEN-REQUEST',
      contentType: 'text/plain'
    });
    const currentAfterFreeze = await context.currentHeadRootId(seeded.conversationId);
    const casBeforeConflict = await casFileCount(ctx.binding.paths.casRootPath);
    await assert.rejects(provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: currentAfterFreeze,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: { conflicting: 'same-key-different-frozen-input' },
      idempotencyKey: 'provider-request-1'
    }), (error) => error?.code === 'MODEL_REQUEST_IDEMPOTENCY_CONFLICT');
    assert.equal(await casFileCount(ctx.binding.paths.casRootPath), casBeforeConflict);
    const frozenSettings = await ctx.store.ingest(
      ctx.database,
      JSON.stringify({ endpointMode: 'local-fake', maxOutputTokens: 64 }),
      'application/json'
    );
    const settingsRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: originalRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      settingsSnapshotContentObjectId: frozenSettings.id,
      recipe: { settings: true },
      idempotencyKey: 'frozen-settings-request'
    });
    assert.deepEqual((await provider.replay(settingsRequest.modelRequestId)).settingsSnapshot, {
      endpointMode: 'local-fake', maxOutputTokens: 64
    });
    let mismatchedAdapterCalls = 0;
    await assert.rejects(provider.dispatch(settingsRequest.modelRequestId, {
      providerId: 'wrong-current-provider',
      async sendFullRequest() { mismatchedAdapterCalls += 1; }
    }), /does not match frozen provider/);
    assert.equal(mismatchedAdapterCalls, 0);
    let settingsPayload;
    await provider.dispatch(settingsRequest.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest(request, controls) {
        settingsPayload = request;
        await controls.onEvent({
          kind: 'completed', streamSeq: '1', content: { fixture: 'settings-payload-complete' }
        });
      }
    });
    assert.deepEqual(settingsPayload.settingsSnapshot, {
      endpointMode: 'local-fake', maxOutputTokens: 64
    });
    assert.deepEqual(settingsPayload.context, expectedOriginalContext);
    assert.equal((await get(ctx.database, 'ModelRequest', settingsRequest.modelRequestId)).terminal_state, 'completed');
    let externalCalls = 0;
    await closeAndCheckpoint(ctx);
    assert.equal(externalCalls, 0);
    await reopen(ctx, 'phase-e-provider-reopen');
    provider = new kernel.ModelProviderControlPlane(ctx.database, ctx.store);
    context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    assert.ok(await get(ctx.database, 'ModelRequest', created.modelRequestId));
    assert.equal(externalCalls, 0);
    assertions.push('ModelRequest/Projection/Operation/attempt在adapter外调前提交，数据库重开后不会自动retry或dispatch');
    faults.push('ModelRequest commit before provider dispatch then database reopen');

    const checkpointFaultRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: originalRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: { fault: 'checkpoint-before-fence' },
      idempotencyKey: 'checkpoint-fence-fault'
    });
    const checkpointFaultSocket = await openPendingProviderSocket(
      ctx,
      provider,
      checkpointFaultRequest.modelRequestId,
      async () => { externalCalls += 1; }
    );
    const checkpointRowsBeforeFault = await count(ctx.database, 'ModelStreamCheckpoint', {
      model_request_id: checkpointFaultRequest.modelRequestId
    });
    const contentRowsBeforeFault = await countAll(ctx.database, 'ContentObject');
    const liveDatabase = ctx.database;
    let checkpointFenceFaultInjected = false;
    const checkpointFaultDatabase = databaseFacade(liveDatabase, {
      commitModelStreamEvent: (input) => {
        if (checkpointFenceFaultInjected || input.checkpointKind !== 'terminal_summary') {
          return liveDatabase.commitModelStreamEvent(input);
        }
        checkpointFenceFaultInjected = true;
        // The fixed worker operation inserts the checkpoint first, then validates/inserts the fence.
        // An invalid fence identity therefore exercises rollback at that exact production boundary.
        return liveDatabase.commitModelStreamEvent({ ...input, terminalFenceId: '' });
      }
    });
    const faultProvider = new kernel.ModelProviderControlPlane(checkpointFaultDatabase, ctx.store);
    await assert.rejects(faultProvider.recordStreamEvent(
      checkpointFaultRequest.modelRequestId,
      checkpointFaultSocket.attemptSeq,
      checkpointFaultSocket.socketGeneration,
      { kind: 'completed', streamSeq: '1', content: { forcedRollback: true } }
    ), /non-empty/);
    assert.equal(checkpointFenceFaultInjected, true);
    assert.equal(await count(ctx.database, 'ModelStreamCheckpoint', {
      model_request_id: checkpointFaultRequest.modelRequestId
    }), checkpointRowsBeforeFault);
    assert.equal(await count(ctx.database, 'ModelStreamFence', {
      model_request_id: checkpointFaultRequest.modelRequestId
    }), 0);
    assert.equal(await countAll(ctx.database, 'ContentObject'), contentRowsBeforeFault);
    assert.equal((await get(ctx.database, 'ModelRequest', checkpointFaultRequest.modelRequestId)).status, 'streaming');
    assertions.push('checkpoint写入与Completed fence之间的真实writer故障回滚整笔事务，不留下checkpoint、fence或SQLite Content引用');
    faults.push('checkpoint insert before terminal fence transaction rollback');

    const payloads = [];
    const first = await openPendingProviderSocket(ctx, provider, created.modelRequestId, async (request, controls) => {
        externalCalls += 1;
        payloads.push(request);
        assertNoContinuationPayload(request);
        await controls.onEvent({ kind: 'output_item_done', streamSeq: '1', content: { item: 'done' } });
    });
    assert.equal((await list(ctx.database, 'ModelStreamFence', {
      model_request_id: created.modelRequestId
    })).length, 0);
    await provider.quiesceAllActiveDispatches();
    assert.equal((await first.settled).status, 'rejected');
    assert.equal((await checkpointFaultSocket.settled).status, 'rejected');
    await closeAndCheckpoint(ctx);
    await reopen(ctx, 'phase-e-provider-reconnect-reopen');
    provider = new kernel.ModelProviderControlPlane(ctx.database, ctx.store);
    context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    const reconnect = await openPendingProviderSocket(ctx, provider, created.modelRequestId, async (request) => {
        externalCalls += 1;
        payloads.push(request);
        assertNoContinuationPayload(request);
    }, { reconnect: true });
    assert.equal(reconnect.attemptSeq, '1');
    assert.equal(reconnect.socketGeneration, '2');
    assert.equal(Number.isFinite(payloads[0].requestCreatedAt), true);
    assert.deepEqual(payloads[0], {
      kind: 'full-model-request',
      modelRequestId: created.modelRequestId,
      conversationId: seeded.conversationId,
      attemptSeq: '1',
      socketGeneration: '1',
      providerId: 'fake-local',
      modelId: 'fake-model',
      authoritySnapshot: expectedOriginalAuthority,
      recipe: {
        temperature: 0,
        tools: [{ name: 'echo' }],
        attachmentCatalogState: { catalog: [], placements: [] }
      },
      context: expectedOriginalContext,
      attachmentCatalogState: { catalog: [], placements: [] },
      requestCreatedAt: payloads[0].requestCreatedAt
    });
    assert.deepEqual(payloads[1], {
      ...payloads[0],
      socketGeneration: '2'
    });
    assert.equal(payloads[1].requestCreatedAt, payloads[0].requestCreatedAt);
    assert.ok(!payloads[0].context.some((item) => item.content === 'CURRENT-HEAD-AFTER-FROZEN-REQUEST'));
    await provider.quiesceTurnDispatches(seeded.turnId);
    assert.equal((await reconnect.settled).status, 'rejected');
    assertions.push('首次请求与Extension Host数据库重开后的显式reconnect均逐字段等于冻结root/authority/recipe完整oracle；推进current head不改变payload；OutputItemDone不冒充Completed fence且重启不自动dispatch');

    const staleOutcomeRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: originalRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: { stale: true },
      idempotencyKey: 'stale-socket-outcome'
    });
    let oldSocketEnteredResolve;
    const oldSocketEntered = new Promise((resolve) => { oldSocketEnteredResolve = resolve; });
    let releaseOldSocketResolve;
    const releaseOldSocket = new Promise((resolve) => { releaseOldSocketResolve = resolve; });
    const oldSocketDispatch = provider.dispatch(staleOutcomeRequest.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest() {
        oldSocketEnteredResolve();
        await releaseOldSocket;
        throw new kernel.ProviderTransientError('connection_interrupted', 'late old socket error');
      }
    });
    await oldSocketEntered;
    const newerSocket = await openPendingProviderSocket(
      ctx,
      provider,
      staleOutcomeRequest.modelRequestId,
      async () => {},
      { reconnect: true }
    );
    assert.equal(newerSocket.socketGeneration, '2');
    releaseOldSocketResolve();
    const staleOutcome = await oldSocketDispatch;
    assert.equal(staleOutcome.superseded, true);
    const staleRequestRow = await get(ctx.database, 'ModelRequest', staleOutcomeRequest.modelRequestId);
    assert.deepEqual(staleRequestRow.stream_stats_json, {
      attemptSeq: '1', socketGeneration: '2', retryReason: null
    });
    const staleOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: staleOutcomeRequest.modelRequestId
    }))[0];
    assert.equal((await list(ctx.database, 'Attempt', { operation_id: staleOperation.id })).length, 1);
    assert.equal(await provider.cancel(staleOutcomeRequest.modelRequestId, 'stale-outcome-fixture-complete'), true);
    assert.equal((await newerSocket.settled).status, 'rejected');

    const staleResolveRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: originalRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: { staleResolve: true },
      idempotencyKey: 'stale-socket-normal-resolve'
    });
    let staleResolveEnteredResolve;
    const staleResolveEntered = new Promise((resolve) => { staleResolveEnteredResolve = resolve; });
    let releaseStaleResolveResolve;
    const releaseStaleResolve = new Promise((resolve) => { releaseStaleResolveResolve = resolve; });
    const staleResolveDispatch = provider.dispatch(staleResolveRequest.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest() {
        staleResolveEnteredResolve();
        await releaseStaleResolve;
      }
    });
    await staleResolveEntered;
    const staleResolveNewSocket = await openPendingProviderSocket(
      ctx,
      provider,
      staleResolveRequest.modelRequestId,
      async () => {},
      { reconnect: true }
    );
    assert.equal(staleResolveNewSocket.socketGeneration, '2');
    releaseStaleResolveResolve();
    assert.equal((await staleResolveDispatch).superseded, true);
    assert.equal(await provider.cancel(staleResolveRequest.modelRequestId, 'stale-resolve-fixture-complete'), true);
    assert.equal((await staleResolveNewSocket.settled).status, 'rejected');

    const staleEventRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: originalRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: { staleEvent: true },
      idempotencyKey: 'stale-socket-event'
    });
    const staleEventSocket = await openPendingProviderSocket(
      ctx,
      provider,
      staleEventRequest.modelRequestId,
      async () => {}
    );
    let staleEventPublishedResolve;
    const staleEventPublished = new Promise((resolve) => { staleEventPublishedResolve = resolve; });
    let releaseStaleEventResolve;
    const releaseStaleEvent = new Promise((resolve) => { releaseStaleEventResolve = resolve; });
    const staleEventStore = storeFacade(ctx.store, {
      async prepare(...args) {
        const prepared = await ctx.store.prepare(...args);
        staleEventPublishedResolve();
        await releaseStaleEvent;
        return prepared;
      }
    });
    const gatedEventProvider = new kernel.ModelProviderControlPlane(ctx.database, staleEventStore);
    const contentRowsBeforeStaleEvent = await countAll(ctx.database, 'ContentObject');
    const staleEventPromise = gatedEventProvider.recordStreamEvent(
      staleEventRequest.modelRequestId,
      staleEventSocket.attemptSeq,
      staleEventSocket.socketGeneration,
      { kind: 'output_delta', streamSeq: '1', content: 'STALE-EVENT-AFTER-PREFLIGHT' }
    );
    await staleEventPublished;
    const staleEventNewSocket = await openPendingProviderSocket(
      ctx,
      provider,
      staleEventRequest.modelRequestId,
      async () => {},
      { reconnect: true }
    );
    assert.equal(staleEventNewSocket.socketGeneration, '2');
    releaseStaleEventResolve();
    const staleEventResult = await staleEventPromise;
    assert.equal(staleEventResult.ignoredReason, 'old-socket-generation');
    assert.equal(await count(ctx.database, 'ModelStreamCheckpoint', {
      model_request_id: staleEventRequest.modelRequestId
    }), 0);
    assert.equal(await countAll(ctx.database, 'ContentObject'), contentRowsBeforeStaleEvent);
    assert.equal(await provider.cancel(staleEventRequest.modelRequestId, 'stale-event-fixture-complete'), true);
    assert.equal((await staleEventSocket.settled).status, 'rejected');
    assert.equal((await staleEventNewSocket.settled).status, 'rejected');
    assertions.push('旧socket transient或正常resolve都标记superseded；已通过reader预检、CAS发布后才遇到reconnect的迟到event由writer精确identity忽略，不终止新socket、不建attempt 2且不留SQLite引用');

    let retryDispatchCalls = 0;
    let outputItemHadNoFence = false;
    await provider.dispatch(created.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest(request, controls) {
        externalCalls += 1;
        retryDispatchCalls += 1;
        payloads.push(request);
        assertNoContinuationPayload(request);
        if (retryDispatchCalls === 1) {
          throw new kernel.ProviderTransientError('connection_interrupted', 'deterministic connection break');
        }
        const oldAttemptLate = await provider.recordStreamEvent(
          created.modelRequestId,
          '1',
          '3',
          { kind: 'output_delta', streamSeq: '2', content: 'late-old-attempt' }
        );
        assert.equal(oldAttemptLate.ignoredReason, 'old-attempt');
        await controls.onEvent({ kind: 'output_item_done', streamSeq: '1', content: { outputItem: 1 } });
        outputItemHadNoFence = (await list(ctx.database, 'ModelStreamFence', {
          model_request_id: created.modelRequestId
        })).length === 0;
        for (let seq = 2; seq <= 38; seq += 1) {
          await controls.onEvent({ kind: 'output_delta', streamSeq: String(seq), content: `delta-${seq}` });
        }
        await controls.onEvent({
          kind: 'completed', streamSeq: '39', content: { completed: true }, usage: { totalTokens: 39 }
        });
      }
    }, { reconnect: true });
    assert.equal(retryDispatchCalls, 2);
    assert.equal(payloads.at(-1).attemptSeq, '2');
    assert.equal(payloads.at(-1).conversationId, seeded.conversationId);
    assert.deepEqual(payloads.at(-1).context, expectedOriginalContext);
    assert.deepEqual(payloads.at(-1).recipe, payloads[0].recipe);
    assert.deepEqual(payloads.at(-1).authoritySnapshot, expectedOriginalAuthority);
    const retriedOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: created.modelRequestId
    }))[0];
    assert.equal((await list(ctx.database, 'Attempt', {
      operation_id: retriedOperation.id
    })).length, 2);
    assertions.push('旧AuthoritySnapshot兼容原有单次持久retry：明确连接中断创建attempt 2，完整上下文不变且无第二条瞬时observer authority');
    faults.push('typed provider transient disconnect after full request dispatch');

    const ordinaryFailure = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: originalRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: { fail: 'ordinary' },
      idempotencyKey: 'ordinary-provider-failure'
    });
    let ordinaryFailureCalls = 0;
    await assert.rejects(provider.dispatch(ordinaryFailure.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest() { ordinaryFailureCalls += 1; throw new Error('permanent provider failure'); }
    }), /permanent provider failure/);
    assert.equal(ordinaryFailureCalls, 1);
    const ordinaryFailureOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: ordinaryFailure.modelRequestId
    }))[0];
    assert.equal((await list(ctx.database, 'Attempt', { operation_id: ordinaryFailureOperation.id })).length, 1);

    const doubleTransient = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: originalRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: { fail: 'twice-transient' },
      idempotencyKey: 'double-transient-provider-failure'
    });
    let doubleTransientCalls = 0;
    await assert.rejects(provider.dispatch(doubleTransient.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest() {
        doubleTransientCalls += 1;
        throw new kernel.ProviderTransientError('temporary_service_error', 'still transient');
      }
    }), /still transient/);
    assert.equal(doubleTransientCalls, 2);
    const doubleTransientOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: doubleTransient.modelRequestId
    }))[0];
    assert.equal((await list(ctx.database, 'Attempt', { operation_id: doubleTransientOperation.id })).length, 2);
    assert.equal((await get(ctx.database, 'ModelRequest', doubleTransient.modelRequestId)).status, 'terminal');

    assert.deepEqual(kernel.RELIABLE_PROVIDER_SEMANTIC_DEADLINES_MS, {
      ordinaryFirst: 300_000,
      ordinaryIdle: 600_000,
      compressionCompletion: 270_000
    });

    const boundedRetrySeed = await seedTurn(ctx, 'bounded-provider-retry', {
      retryPolicy: { enabled: true, maxRetries: 3 },
      provider: 'openai-responses',
      toolPolicy: { allowedTools: [], preset: 'custom', sourceConfigs: {} }
    });
    const boundedContext = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    const boundedProvider = new kernel.ModelProviderControlPlane(ctx.database, ctx.store, {
      semanticTimeouts: {
        firstSemanticMs: 50,
        semanticIdleMs: 35,
        compressionCompletionMs: 100
      },
      retryDelaysMs: [0],
      adapterDrainTimeoutMs: 20
    });
    const boundedRequest = await boundedProvider.createModelRequest({
      turnId: boundedRetrySeed.turnId,
      contextRootId: await boundedContext.currentHeadRootId(boundedRetrySeed.conversationId),
      authoritySnapshotId: boundedRetrySeed.authoritySnapshotId,
      recipe: { kind: 'reliable-agent-turn', round: '3', previousTool: 'update_task_list', tools: [] },
      idempotencyKey: 'bounded-provider-retry-fourth-attempt'
    });
    let boundedCalls = 0;
    await boundedProvider.dispatch(boundedRequest.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest(_request, controls) {
        boundedCalls += 1;
        if (boundedCalls <= 3) {
          throw new kernel.ProviderTransientError('temporary_service_error', `bounded-transient-${boundedCalls}`);
        }
        await controls.onEvent({
          kind: 'completed', streamSeq: '1', content: { text: 'bounded retry recovered' }
        });
      }
    });
    assert.equal(boundedCalls, 4);
    const boundedOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: boundedRequest.modelRequestId
    }))[0];
    assert.equal((await list(ctx.database, 'Attempt', { operation_id: boundedOperation.id })).length, 4);

    const preTerminalCloseRequest = await boundedProvider.createModelRequest({
      turnId: boundedRetrySeed.turnId,
      contextRootId: await boundedContext.currentHeadRootId(boundedRetrySeed.conversationId),
      authoritySnapshotId: boundedRetrySeed.authoritySnapshotId,
      recipe: { kind: 'reliable-agent-turn', round: '4', transportFixture: 'close-1000-before-terminal' },
      idempotencyKey: 'provider-close-1000-before-terminal'
    });
    let preTerminalCloseCalls = 0;
    const preTerminalCloseAdapter = new kernel.LlmCapabilityFullRequestAdapter('fake-local', {
      start(request, emit) {
        preTerminalCloseCalls += 1;
        if (preTerminalCloseCalls === 1) {
          emit({
            type: 'llm:error',
            payload: {
              requestId: request.id,
              message: 'OpenAI Responses WebSocket closed before terminal event: 1000',
              rawError: {
                name: 'WebSocketCloseError',
                message: 'OpenAI Responses WebSocket closed before terminal event: 1000',
                closeCode: 1000,
                phase: 'streaming',
                receivedServerEvent: false,
                retryable: false,
                transportAttemptsExhausted: false
              }
            }
          });
          return;
        }
        emit({ type: 'llm:done', payload: { requestId: request.id, completedAt: Date.now() } });
      },
      compact() { throw new Error('unused'); },
      abort() {}, cancelRetry() {}, dispose() {}, listModels: async () => []
    });
    await boundedProvider.dispatch(preTerminalCloseRequest.modelRequestId, preTerminalCloseAdapter);
    assert.equal(preTerminalCloseCalls, 2);
    const preTerminalCloseOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: preTerminalCloseRequest.modelRequestId
    }))[0];
    const preTerminalCloseAttempts = await list(ctx.database, 'Attempt', {
      operation_id: preTerminalCloseOperation.id
    });
    assert.deepEqual(
      preTerminalCloseAttempts
        .slice()
        .sort((left, right) => Number(left.attempt_seq) - Number(right.attempt_seq))
        .map((entry) => entry.status),
      ['transient_failed', 'completed']
    );

    const policyCloseRequest = await boundedProvider.createModelRequest({
      turnId: boundedRetrySeed.turnId,
      contextRootId: await boundedContext.currentHeadRootId(boundedRetrySeed.conversationId),
      authoritySnapshotId: boundedRetrySeed.authoritySnapshotId,
      recipe: { kind: 'reliable-agent-turn', round: '4', transportFixture: 'close-1008-before-terminal' },
      idempotencyKey: 'provider-close-1008-before-terminal'
    });
    let policyCloseCalls = 0;
    const policyCloseAdapter = new kernel.LlmCapabilityFullRequestAdapter('fake-local', {
      start(request, emit) {
        policyCloseCalls += 1;
        if (policyCloseCalls === 1) {
          emit({ type: 'llm:delta', payload: { requestId: request.id, text: 'discarded policy-close output' } });
          emit({
            type: 'llm:error',
            payload: {
              requestId: request.id,
              message: 'OpenAI Responses WebSocket closed before terminal event: 1008 policy violation',
              rawError: {
                name: 'WebSocketCloseError',
                message: 'OpenAI Responses WebSocket closed before terminal event: 1008 policy violation',
                closeCode: 1008,
                phase: 'streaming',
                receivedServerEvent: true,
                receivedSemanticOutput: true,
                retryable: false,
                transportAttemptsExhausted: false
              }
            }
          });
          return;
        }
        emit({ type: 'llm:delta', payload: { requestId: request.id, text: 'recovered policy-close output' } });
        emit({ type: 'llm:done', payload: { requestId: request.id, completedAt: Date.now() } });
      },
      compact() { throw new Error('unused'); },
      abort() {}, cancelRetry() {}, dispose() {}, listModels: async () => []
    });
    await boundedProvider.dispatch(policyCloseRequest.modelRequestId, policyCloseAdapter);
    assert.equal(policyCloseCalls, 2);
    const policyCloseOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: policyCloseRequest.modelRequestId
    }))[0];
    const policyCloseAttempts = (await list(ctx.database, 'Attempt', {
      operation_id: policyCloseOperation.id
    })).sort((left, right) => Number(left.attempt_seq) - Number(right.attempt_seq));
    assert.deepEqual(policyCloseAttempts.map((entry) => entry.status), ['transient_failed', 'completed']);
    assertions.push('WS 1000/1001/1008 等指定关闭码在 Responses 终态前统一创建 durable Attempt 并恢复；已有部分输出由新 Attempt 整体替换');
    faults.push('WebSocket close code 1000 before any Responses event or response.completed');
    metrics.preTerminalNormalCloseAttempts = preTerminalCloseCalls;

    const semanticStallRequest = await boundedProvider.createModelRequest({
      turnId: boundedRetrySeed.turnId,
      contextRootId: await boundedContext.currentHeadRootId(boundedRetrySeed.conversationId),
      authoritySnapshotId: boundedRetrySeed.authoritySnapshotId,
      recipe: { kind: 'reliable-agent-turn', round: '4', previousTool: 'update_task_list', tools: [] },
      idempotencyKey: 'semantic-stall-after-task-list'
    });
    let semanticCalls = 0;
    const semanticTerminals = [];
    await boundedProvider.dispatch(semanticStallRequest.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest(request, controls) {
        semanticCalls += 1;
        if (request.attemptSeq === '1') {
          for (let seq = 1; seq <= 5; seq += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            await controls.onEvent({
              kind: 'output_delta', streamSeq: String(seq), semanticProgress: false,
              content: { type: 'thought_progress', thoughtElapsedMs: seq * 500 }
            });
          }
          await new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }));
          const aborted = new Error('semantic watchdog aborted fixture socket');
          aborted.name = 'AbortError';
          throw aborted;
        }
        await controls.onEvent({
          kind: 'completed', streamSeq: '1', content: { text: 'semantic retry recovered' }
        });
      }
    }, { onTransientTerminal: (event) => semanticTerminals.push(event) });
    assert.equal(semanticCalls, 2);
    assert.ok(semanticTerminals.some((entry) =>
      entry.event.content.terminalState === 'provider_transient_first_semantic_timeout'
      && entry.event.content.retrying === true
    ));
    assertions.push('普通Provider语义deadline冻结为首语义80秒/后续idle60秒；无中间进度的压缩等待270秒CompactDone/CompactError终态；明确传输错误仍走即时重试');
    assertions.push('冻结retryMaxAttempts=3允许三个持久transient_failed Attempt后第四次恢复；每次仍复用同一ModelRequest与完整请求');
    assertions.push('submit_plan→update_task_list后的本地thought_progress既不算首个语义输出也不能续命，35ms首语义超时自动Attempt恢复而无需用户继续');
    faults.push('three consecutive retryable Provider failures before recovery');
    faults.push('first semantic output never arrives after task-list tool result while raw/local progress remains');
    metrics.boundedProviderAttempts = boundedCalls;
    metrics.semanticStallAttempts = semanticCalls;

    const compressionTrigger = {
      mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 1
    };
    const compressionPolicy = {
      enabled: true,
      binding: { kind: 'provider', id: 'compression-deadline-provider' },
      methodKind: 'segmented_summary',
      thresholdTokens: 1,
      trigger: compressionTrigger,
      provider: {
        providerConfigId: 'fake-local', provider: 'openai-responses', modelId: 'fake-model',
        contextWindowTokens: 200_000, maxOutputTokens: 16_000,
        retryPolicy: { enabled: true, maxRetries: 3 }
      },
      config: {
        id: 'compression-deadline-config', name: 'compression deadline fixture',
        kind: 'segmented_summary', trigger: compressionTrigger,
        llmSummary: { providerConfigId: 'fake-local', model: 'fake-model', targetTokens: 256 },
        createdAt: 1, updatedAt: 1
      }
    };
    const compressionSeed = await seedTurn(ctx, 'compression-terminal-deadline', {
      thresholdTokens: 1,
      compressionPolicy,
      includeConversationId: true
    });
    const compressionHead = await boundedContext.currentHeadRootId(compressionSeed.conversationId);
    const compressionRecipe = (suffix) => ({
      kind: 'reliable-context-compression',
      requestKind: 'context_compression_pre',
      trigger: 'auto',
      sourceRootId: compressionHead,
      sourceSegmentCount: 1,
      sourceHash: `compression-source-${suffix}`,
      blockId: `compression-block-${suffix}`,
      compressionConfigId: compressionPolicy.config.id,
      compressionMethodKind: compressionPolicy.methodKind,
      effectiveSummaryMaxTokens: 256
    });
    const compressionCapability = (compact) => new kernel.LlmCapabilityFullRequestAdapter('fake-local', {
      compact,
      start() { throw new Error('compression fixture must not use start'); },
      abort() {}, cancelRetry() {}, dispose() {}, listModels: async () => []
    });
    const emitCompressionDone = (request, emit, text) => emit({
      type: 'llm:compactDone',
      payload: {
        requestId: request.id,
        blockId: request.blockId,
        conversationId: request.conversationId,
        result: { contents: [{ role: 'model', parts: [{ text }] }] },
        completedAt: Date.now()
      }
    });

    const slowCompressionProvider = new kernel.ModelProviderControlPlane(ctx.database, ctx.store, {
      semanticTimeouts: {
        firstSemanticMs: 50,
        semanticIdleMs: 35,
        compressionCompletionMs: 100
      },
      retryDelaysMs: [0],
      adapterDrainTimeoutMs: 20
    });
    const slowCompression = await slowCompressionProvider.createModelRequest({
      turnId: compressionSeed.turnId,
      contextRootId: compressionHead,
      authoritySnapshotId: compressionSeed.authoritySnapshotId,
      recipe: compressionRecipe('slow-valid'),
      idempotencyKey: 'compression-slow-valid-before-terminal-deadline'
    });
    let slowCompressionCalls = 0;
    await slowCompressionProvider.dispatch(slowCompression.modelRequestId, compressionCapability((request, emit) => {
      slowCompressionCalls += 1;
      setTimeout(() => emitCompressionDone(request, emit, 'slow compression completed'), 70);
    }));
    assert.equal(slowCompressionCalls, 1);
    const slowCompressionOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: slowCompression.modelRequestId
    }))[0];
    assert.equal((await list(ctx.database, 'Attempt', {
      operation_id: slowCompressionOperation.id
    })).length, 1);

    const timeoutCompressionProvider = new kernel.ModelProviderControlPlane(ctx.database, ctx.store, {
      semanticTimeouts: {
        firstSemanticMs: 50,
        semanticIdleMs: 35,
        compressionCompletionMs: 40
      },
      retryDelaysMs: [0],
      adapterDrainTimeoutMs: 20
    });
    const timeoutCompression = await timeoutCompressionProvider.createModelRequest({
      turnId: compressionSeed.turnId,
      contextRootId: compressionHead,
      authoritySnapshotId: compressionSeed.authoritySnapshotId,
      recipe: compressionRecipe('terminal-timeout'),
      idempotencyKey: 'compression-terminal-timeout-recovery'
    });
    let timeoutCompressionCalls = 0;
    const compressionTerminals = [];
    await timeoutCompressionProvider.dispatch(timeoutCompression.modelRequestId, compressionCapability((request, emit) => {
      timeoutCompressionCalls += 1;
      if (timeoutCompressionCalls === 1) return;
      emitCompressionDone(request, emit, 'compression timeout recovered');
    }), { onTransientTerminal: (event) => compressionTerminals.push(event) });
    assert.equal(timeoutCompressionCalls, 2);
    assert.ok(compressionTerminals.some((entry) =>
      entry.event.content.terminalState === 'provider_transient_compression_timeout'
      && entry.event.content.retrying === true
    ));
    const timeoutCompressionOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: timeoutCompression.modelRequestId
    }))[0];
    const timeoutCompressionAttempts = await list(ctx.database, 'Attempt', {
      operation_id: timeoutCompressionOperation.id
    });
    assert.equal(timeoutCompressionAttempts.length, 2);
    assert.equal(timeoutCompressionAttempts.filter((entry) => entry.status === 'transient_failed').length, 1);

    const transportCompression = await timeoutCompressionProvider.createModelRequest({
      turnId: compressionSeed.turnId,
      contextRootId: compressionHead,
      authoritySnapshotId: compressionSeed.authoritySnapshotId,
      recipe: compressionRecipe('transport-recovery'),
      idempotencyKey: 'compression-explicit-transport-recovery'
    });
    let transportCompressionCalls = 0;
    await timeoutCompressionProvider.dispatch(transportCompression.modelRequestId, compressionCapability((request, emit) => {
      transportCompressionCalls += 1;
      if (transportCompressionCalls === 1) {
        emit({
          type: 'llm:compactError',
          payload: {
            requestId: request.id,
            blockId: request.blockId,
            conversationId: request.conversationId,
            message: 'compression websocket interrupted',
            rawError: { transport: 'websocket', retryable: true },
            completedAt: Date.now()
          }
        });
        return;
      }
      emitCompressionDone(request, emit, 'compression transport recovered');
    }));
    assert.equal(transportCompressionCalls, 2);
    assertions.push('无中间进度的压缩超过旧60秒等比阈值但早于270秒等比deadline时仅有一个Attempt；超过无进度deadline以compression_timeout创建Attempt 2；明确transport错误仍立即恢复');
    faults.push('terminal-only compression emits no semantic delta before a valid long-running CompactDone');
    metrics.compressionCompletionDeadlineAttempts = timeoutCompressionCalls;

    const buildFailure = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: originalRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: { missingCas: 'unique-build-failure' },
      idempotencyKey: 'local-build-failure'
    });
    const buildFailureRow = await get(ctx.database, 'ModelRequest', buildFailure.modelRequestId);
    const buildFailureRecipe = await get(ctx.database, 'ContentObject', buildFailureRow.recipe_object_id);
    await fs.rm(casObjectPath(ctx.binding, buildFailureRecipe.storage_key));
    let buildFailureExternalCalls = 0;
    await assert.rejects(provider.dispatch(buildFailure.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest() { buildFailureExternalCalls += 1; }
    }), /ENOENT|no such file/i);
    assert.equal(buildFailureExternalCalls, 0);
    assert.equal((await get(ctx.database, 'ModelRequest', buildFailure.modelRequestId)).status, 'terminal');
    assertions.push('永久普通Error只外调一次；旧Authority attempt 2再次临时失败后终止；冻结请求本地CAS构造失败在外调前收口terminal而不留下running');

    assert.equal(outputItemHadNoFence, true);
    assert.equal((await list(ctx.database, 'ModelStreamFence', {
      model_request_id: created.modelRequestId
    })).length, 1);
    const terminalLate = await provider.recordStreamEvent(
      created.modelRequestId,
      '2',
      '2',
      { kind: 'output_delta', streamSeq: '40', content: 'terminal-late' }
    );
    assert.equal(terminalLate.ignoredReason, 'terminal');
    const terminalCheckpointCount = await count(ctx.database, 'ModelStreamCheckpoint', {
      model_request_id: created.modelRequestId
    });
    assert.ok(terminalCheckpointCount <= 33);
    metrics.terminalCheckpointCount = terminalCheckpointCount;
    assertions.push('旧attempt/socket与terminal迟到事件均不追加checkpoint；只有Completed建fence，终态maintenance在同一事务裁剪后≤33行');

    const frozenBefore = await provider.replay(created.modelRequestId);
    const beforeReplayCommit = (await ctx.database.inspect()).currentCommitSeq;
    const replayAgain = await provider.replay(created.modelRequestId);
    assert.equal((await ctx.database.inspect()).currentCommitSeq, beforeReplayCommit);
    assert.deepEqual(replayAgain.context, frozenBefore.context);
    assert.deepEqual(replayAgain.recipe, frozenBefore.recipe);
    assertions.push('historical replay只读原root/AuthoritySnapshot/immutable recipe，dry-run不产生Runtime commit');

    const compression = new kernel.ContextCompressionControlPlane(ctx.database, ctx.store);
    const currentHead = await context.currentHeadRootId(seeded.conversationId);
    const currentMaterialized = await context.materialize(currentHead);
    const compressed = await compression.create({
      conversationId: seeded.conversationId,
      headRootId: currentHead,
      authoritySnapshotId: seeded.authoritySnapshotId,
      compressSegmentCount: Math.max(1, currentMaterialized.segments.length - 1),
      title: 'provider compression',
      summary: 'PROVIDER-SUMMARY',
      idempotencyKey: 'provider-compression'
    });
    const second = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: compressed.rootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: { temperature: 0 },
      idempotencyKey: 'provider-request-2'
    });
    let compressionPayload;
    await provider.dispatch(second.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest(request, controls) {
        compressionPayload = request;
        assertNoContinuationPayload(request);
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { completed: true } });
      }
    });
    const expectedCompressionContext = [
      {
        segmentId: compressed.summarySegmentId,
        segmentKind: 'compression',
        messageRole: null,
        contentType: 'text/markdown',
        content: 'PROVIDER-SUMMARY'
      },
      {
        segmentId: currentHeadAppend.segmentId,
        segmentKind: 'system',
        messageRole: null,
        contentType: 'text/plain',
        content: 'CURRENT-HEAD-AFTER-FROZEN-REQUEST'
      }
    ];
    assert.deepEqual(compressionPayload.context, expectedCompressionContext);
    assert.equal(compressionPayload.conversationId, seeded.conversationId);
    assert.equal(compressionPayload.context[0].content, 'PROVIDER-SUMMARY');
    assert.ok(!compressionPayload.context.some((item) => item.content === seeded.inputContent));
    assertions.push('compression后的新ModelRequest仍发送summary+finite tail完整请求，不发送suffix或已替换原文');

    const controlAfterReopen = createTurnControl(ctx, 'provider-full');

    const nestedSuffixRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {
        tools: [{
          name: 'path-tool',
          inputSchema: { type: 'object', properties: { suffix: { type: 'string' } } }
        }]
      },
      idempotencyKey: 'legitimate-tool-suffix'
    });
    assert.deepEqual((await provider.replay(nestedSuffixRequest.modelRequestId)).recipe, {
      tools: [{
        name: 'path-tool',
        inputSchema: { type: 'object', properties: { suffix: { type: 'string' } } }
      }],
      attachmentCatalogState: { catalog: [], placements: [] }
    });
    assert.throws(() => kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').update(created.modelRequestId, {
      recipe_object_id: 'mutate-forbidden'
    }), /immutable/);
    assertions.push('Runtime exact set无ProviderContinuation，完整请求envelope没有continuation槽位；合法tool schema字段不被关键词黑名单误伤，recipe仍不可变且无continuation→full fallback');

    const eventIdentityRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'stream-event-idempotency'
    });
    const eventIdentitySocket = await openPendingProviderSocket(
      ctx,
      provider,
      eventIdentityRequest.modelRequestId,
      async () => {}
    );
    const firstEvent = {
      kind: 'output_delta', streamSeq: '1', content: 'event-identity-A'
    };
    assert.equal((await provider.recordStreamEvent(
      eventIdentityRequest.modelRequestId,
      eventIdentitySocket.attemptSeq,
      eventIdentitySocket.socketGeneration,
      firstEvent
    )).checkpointed, true);
    assert.equal((await provider.recordStreamEvent(
      eventIdentityRequest.modelRequestId,
      eventIdentitySocket.attemptSeq,
      eventIdentitySocket.socketGeneration,
      firstEvent
    )).ignoredReason, 'duplicate');
    await assert.rejects(provider.recordStreamEvent(
      eventIdentityRequest.modelRequestId,
      eventIdentitySocket.attemptSeq,
      eventIdentitySocket.socketGeneration,
      { ...firstEvent, content: 'event-identity-B' }
    ), (error) => error?.code === 'MODEL_STREAM_IDEMPOTENCY_CONFLICT');
    await assert.rejects(provider.recordStreamEvent(
      eventIdentityRequest.modelRequestId,
      eventIdentitySocket.attemptSeq,
      eventIdentitySocket.socketGeneration,
      { kind: 'completed', streamSeq: '1', content: { completed: true } }
    ), (error) => error?.code === 'MODEL_STREAM_IDEMPOTENCY_CONFLICT');
    assert.equal(await count(ctx.database, 'ModelStreamFence', {
      model_request_id: eventIdentityRequest.modelRequestId
    }), 0);
    assert.equal(await provider.cancel(eventIdentityRequest.modelRequestId, 'stream-event-idempotency-complete'), true);
    assert.equal((await eventIdentitySocket.settled).status, 'rejected');

    const aggregateGuardRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'model-request-aggregate-guard'
    });
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').update(aggregateGuardRequest.modelRequestId, {
        status: 'terminal', terminal_state: 'completed', updated_at: new Date().toISOString()
      })
    ]), /aggregate is inconsistent/);
    assert.equal((await get(ctx.database, 'ModelRequest', aggregateGuardRequest.modelRequestId)).status, 'prepared');
    const aggregateOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: aggregateGuardRequest.modelRequestId
    }))[0];
    const aggregateAttempt = (await list(ctx.database, 'Attempt', { operation_id: aggregateOperation.id }))[0];
    assert.throws(() => kernel.DOMAIN_REPOSITORIES.domain('Operation').update(aggregateOperation.id, {
      owner_id: 'mutate-forbidden'
    }), /immutable/);
    assert.throws(() => kernel.DOMAIN_REPOSITORIES.domain('Attempt').update(aggregateAttempt.id, {
      attempt_seq: 2n
    }), /immutable/);
    assert.equal(await provider.cancel(aggregateGuardRequest.modelRequestId, 'aggregate-guard-complete'), true);
    assertions.push('同一stream identity仅kind与canonical content完全一致才可去重；冲突事件明确失败且不吞Completed；writer拒绝ModelRequest/Operation/Attempt聚合旁路');

    const capacityRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'checkpoint-capacity'
    });
    let capacityDrops = 0;
    const capacitySocket = await openPendingProviderSocket(
      ctx,
      provider,
      capacityRequest.modelRequestId,
      async (_request, controls) => {
        const results = await Promise.all(Array.from({ length: 70 }, (_unused, index) => {
          const seq = index + 1;
          return controls.onEvent({
            kind: 'output_delta', streamSeq: String(seq), content: `capacity-${seq}`
          });
        }));
        capacityDrops = results.filter((result) => result.ignoredReason === 'checkpoint-capacity').length;
      }
    );
    assert.equal(await count(ctx.database, 'ModelStreamCheckpoint', {
      model_request_id: capacityRequest.modelRequestId
    }), 1);
    assert.equal(capacityDrops, 69);
    for (let seq = 71; seq <= 102; seq += 1) {
      const semantic = await provider.recordStreamEvent(
        capacityRequest.modelRequestId,
        capacitySocket.attemptSeq,
        capacitySocket.socketGeneration,
        { kind: 'output_item_done', streamSeq: String(seq), content: { item: seq - 70 } }
      );
      assert.equal(semantic.checkpointed, true);
    }
    const overflowSemantic = await provider.recordStreamEvent(
      capacityRequest.modelRequestId,
      capacitySocket.attemptSeq,
      capacitySocket.socketGeneration,
      { kind: 'output_item_done', streamSeq: '103', content: { item: 33 } }
    );
    assert.equal(overflowSemantic.checkpointed, false);
    assert.equal(overflowSemantic.ignoredReason, 'checkpoint-capacity');
    assert.equal(await count(ctx.database, 'ModelStreamCheckpoint', {
      model_request_id: capacityRequest.modelRequestId
    }), 33);
    const allRequestsBeforeCancel = await listAll(ctx.database, 'ModelRequest', {});
    const activeRequestsBeforeCancel = allRequestsBeforeCancel.filter((request) => request.status !== 'terminal').length;
    const terminalRequestsBeforeCancel = allRequestsBeforeCancel.filter((request) => request.status === 'terminal').length;
    const allCheckpointRows = await countAll(ctx.database, 'ModelStreamCheckpoint');
    assert.ok(allCheckpointRows <= activeRequestsBeforeCancel * 64 + terminalRequestsBeforeCancel * 33);
    metrics.checkpointRowFormula = {
      rows: allCheckpointRows,
      activeRequests: activeRequestsBeforeCancel,
      terminalRequests: terminalRequestsBeforeCancel,
      limit: activeRequestsBeforeCancel * 64 + terminalRequestsBeforeCancel * 33
    };
    const concurrentTerminalRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'checkpoint-terminal-race'
    });
    const concurrentSocket = await openPendingProviderSocket(
      ctx,
      provider,
      concurrentTerminalRequest.modelRequestId,
      async () => {}
    );
    for (let seq = 1; seq <= 32; seq += 1) {
      const checkpoint = await provider.recordStreamEvent(
        concurrentTerminalRequest.modelRequestId,
        concurrentSocket.attemptSeq,
        concurrentSocket.socketGeneration,
        seq === 1
          ? { kind: 'output_delta', streamSeq: String(seq), content: `race-${seq}` }
          : { kind: 'output_item_done', streamSeq: String(seq), content: { item: seq } }
      );
      assert.equal(checkpoint.checkpointed, true);
    }
    let latePreparedResolve;
    const latePrepared = new Promise((resolve) => { latePreparedResolve = resolve; });
    let releaseLateResolve;
    const releaseLate = new Promise((resolve) => { releaseLateResolve = resolve; });
    let lateFaultInjected = false;
    const lateStore = storeFacade(ctx.store, {
      async prepare(...args) {
        const prepared = await ctx.store.prepare(...args);
        lateFaultInjected = true;
        latePreparedResolve();
        await releaseLate;
        return prepared;
      }
    });
    const lateProvider = new kernel.ModelProviderControlPlane(ctx.database, lateStore);
    const lateDeltaPromise = lateProvider.recordStreamEvent(
      concurrentTerminalRequest.modelRequestId,
      concurrentSocket.attemptSeq,
      concurrentSocket.socketGeneration,
      { kind: 'output_item_done', streamSeq: '33', content: { item: 'late-after-completed' } }
    );
    await latePrepared;
    const completedResult = await provider.recordStreamEvent(
      concurrentTerminalRequest.modelRequestId,
      concurrentSocket.attemptSeq,
      concurrentSocket.socketGeneration,
      { kind: 'completed', streamSeq: '34', content: { completed: true } }
    );
    assert.equal(completedResult.terminal, true);
    concurrentSocket.close();
    assert.equal((await concurrentSocket.settled).status, 'fulfilled');
    const contentRowsAfterCompleted = await countAll(ctx.database, 'ContentObject');
    releaseLateResolve();
    const lateDeltaResult = await lateDeltaPromise;
    assert.equal(lateFaultInjected, true);
    assert.equal(lateDeltaResult.ignoredReason, 'terminal');
    assert.equal(await countAll(ctx.database, 'ContentObject'), contentRowsAfterCompleted);
    const concurrentRows = await listAll(ctx.database, 'ModelStreamCheckpoint', {
      model_request_id: concurrentTerminalRequest.modelRequestId
    });
    const concurrentFence = (await list(ctx.database, 'ModelStreamFence', {
      model_request_id: concurrentTerminalRequest.modelRequestId
    }))[0];
    assert.ok(concurrentFence);
    assert.equal(concurrentRows.length, 33);
    assert.equal(concurrentRows.filter((row) => row.checkpoint_kind === 'terminal_summary').length, 1);
    const expectedRetainedCheckpointSeqs = Array.from({ length: 32 }, (_unused, index) => BigInt(index + 1));
    const actualRetainedCheckpointSeqs = concurrentRows
      .filter((row) => row.checkpoint_kind !== 'terminal_summary')
      .map((row) => row.stream_seq)
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    assert.deepEqual(actualRetainedCheckpointSeqs, expectedRetainedCheckpointSeqs);
    assert.ok(!concurrentRows.some((row) => row.stream_seq === 33n));
    for (const row of concurrentRows) {
      assert.equal(row.attempt_seq, concurrentFence.attempt_seq);
      assert.equal(row.socket_generation, concurrentFence.socket_generation);
    }
    const protectedCheckpoint = concurrentRows[0];
    const terminalSummaryCheckpoint = concurrentRows.find((row) => row.checkpoint_kind === 'terminal_summary');
    assert.throws(() => kernel.DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').delete(protectedCheckpoint.id), /fixed writer|terminal-fence/);
    await assert.rejects(ctx.database.transaction([{
      kind: 'delete', domain: 'ModelStreamCheckpoint', id: protectedCheckpoint.id
    }]), /fixed writer stream-finalization/);
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').insert({
        id: 'forbidden-generic-stream-checkpoint',
        model_request_id: concurrentTerminalRequest.modelRequestId,
        attempt_seq: concurrentFence.attempt_seq,
        socket_generation: concurrentFence.socket_generation,
        stream_seq: 999n,
        checkpoint_kind: 'output_delta',
        content_object_id: terminalSummaryCheckpoint.content_object_id,
        created_at: new Date().toISOString()
      })
    ]), /fixed writer modelStreamEvent/);
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelStreamFence').insert({
        id: 'forbidden-generic-stream-fence',
        model_request_id: capacityRequest.modelRequestId,
        attempt_seq: 1n,
        socket_generation: 1n,
        terminal_stream_seq: 999n,
        outcome: 'completed',
        created_at: new Date().toISOString()
      })
    ]), /fixed writer modelStreamEvent/);
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').pruneAfterTerminalFence(
        concurrentTerminalRequest.modelRequestId,
        concurrentFence.attempt_seq + 1n,
        concurrentFence.socket_generation,
        terminalSummaryCheckpoint.id
      )
    ]), /matching terminal fence identity/);
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').update(concurrentTerminalRequest.modelRequestId, {
        status: 'streaming', terminal_state: null, updated_at: new Date().toISOString()
      })
    ]), /cannot transition from terminal/);
    assert.ok(await get(ctx.database, 'ModelStreamCheckpoint', protectedCheckpoint.id));
    assertions.push('writer事务内Promise.all并发只保留首个delta；1 delta+32 item边界后semantic overflow有界合并且终态≤33；受控late-item在CAS发布后由Completed fence阻断且不留SQLite引用；终态精确保留当前attempt/socket固定32+summary；generic checkpoint/fence insert/delete、错误prune身份和terminal复活均被writer拒绝');

    const ignoredSignalRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'ignored-signal-cancel'
    });
    const ignoredSignalController = new AbortController();
    let ignoredSignalEnteredResolve;
    const ignoredSignalEntered = new Promise((resolve) => { ignoredSignalEnteredResolve = resolve; });
    let ignoredSignalReleaseResolve;
    const ignoredSignalRelease = new Promise((resolve) => { ignoredSignalReleaseResolve = resolve; });
    const ignoredSignalDispatch = provider.dispatch(ignoredSignalRequest.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest() {
        ignoredSignalEnteredResolve();
        await ignoredSignalRelease;
      }
    }, { signal: ignoredSignalController.signal });
    await ignoredSignalEntered;
    ignoredSignalController.abort();
    await Promise.race([
      assert.rejects(ignoredSignalDispatch, /cancelled/),
      rejectAfter(1000, 'adapter-ignoring-abort dispatch')
    ]);
    assert.equal((await get(ctx.database, 'ModelRequest', ignoredSignalRequest.modelRequestId)).status, 'terminal');
    ignoredSignalReleaseResolve();

    const reconnectCancelRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'cancel-vs-reconnect'
    });
    let reconnectCancelEnteredResolve;
    const reconnectCancelEntered = new Promise((resolve) => { reconnectCancelEnteredResolve = resolve; });
    let releaseReconnectCancelResolve;
    const releaseReconnectCancel = new Promise((resolve) => { releaseReconnectCancelResolve = resolve; });
    const reconnectCancelDatabase = databaseFacade(ctx.database, {
      async cancelCurrentModelRequest(input) {
        reconnectCancelEnteredResolve();
        await releaseReconnectCancel;
        return ctx.database.cancelCurrentModelRequest(input);
      }
    });
    const reconnectCancelProvider = new kernel.ModelProviderControlPlane(reconnectCancelDatabase, ctx.store);
    const reconnectCancelSocket = await openPendingProviderSocket(
      ctx,
      reconnectCancelProvider,
      reconnectCancelRequest.modelRequestId,
      async () => {}
    );
    const reconnectCancelPromise = reconnectCancelProvider.cancel(
      reconnectCancelRequest.modelRequestId,
      'cancelled-during-reconnect-race'
    );
    await reconnectCancelEntered;
    const reconnectedBeforeCancel = await openPendingProviderSocket(
      ctx,
      reconnectCancelProvider,
      reconnectCancelRequest.modelRequestId,
      async () => {},
      { reconnect: true }
    );
    assert.equal(reconnectedBeforeCancel.socketGeneration, '2');
    releaseReconnectCancelResolve();
    assert.equal(await reconnectCancelPromise, true);
    assert.equal((await reconnectCancelSocket.settled).status, 'rejected');
    assert.equal((await reconnectedBeforeCancel.settled).status, 'rejected');
    const reconnectCancelledRow = await get(ctx.database, 'ModelRequest', reconnectCancelRequest.modelRequestId);
    assert.equal(reconnectCancelledRow.status, 'terminal');
    assert.equal(reconnectCancelledRow.stream_stats_json.socketGeneration, '2');

    const retryCancelRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'cancel-vs-attempt-two'
    });
    let retryCancelEnteredResolve;
    const retryCancelEntered = new Promise((resolve) => { retryCancelEnteredResolve = resolve; });
    let releaseRetryCancelResolve;
    const releaseRetryCancel = new Promise((resolve) => { releaseRetryCancelResolve = resolve; });
    const retryCancelDatabase = databaseFacade(ctx.database, {
      async cancelCurrentModelRequest(input) {
        retryCancelEnteredResolve();
        await releaseRetryCancel;
        return ctx.database.cancelCurrentModelRequest(input);
      }
    });
    const retryCancelProvider = new kernel.ModelProviderControlPlane(retryCancelDatabase, ctx.store);
    let firstRetryEnteredResolve;
    const firstRetryEntered = new Promise((resolve) => { firstRetryEnteredResolve = resolve; });
    let releaseFirstRetryResolve;
    const releaseFirstRetry = new Promise((resolve) => { releaseFirstRetryResolve = resolve; });
    let secondRetryEnteredResolve;
    const secondRetryEntered = new Promise((resolve) => { secondRetryEnteredResolve = resolve; });
    const retryCancelDispatch = retryCancelProvider.dispatch(retryCancelRequest.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest(request) {
        if (request.attemptSeq === '1') {
          firstRetryEnteredResolve();
          await releaseFirstRetry;
          throw new kernel.ProviderTransientError('connection_interrupted', 'retry before cancellation');
        }
        secondRetryEnteredResolve();
        await new Promise(() => undefined);
      }
    });
    await firstRetryEntered;
    const retryCancelPromise = retryCancelProvider.cancel(
      retryCancelRequest.modelRequestId,
      'cancelled-after-attempt-two-admission'
    );
    await retryCancelEntered;
    releaseFirstRetryResolve();
    await secondRetryEntered;
    releaseRetryCancelResolve();
    assert.equal(await retryCancelPromise, true);
    await Promise.race([
      assert.rejects(retryCancelDispatch, /cancelled/),
      rejectAfter(1000, 'attempt-two cancellation dispatch')
    ]);
    const retryCancelledRow = await get(ctx.database, 'ModelRequest', retryCancelRequest.modelRequestId);
    assert.equal(retryCancelledRow.status, 'terminal');
    assert.equal(retryCancelledRow.stream_stats_json.attemptSeq, '2');

    const completedAbortRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'completed-before-abort'
    });
    const completedAbortController = new AbortController();
    const completedAbortResult = await provider.dispatch(completedAbortRequest.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest(_request, controls) {
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { completed: true } });
        completedAbortController.abort();
      }
    }, { signal: completedAbortController.signal });
    assert.equal(completedAbortResult.terminalState, 'completed');
    assert.equal((await get(ctx.database, 'ModelRequest', completedAbortRequest.modelRequestId)).terminal_state, 'completed');
    assert.equal(await provider.cancel(completedAbortRequest.modelRequestId, 'too-late-cancel'), false);

    const cancelledBeforeCompleted = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'cancel-before-completed'
    });
    const cancelledBeforeCompletedSocket = await openPendingProviderSocket(
      ctx,
      provider,
      cancelledBeforeCompleted.modelRequestId,
      async () => {}
    );
    assert.equal(await provider.cancel(cancelledBeforeCompleted.modelRequestId, 'cancelled-before-completed'), true);
    assert.equal((await cancelledBeforeCompletedSocket.settled).status, 'rejected');
    assert.equal((await provider.recordStreamEvent(
      cancelledBeforeCompleted.modelRequestId,
      cancelledBeforeCompletedSocket.attemptSeq,
      cancelledBeforeCompletedSocket.socketGeneration,
      { kind: 'completed', streamSeq: '1', content: { completed: 'late' } }
    )).ignoredReason, 'terminal');

    const cancelRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: await context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'cancel-request'
    });
    const controller = new AbortController();
    controller.abort();
    let cancelledExternalCalls = 0;
    await assert.rejects(provider.dispatch(cancelRequest.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest() { cancelledExternalCalls += 1; }
    }, { signal: controller.signal }), /cancelled/);
    assert.equal(cancelledExternalCalls, 0);
    assert.equal((await list(ctx.database, 'Attempt', {
      operation_id: (await list(ctx.database, 'Operation', {
        owner_kind: 'model_request', owner_id: cancelRequest.modelRequestId
      }))[0].id
    })).length, 1);
    const binaryRoot = await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'system',
      source: { sourceKind: 'system', sourceId: 'provider-non-utf8', sourceRevision: '0' },
      content: Uint8Array.from([0xff, 0xfe, 0xfd]),
      contentType: 'application/octet-stream'
    });
    const binaryRequest = await provider.createModelRequest({
      turnId: seeded.turnId,
      contextRootId: binaryRoot.rootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      recipe: {}, idempotencyKey: 'provider-reject-non-utf8'
    });
    let binaryExternalCalls = 0;
    await assert.rejects(provider.dispatch(binaryRequest.modelRequestId, {
      providerId: 'fake-local', async sendFullRequest() { binaryExternalCalls += 1; }
    }), /not valid UTF-8/);
    assert.equal(binaryExternalCalls, 0);
    assert.equal((await get(ctx.database, 'ModelRequest', binaryRequest.modelRequestId)).status, 'terminal');

    const terminalCommand = {
      source: { kind: 'callback', key: 'provider-turn-terminal-after-requests' },
      turnId: seeded.turnId,
      terminalStatus: 'completed',
      reason: 'all provider requests terminal'
    };
    await assert.rejects(controlAfterReopen.terminal(terminalCommand), /ModelRequestRepository transaction assertAll/);
    assert.equal((await get(ctx.database, 'Turn', seeded.turnId)).status, 'active');
    assert.equal(await provider.cancel(checkpointFaultRequest.modelRequestId, 'fault-fixture-complete'), true);
    assert.equal(await provider.cancel(nestedSuffixRequest.modelRequestId, 'nested-recipe-fixture-complete'), true);
    assert.equal(await provider.cancel(capacityRequest.modelRequestId, 'capacity-fixture-complete'), true);
    assert.equal((await capacitySocket.settled).status, 'rejected');
    assert.equal(await count(ctx.database, 'ModelStreamCheckpoint', {
      model_request_id: capacityRequest.modelRequestId
    }), 33);
    const finalRequests = await listAll(ctx.database, 'ModelRequest', {});
    const finalActiveRequests = finalRequests.filter((request) => request.status !== 'terminal').length;
    const finalTerminalRequests = finalRequests.filter((request) => request.status === 'terminal').length;
    const finalCheckpointRows = await countAll(ctx.database, 'ModelStreamCheckpoint');
    assert.ok(finalCheckpointRows <= finalActiveRequests * 64 + finalTerminalRequests * 33);
    metrics.finalCheckpointRowFormula = {
      rows: finalCheckpointRows,
      activeRequests: finalActiveRequests,
      terminalRequests: finalTerminalRequests,
      limit: finalActiveRequests * 64 + finalTerminalRequests * 33
    };
    assert.equal(finalActiveRequests, 0);
    await controlAfterReopen.terminal(terminalCommand);
    assert.equal((await get(ctx.database, 'Turn', seeded.turnId)).status, 'terminated');

    const edited = await controlAfterReopen.edit({
      source: { kind: 'command', key: 'provider-edit-current-message' },
      conversationId: seeded.conversationId,
      messageId: seeded.messageId,
      content: 'edited-current-message'
    });
    const editedSource = (await list(ctx.database, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: edited.messageRevisionId
    }))[0];
    assert.equal(editedSource.source_revision, 2n);
    const historicalAfterEdit = await provider.replay(created.modelRequestId);
    assert.deepEqual(historicalAfterEdit.context, frozenBefore.context);
    const currentAfterCompressedEdit = await context.materialize(
      await context.currentHeadRootId(seeded.conversationId)
    );
    const currentAfterCompressedEditText = currentAfterCompressedEdit.segments.map((segment) => segment.content.toString('utf8'));
    assert.ok(currentAfterCompressedEditText.includes('edited-current-message'));
    assert.ok(!currentAfterCompressedEditText.includes(seeded.inputContent));
    assert.ok(!currentAfterCompressedEditText.includes('PROVIDER-SUMMARY'));
    await controlAfterReopen.delete({
      source: { kind: 'command', key: 'provider-soft-delete' },
      conversationId: seeded.conversationId,
      messageId: seeded.messageId
    });
    const historicalAfterDelete = await provider.replay(created.modelRequestId);
    assert.deepEqual(historicalAfterDelete.context, frozenBefore.context);
    assert.deepEqual(historicalAfterDelete.recipe, frozenBefore.recipe);
    const currentAfterCompressedDelete = await context.materialize(
      await context.currentHeadRootId(seeded.conversationId)
    );
    const currentAfterCompressedDeleteText = currentAfterCompressedDelete.segments.map((segment) => segment.content.toString('utf8'));
    assert.ok(!currentAfterCompressedDeleteText.includes('edited-current-message'));
    assert.ok(!currentAfterCompressedDeleteText.includes(seeded.inputContent));
    assert.ok(!currentAfterCompressedDeleteText.includes('PROVIDER-SUMMARY'));
    assertions.push('Turn终止后，压缩来源Message edit/delete会在同事务结构化截断并重建current root；writer revision_seq与Context source一致；既有terminal projection仍字节级不变');
    assertions.push('Provider request-level cancel由writer原子命中最新reconnect/attempt2 identity；adapter永不settle也会立即收口；Completed与cancel durable first-wins一致；dispatch前Abort不外调；非UTF-8 frozen Context在外调前明确失败；全部终态checkpoint≤33后Turn才可终止，不扩展通用外部自动重试');

    const websocketSource = await fs.readFile(
      path.join(root, 'backend/capabilities/openAIResponsesWebSocketSession.ts'),
      'utf8'
    );
    const providerSource = await fs.readFile(path.join(root, 'backend/capabilities/llmProvider.ts'), 'utf8');
    const providerCapability = require(path.join(root, 'dist/extension/backend/capabilities/llmProvider.js'));
    const productRuntimeSource = await fs.readFile(
      path.join(root, 'backend/application/reliableKernel/VscodeReliableKernelProductRuntime.ts'),
      'utf8'
    );
    for (const phase of [
      'lock_wait', 'lock_acquired', 'socket_opening', 'socket_reused', 'socket_opened',
      'send_started', 'request_sent', 'first_raw_event', 'first_semantic_event', 'terminal', 'timeout'
    ]) {
      assert.match(websocketSource, new RegExp(`['"]${phase}['"]`));
    }
    assert.match(providerSource, /phase:\s*['"]continuation_decision['"]/);
    assert.match(productRuntimeSource, /eventKind:\s*['"]provider\.transport\.phase['"]/);
    assert.match(productRuntimeSource, /sessionKeyHash/);
    assert.doesNotMatch(productRuntimeSource.match(/onTransportTrace:[\s\S]*?resolveAttachment:/)?.[0] ?? '', /headers|prompt|arguments|toolResult/);
    const websocketSettings = {
      id: 'provider-session-scope',
      baseUrl: 'https://provider.example/v1',
      model: 'model-session-scope'
    };
    const conversationAKey = providerCapability.createOpenAIResponsesWebSocketSessionKey(
      websocketSettings,
      'conversation-a'
    );
    assert.equal(
      conversationAKey,
      providerCapability.createOpenAIResponsesWebSocketSessionKey(websocketSettings, ' conversation-a ')
    );
    assert.notEqual(
      conversationAKey,
      providerCapability.createOpenAIResponsesWebSocketSessionKey(websocketSettings, 'conversation-b')
    );
    assert.throws(
      () => providerCapability.createOpenAIResponsesWebSocketSessionKey(websocketSettings, ''),
      /require a non-empty conversationId/
    );
    assertions.push('OpenAI Responses WS把lock/socket/send/first raw/first semantic/terminal/timeout及continuation decision以无正文元数据写入滚动诊断；下一次无首事件可区分本地排队、发送与Relay等待');
    assertions.push('OpenAI Responses WS session key按Conversation稳定隔离，并拒绝缺失conversationId时回退为全局共享锁');

    return { assertions, faults, metrics };
  });
}

async function checkImmutableReplacement() {
  return withRuntime('compression-replacement', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const seeded = await seedTurn(ctx, 'replacement', { thresholdTokens: 2 });
    const context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    for (let index = 0; index < 5; index += 1) {
      const projected = runtimeDeliveryFixture(
        `replacement-${index}`,
        seeded.turnId,
        `replacement-original-${index}`
      );
      await context.appendContent({
        conversationId: seeded.conversationId,
        segmentKind: 'runtime_context',
        source: { sourceKind: 'runtime_context', sourceId: `replacement-${index}`, sourceRevision: '0' },
        content: projected.content,
        contentType: projected.contentType
      });
    }
    const sourceRootId = await context.currentHeadRootId(seeded.conversationId);
    const compression = new kernel.ContextCompressionControlPlane(ctx.database, ctx.store);
    const first = await compression.create({
      conversationId: seeded.conversationId,
      headRootId: sourceRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      compressSegmentCount: 4,
      title: 'old title',
      summary: 'OLD-SUMMARY',
      idempotencyKey: 'first-block'
    });
    const oldBlockBefore = await get(ctx.database, 'CompressionBlock', first.compressionBlockId);
    const oldRootBefore = await get(ctx.database, 'ContextSequenceRoot', first.rootId);
    const oldProjectionBefore = await get(ctx.database, 'ModelContextProjection', first.projectionId);
    const oldSourcesBefore = await listAll(ctx.database, 'CompressionBlockSource', {
      compression_block_id: first.compressionBlockId
    });
    const oldSummaryMetadata = await get(ctx.database, 'ContentObject', oldBlockBefore.summary_object_id);
    const oldSummaryBytes = await ctx.store.read(oldSummaryMetadata);
    const immutableBefore = immutableCompressionFields(oldBlockBefore);
    const oldMaterializedBefore = await context.materialize(first.rootId);
    const oldTailSegmentIds = oldMaterializedBefore.segments.slice(1).map((segment) => segment.segmentId);

    const replacementCommand = {
      conversationId: seeded.conversationId,
      previousBlockId: first.compressionBlockId,
      expectedHeadRootId: first.rootId,
      title: 'new title',
      summary: 'NEW-SUMMARY',
      previousStatus: 'disabled',
      idempotencyKey: 'replacement-one'
    };
    const replacement = await compression.replace(replacementCommand);
    const oldBlockAfter = await get(ctx.database, 'CompressionBlock', first.compressionBlockId);
    assert.equal(oldBlockAfter.status, 'disabled');
    assert.deepEqual(immutableCompressionFields(oldBlockAfter), immutableBefore);
    assert.deepEqual(await get(ctx.database, 'ContextSequenceRoot', first.rootId), oldRootBefore);
    assert.deepEqual(await get(ctx.database, 'ModelContextProjection', first.projectionId), oldProjectionBefore);
    assert.deepEqual(await listAll(ctx.database, 'CompressionBlockSource', {
      compression_block_id: first.compressionBlockId
    }), oldSourcesBefore);
    assert.deepEqual(await ctx.store.read(oldSummaryMetadata), oldSummaryBytes);
    assert.notEqual(replacement.compressionBlockId, first.compressionBlockId);
    assert.notEqual(replacement.rootId, first.rootId);
    const current = await context.materialize(replacement.rootId);
    assert.equal(current.segments[0].content.toString('utf8'), 'NEW-SUMMARY');
    assert.deepEqual(current.segments.slice(1).map((segment) => segment.segmentId), oldTailSegmentIds);
    const replacementSources = await listAll(ctx.database, 'CompressionBlockSource', {
      compression_block_id: replacement.compressionBlockId
    });
    assert.deepEqual(
      replacementSources.sort((a, b) => Number(a.position - b.position)).map((row) => [row.segment_id, row.position]),
      [...oldSourcesBefore].sort((a, b) => Number(a.position - b.position)).map((row) => [row.segment_id, row.position])
    );
    const replacementBlock = await get(ctx.database, 'CompressionBlock', replacement.compressionBlockId);
    const replacementProjection = await get(ctx.database, 'ModelContextProjection', replacement.projectionId);
    assert.equal(replacementProjection.purpose, 'compression-replacement-source:disabled');
    assert.equal((await ctx.store.read(await get(ctx.database, 'ContentObject', replacementBlock.title_object_id))).toString('utf8'), 'new title');
    assert.equal((await ctx.store.read(await get(ctx.database, 'ContentObject', replacementBlock.summary_object_id))).toString('utf8'), 'NEW-SUMMARY');
    const rowsBeforeExactRetry = Object.fromEntries(await Promise.all([
      'CompressionBlock', 'CompressionBlockSource', 'ContextSegment', 'ContextSequenceNode',
      'ContextSequenceRoot', 'ModelContextProjection', 'ContentObject'
    ].map(async (domain) => [domain, await countAll(ctx.database, domain)])));
    const casBeforeExactRetry = await casFileCount(ctx.binding.paths.casRootPath);
    const commitBeforeExactRetry = (await ctx.database.inspect()).currentCommitSeq;
    const headBeforeExactRetry = await context.currentHeadRootId(seeded.conversationId);
    const oldBlockRowBeforeExactRetry = await get(ctx.database, 'CompressionBlock', first.compressionBlockId);
    const replacementBlockRowBeforeExactRetry = await get(ctx.database, 'CompressionBlock', replacement.compressionBlockId);
    const replacementRetry = await compression.replace(replacementCommand);
    assert.equal(replacementRetry.deduplicated, true);
    assert.equal(replacementRetry.compressionBlockId, replacement.compressionBlockId);
    assert.equal(replacementRetry.rootId, replacement.rootId);
    for (const [domain, countBefore] of Object.entries(rowsBeforeExactRetry)) {
      assert.equal(await countAll(ctx.database, domain), countBefore, `${domain} exact replacement replay growth`);
    }
    assert.equal(await casFileCount(ctx.binding.paths.casRootPath), casBeforeExactRetry);
    assert.equal((await ctx.database.inspect()).currentCommitSeq, commitBeforeExactRetry);
    assert.equal(await context.currentHeadRootId(seeded.conversationId), headBeforeExactRetry);
    assert.deepEqual(await get(ctx.database, 'CompressionBlock', first.compressionBlockId), oldBlockRowBeforeExactRetry);
    assert.deepEqual(
      await get(ctx.database, 'CompressionBlock', replacement.compressionBlockId),
      replacementBlockRowBeforeExactRetry
    );
    await assert.rejects(compression.replace({
      ...replacementCommand,
      summary: 'CONFLICTING-SUMMARY'
    }), (error) => error?.code === 'COMPRESSION_IDEMPOTENCY_CONFLICT');
    assert.equal(await casFileCount(ctx.binding.paths.casRootPath), casBeforeExactRetry);
    await assert.rejects(compression.replace({
      ...replacementCommand,
      previousStatus: 'soft_deleted'
    }), (error) => error?.code === 'COMPRESSION_IDEMPOTENCY_CONFLICT');
    assert.equal((await ctx.database.inspect()).currentCommitSeq, commitBeforeExactRetry);
    assert.equal(await casFileCount(ctx.binding.paths.casRootPath), casBeforeExactRetry);
    assert.deepEqual(await get(ctx.database, 'CompressionBlock', first.compressionBlockId), oldBlockRowBeforeExactRetry);
    assertions.push('title/summary修改创建新block/segment/root/projection；previousStatus disposition显式持久化在immutable projection purpose；完整finite tail与source positions原样保留；exact retry保持commit/head/行/CAS零写入；same key的summary或previousStatus变化均明确冲突；旧历史字节级不变');

    assert.throws(() => kernel.DOMAIN_REPOSITORIES.domain('CompressionBlock').update(first.compressionBlockId, {
      summary_object_id: oldBlockBefore.summary_object_id
    }), /immutable/);
    assert.throws(() => kernel.DOMAIN_REPOSITORIES.domain('CompressionBlock').update(first.compressionBlockId, {
      title_object_id: oldBlockBefore.title_object_id
    }), /immutable/);
    for (const status of ['enabled', 'disabled', 'soft_deleted']) {
      await compression.updateStatus(first.compressionBlockId, status);
      const statusOnly = await get(ctx.database, 'CompressionBlock', first.compressionBlockId);
      assert.equal(statusOnly.status, status);
      assert.deepEqual(immutableCompressionFields(statusOnly), immutableBefore);
    }
    const replayAfterLaterStatusChange = await compression.replace(replacementCommand);
    assert.equal(replayAfterLaterStatusChange.deduplicated, true);
    assert.equal(replayAfterLaterStatusChange.compressionBlockId, replacement.compressionBlockId);
    assertions.push('Repository拒绝原地修改CompressionBlock title/summary；enable/disable/soft-delete实测只改变status；后续status变化也不会破坏已提交replacement的exact replay');

    const partialRaceSeed = await seedTurn(ctx, 'compression-partial-content-race', { thresholdTokens: 1 });
    const partialRaceRoot = await context.currentHeadRootId(partialRaceSeed.conversationId);
    let firstPreparedContent;
    let partialPrepareCount = 0;
    const partialRaceStore = storeFacade(ctx.store, {
      async prepare(...args) {
        const prepared = await ctx.store.prepare(...args);
        partialPrepareCount += 1;
        if (partialPrepareCount === 1) firstPreparedContent = prepared;
        if (partialPrepareCount === 2 && firstPreparedContent?.insert) {
          await ctx.database.transaction([firstPreparedContent.insert]);
        }
        return prepared;
      }
    });
    const partialRaceCompression = new kernel.ContextCompressionControlPlane(ctx.database, partialRaceStore);
    const partialRaceResult = await partialRaceCompression.create({
      conversationId: partialRaceSeed.conversationId,
      headRootId: partialRaceRoot,
      authoritySnapshotId: partialRaceSeed.authoritySnapshotId,
      compressSegmentCount: 1,
      title: 'PARTIAL-CONTENT-RACE-TITLE',
      summary: 'PARTIAL-CONTENT-RACE-SUMMARY',
      idempotencyKey: 'partial-content-race'
    });
    assert.equal(partialPrepareCount, 2);
    assert.ok(firstPreparedContent?.insert, 'partial ContentObject race must inject the first insert');
    const partialRaceBlock = await get(ctx.database, 'CompressionBlock', partialRaceResult.compressionBlockId);
    assert.equal((await ctx.store.read(await get(
      ctx.database, 'ContentObject', partialRaceBlock.summary_object_id
    ))).toString('utf8'), 'PARTIAL-CONTENT-RACE-SUMMARY');
    assertions.push('title ContentObject在prepare后被并发提交、summary仍未提交时，每个ContentObject独立savepoint保证compression仍完整提交，不会整批跳过summary');

    const coordinatorPolicy = {
      enabled: true,
      binding: { kind: 'provider', id: 'compression-binding-fixture' },
      methodKind: 'deterministic_summary',
      thresholdTokens: 2,
      trigger: {
        mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 2
      },
      provider: {
        providerConfigId: 'fake-local', provider: 'openai-compatible', modelId: 'fake-model',
        contextWindowTokens: 200_000, maxOutputTokens: 16_000
      },
      config: {
        id: 'compression-config-fixture', name: 'fixture', kind: 'deterministic_summary',
        trigger: {
          mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 2
        },
        createdAt: 1, updatedAt: 1
      }
    };
    const coordinatorSeed = await seedTurn(ctx, 'compression-coordinator', {
      thresholdTokens: 2,
      compressionPolicy: coordinatorPolicy
    });
    const coordinatorAttachment = {
      attachmentId: 'attachment-compression-coordinator',
      name: 'coordinator.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4_096
    };
    const coordinatorModelProvider = new kernel.ModelProviderControlPlane(ctx.database, ctx.store);
    const observedProjectionRootId = await context.currentHeadRootId(coordinatorSeed.conversationId);
    const observedRequest = await coordinatorModelProvider.createModelRequest({
      turnId: coordinatorSeed.turnId,
      contextRootId: observedProjectionRootId,
      authoritySnapshotId: coordinatorSeed.authoritySnapshotId,
      recipe: { kind: 'provider-observed-compression-fixture' },
      projectedEstimatedTokens: 1,
      idempotencyKey: 'provider-observed-compression-fixture'
    });
    await coordinatorModelProvider.dispatch(observedRequest.modelRequestId, {
      providerId: 'fake-local',
      async sendFullRequest(_request, controls) {
        await controls.onEvent({
          kind: 'completed',
          streamSeq: '1',
          content: { type: 'provider-observed-compression-fixture' },
          usage: { promptTokenCount: 20, totalTokenCount: 24 }
        });
      }
    });
    const observedMessageContent = JSON.stringify({
      role: 'model',
      parts: [{ text: `coordinator-message-0-${'x'.repeat(256)}` }]
    });
    await new kernel.TurnOutputControlPlane(ctx.database, ctx.store).appendAssistantMessage({
      turnId: coordinatorSeed.turnId,
      modelRequestId: observedRequest.modelRequestId,
      sourceKey: observedRequest.modelRequestId,
      content: observedMessageContent,
      contentType: 'application/vnd.limcode.message+json'
    });
    for (let index = 1; index < 4; index += 1) {
      const role = index % 2 === 0 ? 'assistant' : 'user';
      const attachmentMessage = index === 1
        ? JSON.stringify({
            role: 'user',
            parts: [{
              text: `coordinator-message-${index}`
            }, {
              inlineData: {
                ...coordinatorAttachment,
                sha256: 'e'.repeat(64),
                sourcePath: '/private/coordinator.pdf',
                storage: 'managed',
                status: 'available'
              }
            }]
          })
        : `coordinator-message-${index}-${'x'.repeat(256)}`;
      const appended = await appendMessageContextFixture(
        ctx,
        coordinatorSeed,
        `compression-coordinator-${index}`,
        role,
        attachmentMessage,
        index === 1 ? 'application/vnd.limcode.message+json' : 'text/plain'
      );
      if (index === 1) {
        const now = new Date().toISOString();
        await ctx.database.transaction([
          kernel.DOMAIN_REPOSITORIES.domain('Attachment').insert({
            id: coordinatorAttachment.attachmentId,
            sha256: 'e'.repeat(64),
            byte_length: BigInt(coordinatorAttachment.sizeBytes),
            mime_type: coordinatorAttachment.mimeType,
            name: coordinatorAttachment.name,
            storage_mode: 'managed',
            content_object_id: null,
            created_at: now
          }),
          kernel.DOMAIN_REPOSITORIES.domain('AttachmentLink').insert({
            id: 'attachment-link-compression-coordinator',
            message_revision_id: appended.revisionId,
            attachment_id: coordinatorAttachment.attachmentId,
            position: 0n,
            created_at: now
          })
        ]);
      }
    }
    const coordinatorHead = await context.currentHeadRootId(coordinatorSeed.conversationId);
    const coordinatorObservationProfile = kernel.attachmentObservationAnalysisProfileSha256(
      coordinatorPolicy.provider
    );
    const coordinatorObservationRequirement = {
      attachmentRef: 'F1',
      attachmentId: coordinatorAttachment.attachmentId,
      name: coordinatorAttachment.name,
      mimeType: coordinatorAttachment.mimeType,
      sizeBytes: coordinatorAttachment.sizeBytes
    };
    const coordinatorObservation = {
      attachmentRef: 'F1',
      summary: 'Coordinator PDF contains one durable visual fact.',
      salientFacts: ['The PDF observation is reusable.'],
      uncertainties: []
    };
    const coordinatorObservationState = kernel.renderAttachmentObservationStateContent(
      [coordinatorObservationRequirement],
      [coordinatorObservation]
    );
    let compactDispatches = 0;
    let frozenCompressionBlockId;
    const coordinator = new kernel.ReliableContextCompressionCoordinator(
      ctx.database,
      ctx.store,
      coordinatorModelProvider,
      {
        resolve(providerId) {
          return {
            providerId,
            async sendFullRequest(request, controls) {
              compactDispatches += 1;
              assert.equal(request.recipe.kind, 'reliable-context-compression');
              assert.equal(request.recipe.requestKind, 'context_compression_pre');
              assert.equal(request.recipe.sourceSegmentCount, 4);
              assert.equal(request.context.length, 4);
              assert.deepEqual(request.recipe.attachmentCatalogState.catalog, [coordinatorAttachment]);
              assert.deepEqual(request.recipe.attachmentCatalogState.placements.map((placement) => ({
                kind: placement.kind,
                entries: placement.entries
              })), [{
                kind: 'attachment_catalog_delta',
                entries: [coordinatorAttachment]
              }]);
              assert.deepEqual(request.attachmentCatalogState, request.recipe.attachmentCatalogState);
              assert.equal(request.recipe.attachmentObservationProfileSha256, coordinatorObservationProfile);
              assert.deepEqual(
                request.recipe.attachmentObservationRequirements,
                [coordinatorObservationRequirement]
              );
              frozenCompressionBlockId = request.recipe.blockId;
              await controls.onEvent({
                kind: 'completed',
                streamSeq: '1',
                content: {
                  type: 'compression_result',
                  contents: [
                    {
                      role: 'model',
                      parts: [{ text: 'STRUCTURED-SUMMARY-CONTENT' }]
                    },
                    coordinatorObservationState
                  ],
                  attachmentObservationProfileSha256: coordinatorObservationProfile,
                  attachmentObservations: [coordinatorObservation]
                },
                usage: { promptTokenCount: 77, totalTokenCount: 91 }
              });
            }
          };
        }
      }
    );
    const coordinatorRequestBudget = kernel.calculateFullRequestPlanningBudget({
      contextWindowTokens: 200_000,
      maxOutputTokens: 16_000,
      compressionThresholdTokens: 2,
      breakdown: {
        systemTokens: 0, toolSchemaTokens: 0, providerFramingTokens: 0,
        contextTokens: 1, currentInputTokens: 0, runtimeDeliveryTokens: 0,
        turnReminderTokens: 0, mediaTokens: 0, fixedTokens: 0,
        bodyTokens: 1, fullTokens: 1
      }
    });
    assert.ok(
      coordinatorRequestBudget.estimatedFullInputTokens < coordinatorRequestBudget.compressionThresholdTokens,
      'fixture must keep the ordinary-request estimate below the configured threshold'
    );
    const coordinatorCompression = new kernel.ContextCompressionControlPlane(ctx.database, ctx.store);
    const coordinatorDecision = await coordinatorCompression.evaluate(
      coordinatorHead,
      coordinatorSeed.authoritySnapshotId
    );
    assert.equal(coordinatorDecision.shouldCompress, true);
    assert.equal(coordinatorDecision.source, 'provider-observed-delta');
    const localOnlyPolicy = {
      ...coordinatorPolicy,
      thresholdTokens: 100_000,
      trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 100_000 },
      config: {
        ...coordinatorPolicy.config,
        id: 'compression-config-local-estimate-only',
        trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 100_000 }
      }
    };
    const localOnlySeed = await seedTurn(ctx, 'compression-local-estimate-only', {
      thresholdTokens: 100_000,
      compressionPolicy: localOnlyPolicy
    });
    const localOnlyHead = await context.currentHeadRootId(localOnlySeed.conversationId);
    const localOnlyBudget = kernel.calculateFullRequestPlanningBudget({
      contextWindowTokens: 200_000,
      maxOutputTokens: 16_000,
      compressionThresholdTokens: 100_000,
      breakdown: {
        systemTokens: 0, toolSchemaTokens: 0, providerFramingTokens: 0,
        contextTokens: 100_000, currentInputTokens: 0, runtimeDeliveryTokens: 0,
        turnReminderTokens: 0, mediaTokens: 0, fixedTokens: 0,
        bodyTokens: 100_000, fullTokens: 100_000
      }
    });
    assert.ok(localOnlyBudget.estimatedFullInputTokens >= localOnlyBudget.compressionThresholdTokens);
    const localOnlyResult = await coordinator.coordinate({
      turnId: localOnlySeed.turnId,
      authoritySnapshotId: localOnlySeed.authoritySnapshotId,
      headRootId: localOnlyHead,
      trigger: 'auto',
      requestBudget: localOnlyBudget
    });
    assert.equal(localOnlyResult.status, 'skipped');
    assert.equal(localOnlyResult.reason, 'below_threshold');
    assert.equal(compactDispatches, 0);
    const coordinated = await coordinator.coordinate({
      turnId: coordinatorSeed.turnId,
      authoritySnapshotId: coordinatorSeed.authoritySnapshotId,
      headRootId: coordinatorHead,
      trigger: 'auto',
      requestBudget: coordinatorRequestBudget
    });
    assert.equal(coordinated.status, 'compressed');
    assert.equal(coordinated.sourceSegmentCount, 4);
    assert.equal(compactDispatches, 1);
    assert.equal(frozenCompressionBlockId, coordinated.result.compressionBlockId);
    const coordinatedReplay = await coordinator.coordinate({
      turnId: coordinatorSeed.turnId,
      authoritySnapshotId: coordinatorSeed.authoritySnapshotId,
      headRootId: coordinatorHead,
      trigger: 'auto',
      requestBudget: coordinatorRequestBudget
    });
    assert.equal(coordinatedReplay.status, 'compressed');
    assert.equal(coordinatedReplay.result.deduplicated, true);
    assert.equal(coordinatedReplay.modelRequestId, coordinated.modelRequestId);
    assert.equal(compactDispatches, 1);
    const coordinatedRequest = await get(ctx.database, 'ModelRequest', coordinated.modelRequestId);
    assert.equal(coordinatedRequest.status, 'terminal');
    assert.equal(coordinatedRequest.terminal_state, 'completed');
    const coordinatedOperation = (await list(ctx.database, 'Operation', {
      owner_kind: 'model_request', owner_id: coordinated.modelRequestId
    }))[0];
    const coordinatedAttempts = await list(ctx.database, 'Attempt', { operation_id: coordinatedOperation.id });
    assert.equal(coordinatedAttempts.length, 1);
    assert.equal(coordinatedAttempts[0].status, 'completed');
    const coordinatedBlock = await get(ctx.database, 'CompressionBlock', coordinated.result.compressionBlockId);
    const structuredMetadata = await get(ctx.database, 'ContentObject', coordinatedBlock.summary_object_id);
    assert.equal(structuredMetadata.content_type, kernel.CONTENT_TYPE_COMPRESSION_CONTENTS);
    const structuredCompression = JSON.parse((await ctx.store.read(structuredMetadata)).toString('utf8'));
    assert.equal(structuredCompression.attachmentCatalog, undefined);
    assert.equal(
      structuredCompression.estimatedTokens,
      kernel.estimateMessageContentsTokens(structuredCompression.contents)
    );
    assert.equal(structuredCompression.trigger, 'auto');
    assert.equal(structuredCompression.triggerReason, 'configured_threshold');
    assert.equal(structuredCompression.triggerTokens, coordinatorDecision.estimatedTokens);
    assert.equal(structuredCompression.triggerTokenSource, coordinatorDecision.source);
    assert.equal(structuredCompression.configuredThresholdTokens, 2);
    assert.equal(structuredCompression.estimatedTokensBefore, 1);
    assert.equal(structuredCompression.providerInputTokens, 77);
    assert.equal(structuredCompression.methodKind, 'deterministic_summary');
    assert.deepEqual(structuredCompression.contents, [
      { role: 'model', parts: [{ text: 'STRUCTURED-SUMMARY-CONTENT' }] },
      coordinatorObservationState
    ]);
    const coordinatorObservationLinks = await list(ctx.database, 'AttachmentObservationLink', {
      attachment_id: coordinatorAttachment.attachmentId,
      analysis_profile_sha256: coordinatorObservationProfile
    });
    assert.equal(coordinatorObservationLinks.length, 1);
    const coordinatorBlockObservationLinks = await list(ctx.database, 'CompressionBlockObservationLink', {
      compression_block_id: coordinated.result.compressionBlockId
    });
    assert.equal(coordinatorBlockObservationLinks.length, 1);
    assert.equal(
      coordinatorBlockObservationLinks[0].observation_id,
      coordinatorObservationLinks[0].id
    );
    const coordinatedMaterialized = await context.materialize(coordinated.result.rootId);
    assert.equal(coordinatedMaterialized.segments.length, 2);
    assert.equal(coordinatedMaterialized.segments[0].segmentKind, 'compression');
    const coordinatedAttachmentState = await new kernel.AttachmentCatalogProjection(ctx.database).projectState(
      coordinatorSeed.conversationId,
      coordinatedMaterialized.segments.map((segment) => ({ segmentId: segment.segmentId }))
    );
    assert.deepEqual(coordinatedAttachmentState.catalog, [coordinatorAttachment]);
    assert.deepEqual(coordinatedAttachmentState.placements, [{
      kind: 'attachment_catalog_checkpoint',
      afterSegmentId: coordinatedMaterialized.segments[0].segmentId,
      entries: [coordinatorAttachment]
    }]);
    let adapterCompactRequest;
    let adapterStartRequest;
    const capabilityAdapter = new kernel.LlmCapabilityFullRequestAdapter('fake-local', {
      compact(request, emit) {
        adapterCompactRequest = request;
        emit({
          type: 'llm:compactDone',
          payload: {
            requestId: request.id,
            blockId: request.blockId,
            conversationId: request.conversationId,
            result: { contents: [{ role: 'model', parts: [{ text: 'ADAPTER-COMPACTED' }] }] },
            completedAt: Date.now()
          }
        });
      },
      start(request, emit) {
        adapterStartRequest = request;
        emit({ type: 'llm:done', payload: { requestId: request.id, usageMetadata: { totalTokenCount: 1 } } });
      },
      abort() {}, cancelRetry() {}, dispose() {},
      resolveInvocation() {},
      async dryRun() { throw new Error('unused'); },
      async dryRunCompact() { throw new Error('unused'); },
      async listModels() { return []; }
    });
    const adapterAuthority = {
      kind: 'effective-turn-authority',
      conversationId: coordinatorSeed.conversationId,
      model: { providerConfigId: 'fake-local', provider: 'openai-compatible', modelId: 'fake-model' },
      toolPolicy: { allowedTools: [], preset: 'custom', sourceConfigs: {} },
      compression: {
        ...coordinatorPolicy,
        methodKind: 'segmented_summary',
        config: {
          ...coordinatorPolicy.config,
          kind: 'segmented_summary',
          llmSummary: { providerConfigId: 'fake-local', model: 'fake-model', targetTokens: 256 }
        }
      }
    };
    const structuredContent = JSON.stringify({
      kind: 'compression_contents', version: 1,
      contents: [{ role: 'model', parts: [{ text: 'PRIOR-STRUCTURED' }] }]
    });
    const compactEvents = [];
    await capabilityAdapter.sendFullRequest({
      kind: 'full-model-request', modelRequestId: 'adapter-compact',
      conversationId: coordinatorSeed.conversationId, attemptSeq: '1', socketGeneration: '1',
      providerId: 'fake-local', modelId: 'fake-model', authoritySnapshot: adapterAuthority,
      attachmentCatalogState: { catalog: [], placements: [] },
      recipe: {
        kind: 'reliable-context-compression', sourceSegmentCount: 2, compressionMethodKind: 'segmented_summary',
        blockId: 'adapter-block', sourceHash: 'adapter-source', effectiveSummaryMaxTokens: 256
      },
      context: [
        {
          segmentId: 'adapter-summary', segmentKind: 'compression', messageRole: null,
          contentType: kernel.CONTENT_TYPE_COMPRESSION_CONTENTS, content: structuredContent
        },
        {
          segmentId: 'adapter-user', segmentKind: 'message', messageRole: 'user',
          contentType: 'application/vnd.limcode.message+json',
          content: JSON.stringify({ role: 'user', parts: [{ text: 'TAIL-USER' }] })
        },
        {
          segmentId: 'adapter-excluded', segmentKind: 'runtime_context', messageRole: null,
          contentType: 'text/plain', content: 'MUST-NOT-COMPACT'
        }
      ]
    }, {
      async onEvent(event) { compactEvents.push(event); return { accepted: true, checkpointed: true, terminal: true }; }
    });
    assert.deepEqual(adapterCompactRequest.contents, [
      { role: 'user', parts: [{ text: 'TAIL-USER' }] }
    ]);
    assert.equal(adapterCompactRequest.conversationId, coordinatorSeed.conversationId);
    assert.equal(adapterCompactRequest.priorSummaryContents[0].parts[0].text, 'PRIOR-STRUCTURED');
    assert.equal(compactEvents.length, 1);
    assert.equal(compactEvents[0].kind, 'completed');
    assert.equal(compactEvents[0].content.type, 'compression_result');
    const ordinaryEvents = [];
    await capabilityAdapter.sendFullRequest({
      kind: 'full-model-request', modelRequestId: 'adapter-ordinary',
      conversationId: coordinatorSeed.conversationId, attemptSeq: '1', socketGeneration: '1',
      providerId: 'fake-local', modelId: 'fake-model', authoritySnapshot: adapterAuthority,
      attachmentCatalogState: { catalog: [], placements: [] },
      recipe: { kind: 'reliable-agent-turn', round: '1', tools: [] },
      context: [{
        segmentId: 'adapter-summary', segmentKind: 'compression', messageRole: null,
        contentType: kernel.CONTENT_TYPE_COMPRESSION_CONTENTS, content: structuredContent
      }]
    }, {
      async onEvent(event) { ordinaryEvents.push(event); return { accepted: true, checkpointed: true, terminal: true }; }
    });
    assert.deepEqual(adapterStartRequest.contents, [
      { role: 'model', parts: [{ text: 'PRIOR-STRUCTURED' }] }
    ]);
    assert.equal(adapterStartRequest.conversationId, coordinatorSeed.conversationId);
    assert.equal(ordinaryEvents.at(-1).kind, 'completed');
    const manualPolicy = {
      ...coordinatorPolicy,
      binding: { kind: 'provider', id: 'manual-compression-binding' },
      thresholdTokens: 100000,
      trigger: {
        mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 100000
      },
      config: {
        ...coordinatorPolicy.config,
        id: 'manual-compression-config',
        trigger: {
          mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 100000
        }
      }
    };
    const manualSeed = await seedTurn(ctx, 'manual-compression-coordinator', {
      thresholdTokens: 100000,
      compressionPolicy: manualPolicy
    });
    await appendMessageContextFixture(
      ctx, manualSeed, 'manual-compression-large-source', 'assistant', `manual-large-source-${'x'.repeat(2048)}`
    );
    await appendMessageContextFixture(
      ctx, manualSeed, 'manual-compression-tail', 'assistant', 'manual-tail-message'
    );
    const manualModelProvider = new kernel.ModelProviderControlPlane(ctx.database, ctx.store);
    let manualDispatches = 0;
    const manualCoordinator = new kernel.ReliableContextCompressionCoordinator(
      ctx.database,
      ctx.store,
      manualModelProvider,
      {
        resolve(providerId) {
          return {
            providerId,
            async sendFullRequest(request, controls) {
              manualDispatches += 1;
              assert.equal(request.recipe.requestKind, 'context_compression_manual');
              await controls.onEvent({
                kind: 'completed', streamSeq: '1',
                content: {
                  type: 'compression_result',
                  contents: [{ role: 'user', parts: [{ text: 'MANUAL-BELOW-THRESHOLD' }] }]
                }
              });
            }
          };
        }
      }
    );
    const manualHead = await context.currentHeadRootId(manualSeed.conversationId);
    const autoAgainstManualPolicy = await manualCoordinator.coordinate({
      turnId: manualSeed.turnId,
      authoritySnapshotId: manualSeed.authoritySnapshotId,
      headRootId: manualHead,
      trigger: 'auto'
    });
    assert.deepEqual(autoAgainstManualPolicy, { status: 'skipped', reason: 'manual_only' });
    const manualBelowThreshold = await manualCoordinator.manualCurrentTurn({
      turnId: manualSeed.turnId,
      compressSegmentCount: 2,
      title: 'Manual below threshold fixture'
    });
    assert.equal(manualBelowThreshold.status, 'compressed');
    assert.equal(manualBelowThreshold.sourceSegmentCount, 2);
    assert.equal(manualDispatches, 1);
    assert.equal((await context.materialize(manualBelowThreshold.result.rootId)).segments.length, 2);

    const nonReducingPolicy = {
      ...coordinatorPolicy,
      binding: { kind: 'provider', id: 'non-reducing-compression-binding' },
      thresholdTokens: 1,
      trigger: {
        mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 1
      },
      config: {
        ...coordinatorPolicy.config,
        id: 'non-reducing-compression-config',
        trigger: {
          mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 1
        }
      }
    };
    const nonReducingSeed = await seedTurn(ctx, 'non-reducing-compression', {
      thresholdTokens: 1,
      compressionPolicy: nonReducingPolicy
    });
    await appendMessageContextFixture(ctx, nonReducingSeed, 'non-reducing-source', 'assistant', 'small-source');
    await appendMessageContextFixture(ctx, nonReducingSeed, 'non-reducing-tail', 'user', 'protected-tail');
    const nonReducingHead = await context.currentHeadRootId(nonReducingSeed.conversationId);
    let nonReducingDispatches = 0;
    const nonReducingCoordinator = new kernel.ReliableContextCompressionCoordinator(
      ctx.database,
      ctx.store,
      new kernel.ModelProviderControlPlane(ctx.database, ctx.store),
      {
        resolve(providerId) {
          return {
            providerId,
            async sendFullRequest(_request, controls) {
              nonReducingDispatches += 1;
              await controls.onEvent({
                kind: 'completed', streamSeq: '1',
                content: {
                  type: 'compression_result',
                  contents: [{ role: 'model', parts: [{ text: `NON-REDUCING-${'x'.repeat(4096)}` }] }]
                }
              });
            }
          };
        }
      }
    );
    const nonReducingRequestBudget = kernel.calculateFullRequestPlanningBudget({
      contextWindowTokens: 200_000,
      maxOutputTokens: 16_000,
      compressionThresholdTokens: 1,
      breakdown: {
        systemTokens: 0, toolSchemaTokens: 0, providerFramingTokens: 0,
        contextTokens: 2_000, currentInputTokens: 0, runtimeDeliveryTokens: 0,
        turnReminderTokens: 0, mediaTokens: 0, fixedTokens: 0,
        bodyTokens: 2_000, fullTokens: 2_000
      }
    });
    const nonReducing = await nonReducingCoordinator.coordinate({
      turnId: nonReducingSeed.turnId,
      authoritySnapshotId: nonReducingSeed.authoritySnapshotId,
      headRootId: nonReducingHead,
      trigger: 'auto',
      requestBudget: nonReducingRequestBudget
    });
    assert.equal(nonReducing.status, 'skipped');
    assert.equal(nonReducing.reason, 'non_reducing');
    assert.equal(await context.currentHeadRootId(nonReducingSeed.conversationId), nonReducingHead);
    assert.equal(await count(ctx.database, 'CompressionBlock', {
      conversation_id: nonReducingSeed.conversationId
    }), 0);
    const nonReducingReplay = await nonReducingCoordinator.coordinate({
      turnId: nonReducingSeed.turnId,
      authoritySnapshotId: nonReducingSeed.authoritySnapshotId,
      headRootId: nonReducingHead,
      trigger: 'auto',
      requestBudget: nonReducingRequestBudget
    });
    assert.equal(nonReducingReplay.status, 'skipped');
    assert.equal(nonReducingReplay.reason, 'non_reducing');
    assert.equal(nonReducingDispatches, 1);
    assertions.push('自动压缩协调器把request kind/source prefix冻结进recipe，复用ModelRequest/Operation/Attempt/fence；exact replay零外调；provider-native MessageContent[]按版本化codec持久化并按token预算保留连续finite tail');
    assertions.push('自动压缩只由Provider实测基线优先的Context计量越过配置阈值触发；普通请求估算与物理输入预算仅用于规划和发送前校验，不再形成第二触发线');
    assertions.push('LLM capability adapter只发送冻结prefix，识别prior structured summary，并把CompactDone映射为单一durable completed事件；后续普通请求会展开版本化MessageContent[]而不是把JSON当Markdown');
    assertions.push('manual-only配置不会被自动调度；manualCurrentTurn在远低于冻结阈值时可显式压缩closed prefix，同时保留finite tail并冻结manual request kind');
    assertions.push('受保护tail使上下文越阈值但eligible prefix已不可缩小时，协调器按同head durable request精确跳过而不失败主Turn或重复外调');
    faults.push('compression provider completed before ContextCompression head-CAS commit then exact coordinator replay');

    const currentBlock = await get(ctx.database, 'CompressionBlock', replacement.compressionBlockId);
    const raceDomains = [
      'ContentObject', 'ContextSegment', 'ContextSegmentSource', 'ContextSequenceNode',
      'ContextSequenceRoot', 'ModelContextProjection', 'CompressionBlock', 'CompressionBlockSource'
    ];
    const raceCountsBefore = Object.fromEntries(await Promise.all(
      raceDomains.map(async (domain) => [domain, await countAll(ctx.database, domain)])
    ));
    const staleTitleIdentity = ctx.store.identity('stale race title', 'text/plain');
    const staleSummaryIdentity = ctx.store.identity('STALE-RACE-SUMMARY-UNIQUE', 'text/markdown');
    const casFilesBefore = await casFileCount(ctx.binding.paths.casRootPath);
    let publishedResolve;
    const published = new Promise((resolve) => { publishedResolve = resolve; });
    let releaseResolve;
    const release = new Promise((resolve) => { releaseResolve = resolve; });
    let prepareCount = 0;
    const gatedStore = storeFacade(ctx.store, {
      async prepare(...args) {
        const prepared = await ctx.store.prepare(...args);
        prepareCount += 1;
        if (prepareCount === 2) {
          publishedResolve();
          await release;
        }
        return prepared;
      }
    });
    const staleCompression = new kernel.ContextCompressionControlPlane(ctx.database, gatedStore);
    const stalePromise = staleCompression.replace({
      conversationId: seeded.conversationId,
      previousBlockId: replacement.compressionBlockId,
      expectedHeadRootId: replacement.rootId,
      title: 'stale race title',
      summary: 'STALE-RACE-SUMMARY-UNIQUE',
      previousStatus: 'disabled',
      idempotencyKey: 'stale-race-replacement'
    });
    await published;
    const raceDelivery = runtimeDeliveryFixture('race-head-append', seeded.turnId, 'new-current-head');
    const append = await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'race-head-append', sourceRevision: '0' },
      content: raceDelivery.content,
      contentType: raceDelivery.contentType
    });
    releaseResolve();
    await assert.rejects(stalePromise, /head changed|assertion failed/i);
    assert.equal(await context.currentHeadRootId(seeded.conversationId), append.rootId);
    assert.equal((await get(ctx.database, 'CompressionBlock', replacement.compressionBlockId)).status, currentBlock.status);
    const expectedRaceGrowth = {
      ContentObject: 1,
      ContextSegment: 1,
      ContextSegmentSource: 1,
      ContextSequenceNode: 1,
      ContextSequenceRoot: 1,
      ModelContextProjection: 0,
      CompressionBlock: 0,
      CompressionBlockSource: 0
    };
    for (const domain of raceDomains) {
      assert.equal(
        await countAll(ctx.database, domain),
        raceCountsBefore[domain] + expectedRaceGrowth[domain],
        `${domain} stale replacement half-commit`
      );
    }
    assert.equal(await maybeGet(ctx.database, 'ContentObject', staleTitleIdentity.id), null);
    assert.equal(await maybeGet(ctx.database, 'ContentObject', staleSummaryIdentity.id), null);
    assert.equal((await fs.stat(casObjectPath(ctx.binding, staleTitleIdentity.storage_key))).isFile(), true);
    assert.equal((await fs.stat(casObjectPath(ctx.binding, staleSummaryIdentity.storage_key))).isFile(), true);
    const casFilesAfter = await casFileCount(ctx.binding.paths.casRootPath);
    assert.equal(casFilesAfter - casFilesBefore, 3, 'exactly two stale raw CAS objects plus one committed append');
    assertions.push('replacement与普通append竞态使用expected-head CAS：旧结果不能覆盖新head，旧block status不变且数据库无半提交');
    assertions.push('summary CAS已发布但SQLite stale-head事务未提交时只留下允许的orphan CAS，不留下Content/Block/Root悬空引用');
    faults.push('replacement CAS publish then concurrent head advance before SQLite commit');
    metrics.orphanCasFiles = casFilesAfter - casFilesBefore - 1;

    return { assertions, faults, metrics };
  });
}

async function seedTurn(ctx, suffix, options = {}) {
  const conversationId = `conversation-${suffix}`;
  const agentId = `agent-${suffix}`;
  const now = '2026-08-01T00:00:00.000Z';
  await ctx.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `agent-link-${suffix}`, conversation_id: conversationId, agent_id: agentId,
      role: 'default', created_at: now, updated_at: now
    })
  ]);
  const control = createTurnControl(ctx, suffix, options);
  const inputContent = `user-input-${suffix}`;
  const started = await control.input({
    source: { kind: 'command', key: `input-${suffix}` },
    conversationId,
    leaseOwnerId: 'phase-e-executor',
    hostBootId: `phase-e-${suffix}`,
    leaseExpiresAt: '2026-08-02T00:00:00.000Z',
    content: inputContent
  });
  const authoritySnapshot = (await list(ctx.database, 'AuthoritySnapshot', { turn_id: started.turnId }))[0];
  assert.ok(authoritySnapshot);
  return {
    conversationId,
    agentId,
    turnId: started.turnId,
    messageId: started.messageId,
    messageRevisionId: started.messageRevisionId,
    authoritySnapshotId: authoritySnapshot.id,
    inputContent,
    control
  };
}

async function terminateSeededTurn(seeded, key) {
  await seeded.control.terminal({
    source: { kind: 'callback', key: `fixture-terminal:${key}` },
    turnId: seeded.turnId,
    terminalStatus: 'completed',
    reason: `fixture completed before ${key}`
  });
}

async function openPendingProviderSocket(ctx, provider, modelRequestId, onOpen, options = {}) {
  let openedResolve;
  let openedReject;
  const opened = new Promise((resolve, reject) => {
    openedResolve = resolve;
    openedReject = reject;
  });
  let requestPayload;
  let closeResolve;
  const closeRequested = new Promise((resolve) => { closeResolve = resolve; });
  const dispatch = provider.dispatch(modelRequestId, {
    providerId: 'fake-local',
    async sendFullRequest(request, controls) {
      requestPayload = request;
      try {
        await onOpen(request, controls);
        openedResolve();
      } catch (error) {
        openedReject(error);
        throw error;
      }
      await Promise.race([closeRequested, new Promise((resolve, reject) => {
        const signal = controls.signal;
        if (!signal) return;
        const onAbort = () => reject(signal.reason ?? new Error('fixture provider socket aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })]);
    }
  }, options);
  const settled = dispatch.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  );
  await opened;
  const row = await get(ctx.database, 'ModelRequest', modelRequestId);
  return {
    attemptSeq: row.stream_stats_json.attemptSeq,
    socketGeneration: row.stream_stats_json.socketGeneration,
    request: requestPayload,
    close: () => closeResolve(),
    settled
  };
}

function createTurnControl(ctx, suffix, options = {}) {
  const thresholdTokens = options.thresholdTokens ?? 1024;
  return new kernel.TurnControlPlane(ctx.database, ctx.store, {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: 'fake-local', modelId: 'fake-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              executorAgentId: request.executorAgentId,
              ...(options.includeConversationId ? { conversationId: request.conversationId } : {}),
              modelProfile: {
                compressionThresholdTokens: thresholdTokens,
                contextWindowTokens: options.contextWindowTokens ?? Math.max(200_000, thresholdTokens * 2),
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              model: {
                providerConfigId: 'fake-local',
                modelId: 'fake-model',
                maxOutputTokens: options.maxOutputTokens ?? 16_000,
                ...(options.provider ? { provider: options.provider } : {}),
                ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {})
              },
              // 压缩请求按冻结工具策略投影（没有工具时同样需要显式的空策略）。
              ...(options.toolPolicy || options.compressionPolicy ? {
                toolPolicy: options.toolPolicy ?? {
                  id: 'tools-default', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {}
                }
              } : {}),
              ...(options.compressionPolicy ? { compression: frozenCompressionFixture(options.compressionPolicy) } : {}),
              policies: { toolPolicyId: 'tools-default', systemPromptId: 'prompt-default' }
            })
          }
        };
      }
    }
  });
}

/**
 * 冻结压缩策略从按模型能力配置压缩起必须携带执行计划、能力快照与摘要推理（frozenAuthority 校验）；
 * 夹具只写方法与阈值，这里按与设置编译相同的解析补齐，已写的字段不覆盖。
 */
function frozenCompressionFixture(policy) {
  const provider = policy.provider ?? {};
  const capabilities = provider.capabilities ?? modelCapabilities.resolveModelCapabilities({
    provider: provider.provider, baseUrl: 'https://phase-e.invalid/v1', modelId: provider.modelId,
    providerConfigId: provider.providerConfigId, transport: 'http'
  });
  return {
    ...policy,
    executionPlan: policy.executionPlan ?? modelCapabilities.resolveCompressionExecutionPlan(
      { ...policy.config, kind: policy.methodKind, fallbacks: policy.config?.fallbacks ?? [] }, capabilities
    ),
    provider: {
      ...provider,
      capabilities,
      summaryReasoning: provider.summaryReasoning ?? modelCapabilities.resolveSummaryReasoning({ mode: 'provider_default', capabilities })
    }
  };
}

function runtimeDeliveryFixture(suffix, targetTurnId, output) {
  const processId = `fixture-process-${suffix}`;
  const processReceiptId = `fixture-process-receipt-${suffix}`;
  const projected = kernel.projectRuntimeDeliveryForModel({
    phase: 'current_turn',
    kind: 'process_completion',
    deliveryId: `fixture-delivery-${suffix}`,
    inboxItemId: `fixture-inbox-${suffix}`,
    targetTurnId,
    deliveredAt: '2026-01-01T00:00:00.000Z',
    processId,
    processReceiptId,
    content: { kind: 'process_completion', processId, processReceiptId, output }
  });
  assert.ok(projected, 'current_turn Runtime Delivery must be model-visible');
  return projected;
}

async function appendMessageContextFixture(
  ctx,
  seeded,
  suffix,
  role,
  content,
  contentType = 'text/plain'
) {
  const contentObject = await ctx.store.ingest(ctx.database, content, contentType);
  const messageId = `context-message-${suffix}`;
  const revisionId = `context-message-revision-${suffix}`;
  const now = new Date().toISOString();
  const context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
  const plan = await context.prepareMessageAppendMutation({
    conversationId: seeded.conversationId,
    messageRevisionId: revisionId,
    contentObjectId: contentObject.id,
    contentByteLength: contentObject.byte_length
  });
  await ctx.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
      id: messageId, created_at: now, updated_at: now, deleted_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
      id: revisionId,
      message_id: messageId,
      role,
      content_object_id: contentObject.id,
      created_at: now
    }, { column: 'revision_seq', scope: { message_id: messageId } }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
      id: `context-current-revision-${suffix}`,
      message_id: messageId,
      revision_id: revisionId,
      updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
      id: `context-membership-${suffix}`,
      conversation_id: seeded.conversationId,
      message_id: messageId,
      created_at: now
    }, { column: 'message_seq', scope: { conversation_id: seeded.conversationId } }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
      id: `context-message-turn-${suffix}`,
      turn_id: seeded.turnId,
      message_id: messageId,
      role: 'context-fixture',
      created_at: now
    }),
    ...plan.steps
  ]);
  const source = (await list(ctx.database, 'ContextSegmentSource', {
    source_kind: 'message_revision', source_id: revisionId
  }))[0];
  assert.ok(source);
  return { messageId, revisionId, segmentId: source.segment_id, contentObject };
}

async function seedToolPair(ctx, seeded, suffix) {
  const argumentsObject = await ctx.store.ingest(ctx.database, JSON.stringify({ value: suffix }), 'application/json');
  const resultObject = await ctx.store.ingest(ctx.database, `tool-result-${suffix}`, 'text/plain');
  const now = new Date().toISOString();
  const messageId = `tool-message-${suffix}`;
  const revisionId = `tool-message-revision-${suffix}`;
  const toolCallId = `tool-call-${suffix}`;
  const toolModelResultId = `tool-model-result-${suffix}`;
  await ctx.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
      id: messageId, created_at: now, updated_at: now, deleted_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
      id: revisionId, message_id: messageId, revision_seq: 1n, role: 'tool',
      content_object_id: resultObject.id, created_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ToolCall').insert({
      id: toolCallId, turn_id: seeded.turnId, call_seq: 1n, tool_name: 'echo', status: 'terminal',
      arguments_object_id: argumentsObject.id, created_at: now, updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ToolModelResult').insert({
      id: toolModelResultId, tool_call_id: toolCallId, message_revision_id: revisionId, created_at: now
    })
  ]);
  return { toolCallId, toolModelResultId };
}

function storeFacade(store, overrides = {}) {
  return {
    binding: store.binding,
    identity: (...args) => store.identity(...args),
    publish: (...args) => store.publish(...args),
    prepare: (...args) => store.prepare(...args),
    ingest: (...args) => store.ingest(...args),
    read: (...args) => store.read(...args),
    readMany: (...args) => store.readMany(...args),
    ...overrides
  };
}

function databaseFacade(database, overrides = {}) {
  return {
    binding: database.binding,
    snapshot: (reads) => database.snapshot(reads),
    snapshotAll: (read) => database.snapshotAll(read),
    materializeContext: (rootId) => database.materializeContext(rootId),
    materializeContextContent: (rootId) => database.materializeContextContent(rootId),
    inspect: () => database.inspect(),
    onCommit: (listener) => database.onCommit(listener),
    transaction: (steps) => database.transaction(steps),
    commitModelStreamEvent: (input) => database.commitModelStreamEvent(input),
    cancelCurrentModelRequest: (input) => database.cancelCurrentModelRequest(input),
    ...overrides
  };
}

async function withRuntime(label, body) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-phase-e-${label}-`));
  const candidate = await kernel.resetCandidateRuntimeRoot(parent);
  const ctx = {
    ...candidate,
    parent,
    database: null,
    store: null
  };
  try {
    await reopen(ctx, `phase-e-${label}`);
    return await body(ctx);
  } finally {
    if (ctx.database) await ctx.database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function reopen(ctx, hostBootId) {
  if (ctx.database) throw new Error('Runtime database must be closed before reopen.');
  ctx.database = await kernel.RuntimeDatabase.open(ctx.authority, { hostBootId });
  ctx.store = new kernel.ContentAddressedStore(ctx.authority, ctx.binding);
}

async function closeAndCheckpoint(ctx) {
  if (ctx.database) {
    await ctx.database.close();
    ctx.database = null;
  }
  const database = new Database(ctx.binding.paths.databasePath, { fileMustExist: true });
  try {
    const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)');
    const busy = Number(checkpoint?.[0]?.busy ?? 0);
    if (busy !== 0) throw new Error(`WAL checkpoint remained busy: ${busy}`);
  } finally {
    database.close();
  }
}

async function persistentBytes(binding) {
  let total = 0;
  for (const file of [
    binding.paths.databasePath,
    `${binding.paths.databasePath}-wal`,
    `${binding.paths.databasePath}-shm`
  ]) {
    try { total += (await fs.stat(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  total += await directoryFileBytes(binding.paths.casRootPath);
  return total;
}

async function directoryFileBytes(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryFileBytes(absolute);
    else if (entry.isFile()) total += (await fs.stat(absolute)).size;
  }
  return total;
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

function rejectAfter(milliseconds, label) {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms.`)), milliseconds);
    timer.unref?.();
  });
}

function deterministicBytes(seed, length) {
  const result = Buffer.allocUnsafe(length);
  let offset = 0;
  let counter = 0;
  while (offset < length) {
    const chunk = crypto.createHash('sha256').update(seed).update(':').update(String(counter++)).digest();
    chunk.copy(result, offset, 0, Math.min(chunk.length, length - offset));
    offset += chunk.length;
  }
  return result;
}

function assertNoContinuationPayload(request) {
  assert.equal(request.kind, 'full-model-request');
  assert.equal(typeof request.conversationId, 'string');
  assert.ok(request.conversationId.trim().length > 0);
  assert.ok(Array.isArray(request.context) && request.context.length > 0);
  const required = [
    'kind', 'modelRequestId', 'conversationId', 'attemptSeq', 'socketGeneration', 'providerId', 'modelId',
    'authoritySnapshot', 'recipe', 'context', 'attachmentCatalogState', 'requestCreatedAt'
  ];
  const expected = Object.prototype.hasOwnProperty.call(request, 'settingsSnapshot')
    ? [...required, 'settingsSnapshot']
    : required;
  assert.deepEqual(Object.keys(request).sort(), expected.sort(), 'Provider envelope exact field set');
}

function immutableCompressionFields(block) {
  return {
    id: block.id,
    conversation_id: block.conversation_id,
    authority_snapshot_id: block.authority_snapshot_id,
    title_object_id: block.title_object_id,
    summary_object_id: block.summary_object_id,
    created_at: block.created_at
  };
}

async function list(database, domain, where = {}) {
  const snapshot = await database.snapshot([
    kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, limit: 1000 })
  ]);
  return snapshot.snapshot[0];
}

async function listAll(database, domain, where = {}) {
  const barrier = await database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1000
  }));
  return barrier.snapshot;
}

async function count(database, domain, where = {}) {
  return (await list(database, domain, where)).length;
}

async function countAll(database, domain) {
  return (await listAll(database, domain)).length;
}

async function get(database, domain, id) {
  const value = await maybeGet(database, domain, id);
  assert.ok(value, `${domain} ${id} should exist`);
  return value;
}

async function maybeGet(database, domain, id) {
  const snapshot = await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain(domain).get(id)]);
  return snapshot.snapshot[0];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile95(values) {
  if (values.length === 0) throw new Error('p95 requires at least one sample.');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function writeEvidence(stableId, evidence, commitSha) {
  const fileName = `${stableId.replaceAll('.', '-')}.json`;
  const evidencePath = path.join(root, 'tests/reliable-kernel/evidence', fileName);
  const runnerPath = path.join(root, 'scripts/reliable-kernel/run-phase-e-check.mjs');
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
    kind: 'limcode-phase-e-candidate-evidence',
    checkId: stableId,
    passed: true,
    commitSha,
    measuredAt: new Date().toISOString(),
    provenance: {
      worktreeClean: worktreeStatus.length === 0,
      commitExplicitlyBound: requestedCommit === commitSha,
      authoritative: worktreeStatus.length === 0
        && requestedCommit === commitSha
        && sourceFilesTracked
        && compileProvenance.worktreeClean === true
        && compileProvenance.sourceFilesTracked === true
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

function stableContextId(kind, ...parts) {
  const digest = crypto.createHash('sha256')
    .update('limcode-reliable-kernel-context\0')
    .update(kind)
    .update('\0')
    .update(parts.join('\0'))
    .digest('hex');
  return `${kind}_${digest}`;
}

function casObjectPath(binding, storageKey) {
  return path.join(binding.paths.casRootPath, ...storageKey.split('/'));
}
