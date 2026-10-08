import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const NOW = '2026-10-09T00:00:00.000Z';

test('selected Context authority follows its exact root, shared fork ownership and child driver scope', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-selected-context-authority-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const database = await kernel.RuntimeDatabase.open(authority);
  try {
    const store = kernel.ContentAddressedStore.forDatabase(authority, database);
    const body = await store.prepare(database, '{}', 'application/json');
    const steps = body.insert ? [body.insert] : [];
    for (const id of ['parent', 'fork', 'child', 'empty']) {
      steps.push(repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }));
    }
    for (const [id, conversationId] of [['parent-turn', 'parent'], ['fork-turn', 'fork'],
      ['discarded-turn', 'fork'], ['child-copied-turn', 'child'], ['child-own-turn', 'child']]) {
      steps.push(repo('Turn').insert({ id, conversation_id: conversationId, status: 'active',
        created_at: NOW, updated_at: NOW, terminal_at: null }));
      steps.push(repo('AuthoritySnapshot').insert({ id: `${id}-authority`, turn_id: id,
        content_object_id: body.metadata.id, created_at: NOW }));
      steps.push(repo('Message').insert({ id: `${id}-message`, created_at: NOW, updated_at: NOW, deleted_at: null }));
      steps.push(repo('MessageRevision').insert({ id: `${id}-revision`, message_id: `${id}-message`, revision_seq: 1n,
        role: 'user', content_object_id: body.metadata.id, created_at: NOW }));
      steps.push(repo('MessagePartOfConversation').insertWithNextSequence({ id: `${id}-membership`,
        conversation_id: conversationId, message_id: `${id}-message`, created_at: NOW },
      { column: 'message_seq', scope: { conversation_id: conversationId } }));
      steps.push(repo('MessageTurnLink').insert({ id: `${id}-link`, message_id: `${id}-message`, turn_id: id,
        role: 'input', created_at: NOW }));
    }
    for (const id of ['shared', 'discarded', 'own']) {
      steps.push(repo('ContextSegment').insert({ id: `${id}-segment`, segment_kind: 'message',
        content_object_id: body.metadata.id, created_at: NOW }));
      steps.push(repo('ContextSequenceNode').insert({ id: `${id}-node`, segment_id: `${id}-segment`,
        parent_node_id: id === 'own' ? 'shared-node' : null, created_at: NOW }));
    }
    for (const [turnId, segmentId] of [['parent-turn', 'shared'], ['fork-turn', 'shared'],
      ['child-copied-turn', 'shared'], ['discarded-turn', 'discarded'], ['child-own-turn', 'own']]) {
      steps.push(repo('ContextSegmentSource').insert({ id: `${turnId}-source`, segment_id: `${segmentId}-segment`,
        source_kind: 'message_revision', source_id: `${turnId}-revision`, source_revision: 1n, created_at: NOW }));
    }
    for (const [id, conversationId, nodeId, segmentCount] of [['fork-selected', 'fork', 'shared-node', 1],
      ['fork-discarded', 'fork', 'discarded-node', 1], ['child-copied', 'child', 'shared-node', 1],
      ['child-own', 'child', 'own-node', 2], ['empty-root', 'empty', null, 0]]) {
      steps.push(repo('ContextSequenceRoot').insertWithNextSequence({ id, conversation_id: conversationId,
        root_node_id: nodeId, tail_node_id: null, tail_segment_count: 0n, segment_count: BigInt(segmentCount),
        estimated_tokens: 0n, created_at: NOW }, { column: 'root_seq', scope: { conversation_id: conversationId } }));
    }
    for (const [conversationId, rootId] of [['fork', 'fork-selected'], ['child', 'child-copied'], ['empty', 'empty-root']]) {
      steps.push(repo('ConversationContextHeadLink').insert({ id: `${conversationId}-head`,
        conversation_id: conversationId, root_id: rootId, updated_at: NOW }));
    }
    steps.push(repo('ChildExecution').insert({ id: 'child-execution', child_conversation_id: 'child',
      status: 'starting', created_at: NOW, updated_at: NOW }));
    steps.push(repo('ChildExecutionTurnLink').insert({ id: 'child-driver-link', child_execution_id: 'child-execution',
      turn_id: 'child-own-turn', turn_seq: 1n, created_at: NOW }));
    await database.transaction(steps);

    const read = async input => (await database.readSelectedContextAuthoritySource(input)).snapshot;
    const source = turnId => ({ authoritySnapshotId: `${turnId}-authority`, contentObjectId: body.metadata.id, sourceTurnId: turnId });
    assert.deepEqual(await read({ conversationId: 'fork' }), {
      contextRootId: 'fork-selected', contextHeadId: 'fork-head', isChildConversation: false, source: source('fork-turn')
    }, 'a newer discarded Turn and the shared parent source do not replace the selected fork source');
    await database.transaction([repo('ConversationContextHeadLink').update('fork-head', { root_id: 'fork-discarded' })]);
    assert.equal((await read({ conversationId: 'fork' })).source.sourceTurnId, 'discarded-turn');
    assert.equal((await read({ conversationId: 'fork', contextRootId: 'fork-selected' })).source.sourceTurnId, 'fork-turn');
    assert.deepEqual(await read({ conversationId: 'child', childExecutionId: 'child-execution' }), {
      contextRootId: 'child-copied', contextHeadId: 'child-head', isChildConversation: true
    }, 'copied parent Turns do not establish the child driver initial fact');
    await database.transaction([repo('ConversationContextHeadLink').update('child-head', { root_id: 'child-own' })]);
    assert.deepEqual((await read({ conversationId: 'child', childExecutionId: 'child-execution' })).source, source('child-own-turn'));
    await database.transaction([
      repo('CompressionBlock').insert({ id: 'child-block', conversation_id: 'child', status: 'enabled',
        authority_snapshot_id: 'child-own-turn-authority', title_object_id: body.metadata.id,
        summary_object_id: body.metadata.id, created_at: NOW, updated_at: NOW }),
      repo('ContextSegment').insert({ id: 'summary-segment', segment_kind: 'compression',
        content_object_id: body.metadata.id, created_at: NOW }),
      repo('ContextSegmentSource').insert({ id: 'summary-source', segment_id: 'summary-segment',
        source_kind: 'compression_block', source_id: 'child-block', source_revision: 0n, created_at: NOW }),
      repo('ContextSequenceNode').insert({ id: 'summary-node', segment_id: 'summary-segment', parent_node_id: null, created_at: NOW }),
      repo('ContextSegment').insert({ id: 'kept-tail-segment', segment_kind: 'system',
        content_object_id: body.metadata.id, created_at: NOW }),
      repo('ContextSequenceNode').insert({ id: 'kept-tail-node', segment_id: 'kept-tail-segment',
        parent_node_id: 'shared-node', created_at: NOW }),
      repo('ContextSequenceRoot').insertWithNextSequence({ id: 'child-compressed', conversation_id: 'child',
        root_node_id: 'summary-node', tail_node_id: 'kept-tail-node', tail_segment_count: 1n, segment_count: 2n,
        estimated_tokens: 0n, created_at: NOW }, { column: 'root_seq', scope: { conversation_id: 'child' } }),
      repo('ConversationContextHeadLink').update('child-head', { root_id: 'child-compressed' })
    ]);
    assert.deepEqual((await read({ conversationId: 'child' })).source, source('child-own-turn'),
      'the kept compression tail stops at its count even when its last parent points into discarded history');
    assert.deepEqual(await read({ conversationId: 'empty' }), {
      contextRootId: 'empty-root', contextHeadId: 'empty-head', isChildConversation: false
    });
    await database.transaction([
      repo('Message').insert({ id: 'independent-message', created_at: NOW, updated_at: NOW, deleted_at: null }),
      repo('MessageRevision').insert({ id: 'independent-revision', message_id: 'independent-message', revision_seq: 1n,
        role: 'user', content_object_id: body.metadata.id, created_at: NOW }),
      repo('MessagePartOfConversation').insertWithNextSequence({ id: 'independent-membership', conversation_id: 'empty',
        message_id: 'independent-message', created_at: NOW }, { column: 'message_seq', scope: { conversation_id: 'empty' } }),
      repo('ContextSegment').insert({ id: 'independent-segment', segment_kind: 'message',
        content_object_id: body.metadata.id, created_at: NOW }),
      repo('ContextSegmentSource').insert({ id: 'independent-source', segment_id: 'independent-segment',
        source_kind: 'message_revision', source_id: 'independent-revision', source_revision: 1n, created_at: NOW }),
      repo('ContextSequenceNode').insert({ id: 'independent-node', segment_id: 'independent-segment', parent_node_id: null, created_at: NOW }),
      repo('ContextSequenceRoot').insertWithNextSequence({ id: 'independent-root', conversation_id: 'empty',
        root_node_id: 'independent-node', tail_node_id: null, tail_segment_count: 0n, segment_count: 1n,
        estimated_tokens: 0n, created_at: NOW }, { column: 'root_seq', scope: { conversation_id: 'empty' } }),
      repo('ConversationContextHeadLink').update('empty-head', { root_id: 'independent-root' })
    ]);
    assert.deepEqual(await read({ conversationId: 'empty' }), {
      contextRootId: 'independent-root', contextHeadId: 'empty-head', isChildConversation: false
    }, 'a valid independent Message occurrence without a Turn is not an initial authority fact');
    assert.deepEqual(await read({ conversationId: 'parent' }), {
      contextRootId: null, contextHeadId: null, isChildConversation: false
    });
    const differentBody = await store.prepare(database, '{"different":true}', 'application/json');
    await database.transaction([
      ...(differentBody.insert ? [differentBody.insert] : []),
      repo('MessageRevision').insert({ id: 'fork-mismatched-revision', message_id: 'fork-turn-message', revision_seq: 2n,
        role: 'user', content_object_id: differentBody.metadata.id, created_at: NOW }),
      repo('ContextSegment').insert({ id: 'mismatched-segment', segment_kind: 'message',
        content_object_id: body.metadata.id, created_at: NOW }),
      repo('ContextSegmentSource').insert({ id: 'mismatched-source', segment_id: 'mismatched-segment',
        source_kind: 'message_revision', source_id: 'fork-mismatched-revision', source_revision: 2n, created_at: NOW }),
      repo('ContextSequenceNode').insert({ id: 'mismatched-node', segment_id: 'mismatched-segment', parent_node_id: null, created_at: NOW }),
      repo('ContextSequenceRoot').insertWithNextSequence({ id: 'fork-mismatched', conversation_id: 'fork',
        root_node_id: 'mismatched-node', tail_node_id: null, tail_segment_count: 0n, segment_count: 1n,
        estimated_tokens: 0n, created_at: NOW }, { column: 'root_seq', scope: { conversation_id: 'fork' } })
    ]);
    await assert.rejects(read({ conversationId: 'fork', contextRootId: 'fork-mismatched' }), /no unique valid authority source/);
    await database.transaction([repo('AuthoritySnapshot').insert({ id: 'ambiguous-snapshot', turn_id: 'fork-turn',
      content_object_id: body.metadata.id, created_at: NOW })]);
    await assert.rejects(read({ conversationId: 'fork', contextRootId: 'fork-selected' }), /incomplete frozen authority facts/);
  } finally {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
