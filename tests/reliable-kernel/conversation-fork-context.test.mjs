import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { pendingConversationContextHandleStateSteps } = require(path.join(compiledRoot, 'backend/reliableKernel/conversationContextHandleState.js'));
const NOW = '2026-09-07T00:00:00.000Z';

async function withContext(body, observed = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-fork-context-'));
  let database;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(directory);
    database = await kernel.RuntimeDatabase.open(candidate.authority, { hostBootId: 'fork-context-test' });
    const store = kernel.ContentAddressedStore.forDatabase(candidate.authority, database);
    const contents = [
      { kind: 'compression_contents', contents: [{ role: 'user', parts: [{ text: 'retained summary' }] }], estimatedTokens: 32 },
      { role: 'user', parts: [{ text: 'inspect image' }, { inlineData: { mimeType: 'image/png', data: 'A'.repeat(800_000) } }] },
      { role: 'user', parts: [{ text: 'later content excluded by the earlier fork boundary' }] }
    ];
    const metadata = [];
    for (const [index, content] of contents.entries()) {
      metadata.push(await store.ingest(database, JSON.stringify(content), index === 0
        ? 'application/vnd.limcode.compression-contents+json'
        : 'application/vnd.limcode.message+json'));
    }
    const insert = (domain, row) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(row);
    const historical = (domain, row) => kernel.DOMAIN_REPOSITORIES.domain(domain).insertHistoricalCopy(row);
    const compacted = await store.ingest(database, 'history already compacted', 'text/plain');
    const steps = [
      insert('Conversation', { id: 'source', title: 'source', status: 'active', created_at: NOW, updated_at: NOW }),
      insert('AgentConversationLink', { id: 'source-agent', conversation_id: 'source', agent_id: 'main', role: 'default', created_at: NOW, updated_at: NOW }),
      ...metadata.flatMap((content, index) => [
        insert('ContextSegment', { id: 'segment-' + index, content_object_id: content.id, segment_kind: index === 0 ? 'compression' : 'message', created_at: NOW }),
        ...(index === 0 ? [] : [
          insert('Message', { id: 'message-' + index, created_at: NOW, updated_at: NOW, deleted_at: null }),
          insert('MessagePartOfConversation', { id: 'membership-' + index, message_id: 'message-' + index, conversation_id: 'source', message_seq: BigInt(index), created_at: NOW }),
          insert('MessageRevision', { id: 'revision-' + index, message_id: 'message-' + index, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW }),
          insert('ContextSegmentSource', { id: 'segment-source-' + index, segment_id: 'segment-' + index, source_kind: 'message_revision', source_id: 'revision-' + index, source_revision: 1n, created_at: NOW })
        ]),
        insert('ContextSequenceNode', { id: 'node-' + index, parent_node_id: index < 2 ? null : 'node-' + (index - 1), segment_id: 'segment-' + index, created_at: NOW })
      ]),
      // The block's frozen authority belongs to the maintenance Turn that compressed the history.
      insert('Turn', { id: 'compression-turn', conversation_id: 'source', status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
      insert('AuthoritySnapshot', { id: 'source-authority', turn_id: 'compression-turn', content_object_id: compacted.id, created_at: NOW }),
      insert('TurnTermination', { id: 'compression-turn-termination', turn_id: 'compression-turn', terminal_status: 'completed', reason: 'compressed', created_at: NOW }),
      insert('ContextSegment', { id: 'compacted-segment', content_object_id: compacted.id, segment_kind: 'system', created_at: NOW }),
      insert('ContextSegmentSource', { id: 'compacted-source', segment_id: 'compacted-segment', source_kind: 'system', source_id: 'compacted-system', source_revision: 0n, created_at: NOW }),
      insert('CompressionBlock', { id: 'compression', conversation_id: 'source', status: 'enabled', authority_snapshot_id: 'source-authority', title_object_id: compacted.id, summary_object_id: metadata[0].id, created_at: NOW, updated_at: NOW }),
      insert('CompressionBlockSource', { id: 'compression-source', compression_block_id: 'compression', segment_id: 'compacted-segment', position: 0n, created_at: NOW }),
      insert('ContextSegmentSource', { id: 'summary-source', segment_id: 'segment-0', source_kind: 'compression_block', source_id: 'compression', source_revision: 0n, created_at: NOW }),
      // The root the block compressed: its compressed range followed by the tail it kept.
      insert('ContextSequenceNode', { id: 'creation-node-0', parent_node_id: null, segment_id: 'compacted-segment', created_at: NOW }),
      insert('ContextSequenceNode', { id: 'creation-node-1', parent_node_id: 'creation-node-0', segment_id: 'segment-1', created_at: NOW }),
      insert('ContextSequenceRoot', {
        id: 'source-creation', conversation_id: 'source', root_seq: 1n, root_node_id: 'creation-node-1', tail_node_id: null,
        tail_segment_count: 0n, segment_count: 2n, estimated_tokens: 5000n, created_at: NOW
      }),
      insert('ModelContextProjection', { id: 'compression-projection', owner_kind: 'compression_block', owner_id: 'compression', root_id: 'source-creation', purpose: 'compression-source', created_at: NOW }),
      insert('ContextSequenceRoot', {
        id: 'source-prefix', conversation_id: 'source', root_seq: 2n, root_node_id: 'node-0', tail_node_id: 'node-1',
        tail_segment_count: 1n, segment_count: 2n, estimated_tokens: 5000n, created_at: NOW
      }),
      insert('ContextSequenceRoot', {
        id: 'source-full', conversation_id: 'source', root_seq: 3n, root_node_id: 'node-0', tail_node_id: 'node-2',
        tail_segment_count: 2n, segment_count: 3n, estimated_tokens: 6000n, created_at: NOW
      }),
      insert('ConversationContextHeadLink', { id: 'source-head', conversation_id: 'source', root_id: 'source-full', updated_at: NOW }),
      ...pendingConversationContextHandleStateSteps('source', NOW, undefined, 'source-full')
    ];
    if (observed) {
      const recipe = await store.ingest(database, '{}', 'application/json');
      steps.push(
        insert('Turn', { id: 'source-turn', conversation_id: 'source', status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        insert('Message', { id: 'provider-output', created_at: NOW, updated_at: NOW, deleted_at: null }),
        historical('ModelRequest', {
          id: 'source-request', turn_id: 'source-turn', request_seq: 1n, status: 'terminal', terminal_state: 'completed',
          provider_id: 'provider', model_id: 'model', context_window_tokens: 300000n, compression_threshold_tokens: 270000n,
          estimated_context_tokens: 5000n, authority_snapshot_id: 'source-authority', settings_snapshot_object_id: null,
          recipe_object_id: recipe.id, usage_json: { promptTokenCount: 5000 },
          stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null },
          created_at: NOW, updated_at: NOW
        }),
        historical('Operation', { id: 'source-operation', owner_kind: 'model_request', owner_id: 'source-request', operation_seq: 1n, tool_call_id: null, status: 'completed', created_at: NOW, updated_at: NOW }),
        historical('Attempt', { id: 'source-attempt', operation_id: 'source-operation', attempt_seq: 1n, status: 'completed', created_at: NOW, updated_at: NOW, completed_at: NOW }),
        historical('ModelStreamFence', { id: 'source-fence', model_request_id: 'source-request', attempt_seq: 1n, socket_generation: 1n, terminal_stream_seq: 1n, outcome: 'completed', created_at: NOW }),
        insert('ModelRequestMessageLink', { id: 'request-output', model_request_id: 'source-request', message_id: 'provider-output', created_at: NOW }),
        insert('ModelContextProjection', { id: 'source-projection', owner_kind: 'model_request', owner_id: 'source-request', root_id: 'source-prefix', purpose: 'provider-request', created_at: NOW })
      );
    }
    await database.transaction(steps);
    const control = new kernel.ConversationForkControlPlane(database, store, { now: () => NOW });
    const estimator = new kernel.ReliableContextTokenEstimator(database, store);
    const fork = (suffix, endSegmentId) => control.fork({
      idempotencyKey: 'fork-' + suffix, reuseKey: 'reuse-' + suffix, sourceConversationId: 'source',
      sourceContextRootId: 'source-full', ...(endSegmentId ? { sourceContextEndSegmentId: endSegmentId } : {}),
      targetTitle: 'fork ' + suffix, targetAgentId: 'main'
    });
    await body({ database, store, metadata, estimator, fork });
  } finally {
    if (database) await database.close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('limcode-fork-context-'));
    await fs.rm(target, { recursive: true, force: true });
  }
}

async function getRoot(database, rootId) {
  return (await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(rootId)])).snapshot[0];
}

