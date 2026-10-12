import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

export function registerContextHandleBoundaryTests(f) {
  const { repo, NOW, modelRequestAggregate, Database } = f;
  const handles = f.kernelFile('modelHandleCatalog.js');
  const state = f.kernelFile('conversationContextHandleState.js');
  const reservations = f.kernelFile('forkContextHandleReservations.js');
  const { ConversationAttachmentHandleRegistry } = f.kernelFile('conversationAttachmentHandles.js');
  const { readHistoricalCompressionHandleCatalog } = f.kernelFile('historicalCompressionHandleCatalog.js');
  const { rebuildHistoricalConversationContextHandleState } = f.kernelFile('conversationChildHandles.js');
  const current = (...entries) => ({ entries, retiredRefs: [],
    identityContractRevision: handles.CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION });
  const shape = root => ({ rootNodeId: root.root_node_id, tailNodeId: root.tail_node_id,
    tailSegmentCount: root.tail_segment_count, segmentCount: root.segment_count });
  const root = (id, conversationId, nodeId, count, sequence) => ({
    id, conversation_id: conversationId, root_seq: sequence, root_node_id: nodeId,
    tail_node_id: null, tail_segment_count: 0n, segment_count: count, estimated_tokens: count, created_at: NOW
  });

  test('H6 a discarded frozen F1 keeps its ordinal reserved while the next image receives F2', async () => {
    const { conversationId, turnId } = await f.createTurn('h6-fork');
    const database = f.database(), store = f.store();
    const oldContent = await store.ingest(database, Buffer.from('old image'), 'image/png');
    const newContent = await store.ingest(database, Buffer.from('new image'), 'image/png');
    const oldAttachment = { attachmentId: 'h6-old-image', name: 'old.png', mimeType: 'image/png', sizeBytes: 9 };
    const newAttachment = { attachmentId: 'h6-new-image', name: 'new.png', mimeType: 'image/png', sizeBytes: 9 };
    const frozen = { kind: 'attachment', ref: 'F1', target: oldAttachment.attachmentId,
      name: oldAttachment.name, mimeType: oldAttachment.mimeType, sizeBytes: oldAttachment.sizeBytes };
    const recipe = await store.ingest(database, JSON.stringify({ kind: 'reliable-agent-turn',
      modelHandleCatalog: { entries: [frozen] } }), 'application/vnd.limcode.model-request-recipe+json');
    await database.transaction([
      repo('Attachment').insert({ id: oldAttachment.attachmentId, sha256: oldContent.sha256,
        byte_length: oldContent.byte_length, mime_type: oldAttachment.mimeType, name: oldAttachment.name,
        storage_mode: 'cas', content_object_id: oldContent.id, created_at: NOW }),
      repo('Attachment').insert({ id: newAttachment.attachmentId, sha256: newContent.sha256,
        byte_length: newContent.byte_length, mime_type: newAttachment.mimeType, name: newAttachment.name,
        storage_mode: 'cas', content_object_id: newContent.id, created_at: NOW }),
      repo('ConversationBranchLink').insert({ id: 'h6-branch', target_conversation_id: conversationId,
        source_conversation_id: 'h6-discarded-source', source_message_revision_id: null, created_at: NOW }),
      ...modelRequestAggregate(turnId, 'h6-copied-request', 1n,
        { recipe: recipe.id, body: oldContent.id, checkpoints: 0 })
    ]);
    const registry = new ConversationAttachmentHandleRegistry(database, { contentStore: store, now: () => NOW });
    assert.deepEqual(await registry.peek(conversationId, []), { entries: [] });
    assert.deepEqual(await f.rows('ConversationAttachmentHandleLink', { conversation_id: conversationId }), []);
    assert.deepEqual(await registry.ensure(conversationId, []), { entries: [] });
    const [reserved] = await f.rows('ConversationAttachmentHandleLink', { conversation_id: conversationId });
    assert.equal(reserved.attachment_id, oldAttachment.attachmentId);
    assert.equal(reserved.handle_seq, 1n);
    assert.deepEqual(await f.rows('AttachmentLink', { attachment_id: oldAttachment.attachmentId }), []);
    const visible = await registry.ensure(conversationId, [newAttachment]);
    assert.deepEqual(visible.entries, [{ kind: 'attachment', ref: 'F2', target: newAttachment.attachmentId,
      name: newAttachment.name, mimeType: newAttachment.mimeType, sizeBytes: newAttachment.sizeBytes }]);
    const catalog = handles.buildModelHandleCatalog([], visible.entries);
    assert.throws(() => handles.resolveModelToolArguments('read', { attachmentRef: 'F1' }, catalog), /当前可用/);
    assert.deepEqual(handles.resolveModelToolArguments('read', { attachmentRef: 'F2' }, catalog),
      { attachmentId: newAttachment.attachmentId });
    assert.equal((await f.rows('ConversationAttachmentHandleLink', { conversation_id: conversationId }))
      .find(row => row.handle_seq === 1n).attachment_id, oldAttachment.attachmentId);
  });

  test('H7 a fork freezes its exact prefix in a private artifact and keeps creation scope after continuation and source deletion', async () => {
    const { conversationId: sourceId } = await f.createTurn('h7-source');
    let database = f.database(), store = f.store();
    const prefixContent = await store.ingest(database, 'immutable prefix', 'text/plain');
    const suffixContent = await store.ingest(database, 'discarded source suffix', 'text/plain');
    const prefixRoot = root('h7-prefix-root', sourceId, 'h7-prefix-node', 1n, 1n);
    const wholeRoot = root('h7-whole-root', sourceId, 'h7-suffix-node', 2n, 2n);
    const prefixCatalog = current({ kind: 'process', ref: 'P1', target: 'h7-prefix-process' });
    const sourceState = await state.readConversationContextHandleStateRow(database, sourceId);
    await database.transaction([
      repo('ContextSegment').insert({ id: 'h7-prefix-segment', content_object_id: prefixContent.id,
        segment_kind: 'runtime_context', created_at: NOW }),
      repo('ContextSequenceNode').insert({ id: 'h7-prefix-node', parent_node_id: null,
        segment_id: 'h7-prefix-segment', created_at: NOW }),
      repo('ContextSegment').insert({ id: 'h7-suffix-segment', content_object_id: suffixContent.id,
        segment_kind: 'runtime_context', created_at: NOW }),
      repo('ContextSequenceNode').insert({ id: 'h7-suffix-node', parent_node_id: 'h7-prefix-node',
        segment_id: 'h7-suffix-segment', created_at: NOW }),
      repo('ContextSequenceRoot').insert(prefixRoot),
      repo('ContextSequenceRoot').insert(wholeRoot),
      repo('ConversationContextHeadLink').insert({ id: 'h7-source-head', conversation_id: sourceId,
        root_id: prefixRoot.id, updated_at: NOW }),
      ...await state.prepareReadyConversationContextHandleState({ database, contentStore: store,
        conversationId: sourceId, current: sourceState, contextRootId: prefixRoot.id, rootShape: shape(prefixRoot),
        catalog: prefixCatalog, requiresNativeReset: false, now: NOW })
    ]);
    const readySource = await state.readConversationContextHandleStateRow(database, sourceId);
    await database.transaction([
      repo('ConversationContextHeadLink').update('h7-source-head', { root_id: wholeRoot.id, updated_at: NOW }),
      ...await state.prepareReadyConversationContextHandleState({ database, contentStore: store,
        conversationId: sourceId, current: readySource, contextRootId: wholeRoot.id, rootShape: shape(wholeRoot),
        catalog: handles.buildModelHandleCatalog([{ processId: 'h7-discarded-process' }], prefixCatalog),
        requiresNativeReset: false, now: NOW })
    ]);
    const selected = await reservations.readExactForkContextHandleSnapshot({ database, contentStore: store,
      sourceConversationId: sourceId, sourceRoot: wholeRoot, selectedShape: shape(prefixRoot) });
    assert.deepEqual(selected.catalog.entries, prefixCatalog.entries);
    assert.equal(selected.catalog.entries.some(entry => entry.target === 'h7-discarded-process'), false);
    const targetId = 'h7-target-conversation';
    const creationRoot = root('h7-target-creation-root', targetId, prefixRoot.root_node_id, 1n, 1n);
    const prepared = await reservations.prepareForkContextHandleReservations({ database, contentStore: store,
      sourceConversationId: sourceId, targetConversationId: targetId,
      targetContextRootId: creationRoot.id, rootShape: shape(creationRoot),
      catalog: selected.catalog, coveredRecipeObjectIds: [], now: NOW });
    await database.transaction([
      ...selected.assertions,
      repo('Conversation').insert({ id: targetId, title: 'Frozen prefix', status: 'active', created_at: NOW, updated_at: NOW }),
      repo('ConversationBranchLink').insert({ id: 'h7-target-branch', target_conversation_id: targetId,
        source_conversation_id: sourceId, source_message_revision_id: null, created_at: NOW }),
      repo('ContextSequenceRoot').insert(creationRoot),
      repo('ConversationContextHeadLink').insert({ id: 'h7-target-head', conversation_id: targetId,
        root_id: creationRoot.id, updated_at: NOW }),
      ...prepared.steps
    ]);
    const copied = (await database.materializeContext(creationRoot.id)).snapshot;
    assert.deepEqual(copied.records.map(record => record.segment.id), ['h7-prefix-segment']);
    const [privateProjection] = await f.rows('ModelContextProjection', {
      owner_kind: 'conversation_handle_catalog', owner_id: targetId
    });
    assert.notEqual(privateProjection.root_id, creationRoot.id);
    assert.deepEqual(await reservations.readForkContextHandleReservationCatalog(database, store, targetId), selected.catalog);
    const [creationScope] = await f.rows(state.CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN, { context_root_id: creationRoot.id });
    const [creationMetadata] = await f.rows('ContentObject', { id: creationScope.content_object_id });
    const creationBytes = await store.read(creationMetadata);
    const targetCurrent = await state.readConversationContextHandleStateRow(database, targetId);
    const targetContent = await store.ingest(database, 'target continues from its retained prefix', 'text/plain');
    const continuationRoot = root('h7-target-continuation-root', targetId, 'h7-target-node', 2n, 3n);
    await database.transaction([
      repo('ContextSegment').insert({ id: 'h7-target-segment', content_object_id: targetContent.id,
        segment_kind: 'runtime_context', created_at: NOW }),
      repo('ContextSequenceNode').insert({ id: 'h7-target-node', parent_node_id: 'h7-prefix-node',
        segment_id: 'h7-target-segment', created_at: NOW }),
      repo('ContextSequenceRoot').insert(continuationRoot),
      repo('ConversationContextHeadLink').update('h7-target-head', { root_id: continuationRoot.id, updated_at: NOW }),
      ...await state.prepareReadyConversationContextHandleState({ database, contentStore: store,
        conversationId: targetId, current: targetCurrent, contextRootId: continuationRoot.id, rootShape: shape(continuationRoot),
        catalog: handles.buildModelHandleCatalog([{ processId: 'h7-target-new-process' }], selected.catalog),
        requiresNativeReset: false, now: NOW }),
      repo('Conversation').delete(sourceId)
    ]);
    await f.reopen();
    database = f.database(); store = f.store();
    assert.deepEqual(await f.rows('Conversation', { id: sourceId }), []);
    await reservations.assertForkContextHandleReservations(database, store, targetId, sourceId);
    assert.deepEqual(await reservations.readForkContextHandleReservationCatalog(database, store, targetId), selected.catalog);
    assert.equal((await state.readConversationContextHandleStateRow(database, targetId)).context_root_id, continuationRoot.id);
    assert.deepEqual(await f.rows(state.CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN, { context_root_id: creationRoot.id }), [creationScope]);
    assert.deepEqual(await store.read(creationMetadata), creationBytes);
    await assert.rejects(reservations.assertForkContextHandleReservations(database, store, targetId, 'h7-other-source'), /bound/);
  });

  test('H8 a published compression replays its exact frozen source and rejects a changed source without rewriting CAS', async () => {
    const { conversationId, turnId } = await f.createTurn('h8');
    const database = f.database(), store = f.store();
    const source = await store.ingest(database, JSON.stringify({ kind: 'tool_pair',
      toolCall: { toolName: 'bash', arguments: { command: 'start a process' } },
      toolModelResult: { status: 'succeeded', detail: { processId: 'h8-old-process', status: 'running' } }
    }), 'application/vnd.limcode.tool-pair+json');
    const identities = [{ segmentId: 'h8-segment', contentObjectId: source.id, segmentKind: 'tool_pair' }];
    // sourceHash is the published recipe's required prefix identity, not an extra diagnostic digest.
    const sourceHash = createHash('sha256').update(JSON.stringify(identities)).digest('hex');
    const recipe = { kind: 'reliable-context-compression', compressionMethodKind: 'llm_summary', trigger: 'manual',
      sourceRootId: 'h8-root', sourceSegmentCount: 1, sourceHash,
      attachmentCatalogState: { catalog: [], placements: [] }, modelHandleCatalog: { entries: [] } };
    const frozen = await store.ingest(database, JSON.stringify(recipe), 'application/json');
    const changedRecipe = { ...recipe, sourceRootId: 'h8-unrelated-root' };
    const changedFrozen = await store.ingest(database, JSON.stringify(changedRecipe), 'application/json');
    await database.transaction([
      repo('ContextSegment').insert({ id: 'h8-segment', content_object_id: source.id,
        segment_kind: 'tool_pair', created_at: NOW }),
      repo('ContextSequenceNode').insert({ id: 'h8-node', parent_node_id: null,
        segment_id: 'h8-segment', created_at: NOW }),
      repo('ContextSequenceRoot').insert(root('h8-root', conversationId, 'h8-node', 1n, 1n)),
      ...modelRequestAggregate(turnId, 'h8-request', 1n, { recipe: frozen.id, body: source.id, checkpoints: 1 }),
      repo('ModelContextProjection').insert({ id: 'h8-projection', owner_kind: 'model_request',
        owner_id: 'h8-request', root_id: 'h8-root', purpose: 'provider-request', created_at: NOW }),
      ...modelRequestAggregate(turnId, 'h8-changed-request', 2n,
        { recipe: changedFrozen.id, body: source.id, checkpoints: 1 }),
      repo('ModelContextProjection').insert({ id: 'h8-changed-projection', owner_kind: 'model_request',
        owner_id: 'h8-changed-request', root_id: 'h8-root', purpose: 'provider-request', created_at: NOW })
    ]);
    const metadataBefore = await f.rows('ContentObject');
    const sourceBytes = await store.read(source);
    const recipeBytes = await store.read(frozen);
    const changedBytes = await store.read(changedFrozen);
    const evidence = await readHistoricalCompressionHandleCatalog(database, store,
      { recipe, requestId: 'h8-request', conversationId });
    assert.deepEqual(evidence.entries, []);
    assert.deepEqual(evidence.retiredRefs, ['P1']);
    assert.equal(handles.modelHandleRef(handles.buildModelHandleCatalog([{ processId: 'h8-new-process' }], evidence),
      'process', 'h8-new-process'), 'P2');
    await assert.rejects(readHistoricalCompressionHandleCatalog(database, store,
      { recipe: changedRecipe, requestId: 'h8-changed-request', conversationId }), error =>
      error.code === 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT'
      && /source root differs from its frozen Context projection/.test(error.message));
    assert.deepEqual(await readHistoricalCompressionHandleCatalog(database, store,
      { recipe, requestId: 'h8-request', conversationId }), evidence);
    assert.deepEqual(await f.rows('ContentObject'), metadataBefore);
    assert.deepEqual(await store.read(source), sourceBytes);
    assert.deepEqual(await store.read(frozen), recipeBytes);
    assert.deepEqual(await store.read(changedFrozen), changedBytes);
  });

  test('H9 legacy P and A ambiguity retires old refs and allocates above high-water while current conflicts remain strict', () => {
    const legacyA = { entries: [{ kind: 'process', ref: 'P1', target: 'h9-process-a' },
      { kind: 'child', ref: 'A1', target: 'h9-child-a' }] };
    const legacyB = { entries: [{ kind: 'process', ref: 'P1', target: 'h9-process-b' },
      { kind: 'child', ref: 'A1', target: 'h9-child-b' }] };
    const original = structuredClone([legacyA, legacyB]);
    const reserved = { ...current(), allocationHighWater: { process: 20, child: 30 } };
    const repaired = handles.reconcileHistoricalModelHandleCatalogs([legacyA, legacyB, reserved]);
    assert.deepEqual([...repaired.retiredRefs].sort(), ['A1', 'P1']);
    assert.deepEqual(repaired.entries.filter(entry => entry.kind === 'process').map(entry => entry.ref).sort(), ['P21', 'P22']);
    assert.deepEqual(repaired.entries.filter(entry => entry.kind === 'child').map(entry => entry.ref).sort(), ['A31', 'A32']);
    assert.throws(() => handles.resolveModelToolArguments('bash', { mode: 'output', processRef: 'P1' }, repaired), /已失效/);
    assert.throws(() => handles.resolveModelToolArguments('run_agent', { operation: 'read', childRef: 'A1' }, repaired), /已失效/);
    const next = handles.buildModelHandleCatalog([{ processId: 'h9-process-new', answerBridgeId: 'h9-child-new' }], repaired);
    assert.equal(handles.modelHandleRef(next, 'process', 'h9-process-new'), 'P23');
    assert.equal(handles.modelHandleRef(next, 'child', 'h9-child-new'), 'A33');
    assert.throws(() => handles.reconcileHistoricalModelHandleCatalogs([
      current({ kind: 'process', ref: 'P1', target: 'h9-process-a' }), legacyB
    ]), error => error.code === 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT' && error.conflict.kind === 'process');
    assert.deepEqual([legacyA, legacyB], original);
  });

  test('H10 local request commits reuse old evidence and a real external SQLite commit refreshes the scoped frontier', async () => {
    const { conversationId, turnId } = await f.createTurn('h10');
    const database = f.database(), store = f.store();
    const oldRecipe = await store.ingest(database, JSON.stringify({ kind: 'reliable-agent-turn',
      modelHandleCatalog: { entries: [{ kind: 'process', ref: 'P1', target: 'h10-old-process' }] } }), 'application/json');
    const localRecipe = await store.ingest(database, JSON.stringify({ kind: 'reliable-agent-turn',
      modelHandleCatalog: { entries: [{ kind: 'process', ref: 'P2', target: 'h10-local-process' }] } }), 'application/json');
    const externalRecipe = await store.ingest(database, JSON.stringify({ kind: 'reliable-agent-turn',
      modelHandleCatalog: { entries: [{ kind: 'process', ref: 'P1', target: 'h10-imported-process' }] } }), 'application/json');
    await database.transaction(modelRequestAggregate(turnId, 'h10-old-request', 1n,
      { recipe: oldRecipe.id, body: oldRecipe.id, checkpoints: 0 }));
    const [oldRequest] = await f.rows('ModelRequest', { id: 'h10-old-request' });
    const oldBytes = await store.read(oldRecipe);
    const reads = [];
    let frontiers = 0;
    const originalRead = store.read;
    const originalFrontier = database.contextHandleEvidenceFrontier;
    store.read = async function (metadata) { reads.push(metadata.id); return originalRead.call(this, metadata); };
    database.contextHandleEvidenceFrontier = async function (...args) {
      frontiers += 1;
      return originalFrontier.apply(this, args);
    };
    const read = async () => (await rebuildHistoricalConversationContextHandleState(database, store, conversationId)).catalog;
    try {
      assert.equal(handles.modelHandleRef(await read(), 'process', 'h10-old-process'), 'P1');
      assert.equal(frontiers, 1);
      reads.length = 0;
      await database.transaction(modelRequestAggregate(turnId, 'h10-local-request', 2n,
        { recipe: localRecipe.id, body: localRecipe.id, checkpoints: 0 }));
      const local = await read();
      assert.equal(handles.modelHandleRef(local, 'process', 'h10-local-process'), 'P2');
      assert.equal(frontiers, 1);
      assert.deepEqual(reads, [localRecipe.id]);
      const versionBefore = await database.externalDataVersion();
      const externalSteps = modelRequestAggregate(turnId, 'h10-external-request', 3n,
        { recipe: externalRecipe.id, body: externalRecipe.id, checkpoints: 0 });
      const other = new Database(database.binding.paths.databasePath);
      try {
        other.pragma('foreign_keys = ON');
        other.transaction(() => {
          for (const step of externalSteps) {
            const repository = repo(step.domain);
            const encoded = repository.codec.encodeInsert(step.row);
            const columns = Object.keys(encoded);
            other.prepare(`INSERT INTO ${repository.schema.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
              .run(...Object.values(encoded));
          }
        })();
      } finally { other.close(); }
      assert.notEqual(await database.externalDataVersion(), versionBefore);
      reads.length = 0;
      const imported = await read();
      assert.equal(frontiers, 2);
      assert.deepEqual(imported.retiredRefs, ['P1']);
      assert.equal(handles.modelHandleRef(imported, 'process', 'h10-local-process'), 'P2');
      assert.ok(handles.modelHandleRef(imported, 'process', 'h10-imported-process'));
      assert.deepEqual(reads, [externalRecipe.id]);
      assert.deepEqual(await f.rows('ModelRequest', { id: 'h10-old-request' }), [oldRequest]);
      assert.deepEqual(await originalRead.call(store, oldRecipe), oldBytes);
    } finally {
      store.read = originalRead;
      database.contextHandleEvidenceFrontier = originalFrontier;
    }
  });
}