test('从较早位置分支保留 Provider 校准，图片存储字节不再膨胀上下文估算', async () => {
  await withContext(async ({ database, metadata, estimator, fork }) => {
    const expected = await estimator.estimateRootPrefix('source-full', 2);
    assert.equal(expected, 5000);
    assert.ok(metadata.slice(0, 2).reduce((total, content) => total + Math.ceil(Number(content.byte_length) / 4), 0) > 200_000);
    const result = await fork('prefix', 'segment-1');
    const root = await getRoot(database, result.targetRootId);
    assert.equal(Number(root.estimated_tokens), expected);
    assert.equal(root.segment_count, 2n);
    assert.equal(root.root_node_id, 'node-0');
    assert.equal(root.tail_node_id, 'node-1');
    const materialized = (await database.materializeContext(result.targetRootId)).snapshot.records;
    assert.deepEqual(materialized.map(record => record.contentObject.id), metadata.slice(0, 2).map(content => content.id));
    assert.equal((await getRoot(database, 'source-full')).estimated_tokens, 6000n);
    const targetBlocks = (await database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain('CompressionBlock').list({
      where: { conversation_id: result.targetConversationId }, orderBy: { column: 'id', direction: 'asc' }, limit: 10
    }))).snapshot;
    assert.equal(targetBlocks.length, 1, 'the fork owns its own copy of the reachable compression block');
    assert.equal(targetBlocks[0].summary_object_id, metadata[0].id);
    const [projection] = (await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('ModelContextProjection').list({
      where: { owner_kind: 'compression_block', owner_id: targetBlocks[0].id }, limit: 2
    })])).snapshot[0];
    assert.equal((await getRoot(database, projection.root_id)).conversation_id, result.targetConversationId,
      'the copied block keeps its creation projection on the fork history');
    assert.equal((await fork('prefix', 'segment-1')).deduplicated, true);
  });
});

test('分支末尾切点使用同一估算器，整段复制仍保留源上下文状态', async () => {
  await withContext(async ({ database, estimator, fork }) => {
    const expected = await estimator.estimateRootPrefix('source-full', 3);
    const selected = await fork('last', 'segment-2');
    assert.equal(Number((await getRoot(database, selected.targetRootId)).estimated_tokens), expected);
    const whole = await fork('whole');
    const root = await getRoot(database, whole.targetRootId);
    assert.equal(root.estimated_tokens, 6000n);
    assert.equal(root.segment_count, 3n);
    assert.equal(root.root_node_id, 'node-0');
    assert.equal(root.tail_node_id, 'node-2');
  });
});

test('尚无 Provider 用量的分支按语义估算并保留压缩摘要', async () => {
  await withContext(async ({ database, estimator, fork }) => {
    const expected = await estimator.estimateRootPrefix('source-full', 2);
    assert.ok(expected > 0 && expected < 2000);
    const result = await fork('semantic', 'segment-1');
    const root = await getRoot(database, result.targetRootId);
    assert.equal(Number(root.estimated_tokens), expected);
    assert.equal(root.root_node_id, 'node-0');
    assert.equal(root.tail_segment_count, 1n);
  }, false);
});

function observedProjectionFixture(segmentCount, anchor) {
  const events = [];
  const conversions = Array(segmentCount).fill(0);
  const ranges = [];
  const segments = Array.from({ length: segmentCount }, (_, index) => ({
    segmentId: `observed-segment-${index}`,
    segmentKind: 'message',
    messageRole: index % 2 === 0 ? 'user' : 'model',
    contentObject: { content_type: 'application/vnd.limcode.message+json' },
    content: Buffer.from(JSON.stringify({
      role: index % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `Observed projection content ${index}.` }]
    }))
  }));
  const prepared = new kernel.PreparedAttachmentCatalogProjection(segments.map(segment => ({
    segmentId: segment.segmentId, segmentKind: segment.segmentKind, catalog: []
  })), []);
  const projectState = prepared.projectState.bind(prepared);
  const projectRange = prepared.projectRange.bind(prepared);
  const modelHandleCatalog = { entries: [] };
  const projected = (start, end) => kernel.estimateMaterializedContextTokens(
    segments.slice(start, end), projectRange(start, end), modelHandleCatalog
  );
  prepared.projectState = () => {
    events.push('state');
    return projectState();
  };
  prepared.projectRange = (start, end) => {
    ranges.push([start, end]);
    return projectRange(start, end);
  };
  const materialized = {
    root: { conversation_id: 'observed-conversation' },
    segments: segments.map((segment, index) => {
      const content = Buffer.from(segment.content);
      content.toString = (...args) => {
        events.push(`content-${index}`);
        conversions[index] += 1;
        return Buffer.prototype.toString.apply(content, args);
      };
      return { ...segment, content };
    })
  };
  // Keep the production estimator and projection paths; replace only the per-call fact readers.
  const estimator = Object.create(kernel.ReliableContextTokenEstimator.prototype);
  estimator.findObservedPrefix = async (conversationId, current) => {
    events.push('anchor');
    assert.equal(conversationId, materialized.root.conversation_id);
    assert.equal(current, materialized.segments);
    return anchor;
  };
  estimator.attachmentCatalog = {
    async prepare(conversationId, selected) {
      events.push('prepare');
      assert.equal(conversationId, materialized.root.conversation_id);
      assert.deepEqual(selected, segments.map(segment => ({ segmentId: segment.segmentId })));
      return prepared;
    }
  };
  estimator.attachmentHandles = {
    async ensure(conversationId, catalog) {
      events.push('handles');
      assert.equal(conversationId, materialized.root.conversation_id);
      assert.deepEqual(catalog, []);
      return modelHandleCatalog;
    }
  };
  return { estimator, materialized, prepared, conversions, ranges, events, projected };
}

for (const segmentCount of [100, 400]) {
  test(`observed token projection reuses the validated full window (${segmentCount} segments)`, async () => {
    const anchor = {
      promptTokens: 5000, totalTokens: 7000, modelRequestId: 'observed-request',
      coveredSegmentCount: segmentCount, outputSegmentIndex: segmentCount - 1
    };
    const fixture = observedProjectionFixture(segmentCount, anchor);
    const { estimator, materialized, conversions, ranges, events } = fixture;
    const result = await estimator.estimateMaterializedRoot(materialized);
    assert.deepEqual(result, {
      full: {
        estimatedTokens: 7000, source: 'provider-observed-delta', conversationId: 'observed-conversation',
        observedPromptTokens: 5000, observedModelRequestId: 'observed-request', coveredSegmentCount: segmentCount
      },
      prefixTokens: 7000
    });
    assert.deepEqual(conversions, Array(segmentCount).fill(1), 'each content is projected only once');
    assert.deepEqual(ranges, [], 'neither the covered window nor known output needs another attachment range');
    assert.deepEqual(events, ['anchor', 'prepare', 'state', 'handles',
      ...Array.from({ length: segmentCount }, (_, index) => `content-${index}`)]);

    // Reuse is local to one estimate, and zero is a supplied total rather than a fallback request.
    anchor.totalTokens = 0;
    const fresh = await estimator.estimateMaterializedRoot(materialized);
    assert.equal(fresh.full.estimatedTokens, 0);
    assert.equal(fresh.prefixTokens, 0);
    assert.deepEqual(conversions, Array(segmentCount).fill(2));
    assert.deepEqual(ranges, []);
    assert.equal(events.filter(event => event === 'anchor').length, 2);
    assert.equal(events.filter(event => event === 'prepare').length, 2);
    assert.equal(events.filter(event => event === 'handles').length, 2);
  });

  test(`observed token projection estimates output only without provider total (${segmentCount} segments)`, async () => {
    const fixture = observedProjectionFixture(segmentCount, {
      promptTokens: 5000, modelRequestId: 'observed-request',
      coveredSegmentCount: segmentCount, outputSegmentIndex: segmentCount - 1
    });
    const expected = 5000 + fixture.projected(segmentCount - 1, segmentCount);
    const result = await fixture.estimator.estimateMaterializedRoot(fixture.materialized);
    assert.equal(result.full.estimatedTokens, expected);
    assert.equal(result.prefixTokens, expected);
    assert.deepEqual(fixture.conversions, Array.from({ length: segmentCount }, (_, index) =>
      index === segmentCount - 1 ? 2 : 1));
    assert.deepEqual(fixture.ranges, [[segmentCount - 1, segmentCount]]);
  });

  test(`observed token projection still projects partial coverage (${segmentCount} segments)`, async () => {
    const covered = segmentCount / 2;
    const fixture = observedProjectionFixture(segmentCount, {
      promptTokens: 5000, totalTokens: 7000, modelRequestId: 'observed-request',
      coveredSegmentCount: covered, outputSegmentIndex: covered - 1
    });
    const expected = 7000 + Math.max(0, fixture.projected(0, segmentCount) - fixture.projected(0, covered));
    const result = await fixture.estimator.estimateMaterializedRoot(fixture.materialized);
    assert.equal(result.full.estimatedTokens, expected);
    assert.equal(result.full.coveredSegmentCount, covered);
    assert.equal(result.prefixTokens, expected);
    assert.deepEqual(fixture.conversions, Array.from({ length: segmentCount }, (_, index) => index < covered ? 2 : 1));
    assert.deepEqual(fixture.ranges, [[0, covered]]);
  });
}

test('observed token projection preserves the requested prefix delta after full-window reuse', async () => {
  const segmentCount = 100;
  const requestedPrefix = 40;
  const fixture = observedProjectionFixture(segmentCount, {
    promptTokens: 5000, totalTokens: 7000, modelRequestId: 'observed-request',
    coveredSegmentCount: segmentCount, outputSegmentIndex: segmentCount - 1
  });
  const expected = Math.max(0, 7000 - Math.max(0,
    fixture.projected(0, segmentCount) - fixture.projected(0, requestedPrefix)));
  const result = await fixture.estimator.estimateMaterializedRoot(fixture.materialized, requestedPrefix);
  assert.equal(result.full.estimatedTokens, 7000);
  assert.equal(result.prefixTokens, expected);
  assert.deepEqual(fixture.conversions, Array.from({ length: segmentCount }, (_, index) => index < requestedPrefix ? 2 : 1));
  assert.deepEqual(fixture.ranges, [[0, requestedPrefix]]);
});

test('observed token projection never bypasses full validation or changes discovery error precedence', async () => {
  for (const discoveryFails of [false, true]) {
    const fixture = observedProjectionFixture(100, {
      promptTokens: 5000, totalTokens: 7000, modelRequestId: 'observed-request',
      coveredSegmentCount: 100, outputSegmentIndex: 99
    });
    const discoveryError = new Error('Injected anchor discovery failure.');
    if (discoveryFails) fixture.estimator.findObservedPrefix = async () => { throw discoveryError; };
    fixture.prepared.projectState = () => ({ catalog: [], placements: [{ kind: 'invalid' }] });
    await assert.rejects(fixture.estimator.estimateMaterializedRoot(fixture.materialized), error => {
      assert.notEqual(error, discoveryError, 'the full projection error must take precedence over discovery');
      assert.match(error.message, /attachmentCatalogState\.placements\[0\]\.kind/);
      return true;
    });
    assert.deepEqual(fixture.conversions, Array(100).fill(1), 'the initial full projection must still run');
    assert.deepEqual(fixture.ranges, []);
    if (discoveryFails) {
      fixture.prepared.projectState = () => ({ catalog: [], placements: [] });
      await assert.rejects(fixture.estimator.estimateMaterializedRoot(fixture.materialized), error => error === discoveryError);
      assert.deepEqual(fixture.conversions, Array(100).fill(2));
      assert.deepEqual(fixture.ranges, []);
    }
  }
});
