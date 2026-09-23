import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as kernel from '../../dist/extension/backend/reliableKernel/index.js';
import { prepareConversationForkSnapshot } from '../../dist/extension/backend/reliableKernel/conversationForkSnapshot.js';
import { createLlmProviderCapability } from '../../dist/extension/backend/capabilities/llmProvider.js';

const NOW = '2026-08-20T00:00:00.000Z';

async function withRuntime(label, body) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-${label}-`));
  let database;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    database = await kernel.RuntimeDatabase.open(candidate.authority, { hostBootId: label });

    const store = new kernel.ContentAddressedStore(candidate.authority, candidate.binding);
    const fixtureContent = await store.ingest(
      database,
      JSON.stringify({ role: 'user', parts: [{ text: 'fixture' }] }),
      'application/vnd.limcode.message+json'
    );
    await body(database, fixtureContent, store);
  } finally {
    if (database) await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

test('compression persists reusable Attachment observations and replacement inherits provenance links', async () => {
  await withRuntime('attachment-observation-persistence', async (database, _fixtureContent, store) => {
    const seeded = await seedObservationCompressionTurn(database, store);
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    const attachment = {
      attachmentId: 'attachment-observation-target',
      name: 'observation-target.png',
      mimeType: 'image/png',
      sizeBytes: 42
    };
    await database.transaction([repository('Attachment').insert({
      id: attachment.attachmentId,
      sha256: 'c'.repeat(64),
      byte_length: BigInt(attachment.sizeBytes),
      mime_type: attachment.mimeType,
      name: attachment.name,
      storage_mode: 'managed',
      content_object_id: null,
      created_at: NOW
    })]);
    const profileSha256 = 'd'.repeat(64);
    const observation = {
      attachmentId: attachment.attachmentId,
      analysisProfileSha256: profileSha256,
      document: {
        kind: 'attachment_observation',
        analysisProfileSha256: profileSha256,
        summary: 'A red visual status indicator.',
        salientFacts: ['The status indicator is red.'],
        uncertainties: ['The surrounding interface is not visible.']
      }
    };
    const context = new kernel.ContextSequenceControlPlane(database, store);
    const compression = new kernel.ContextCompressionControlPlane(database, store);
    const sourceRootId = await context.currentHeadRootId(seeded.conversationId);
    const createCommand = {
      conversationId: seeded.conversationId,
      headRootId: sourceRootId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      compressSegmentCount: 1,
      title: 'observation compression',
      summary: 'SUMMARY-WITH-OBSERVATION',
      attachmentObservations: [observation],
      idempotencyKey: 'observation-create'
    };
    const created = await compression.create(createCommand);
    const observationRows = await listDomainRows(database, 'AttachmentObservationLink', {
      attachment_id: attachment.attachmentId,
      analysis_profile_sha256: profileSha256
    });
    assert.equal(observationRows.length, 1);
    const observationRow = observationRows[0];
    const blockLinks = await listDomainRows(database, 'CompressionBlockObservationLink', {
      compression_block_id: created.compressionBlockId
    });
    assert.equal(blockLinks.length, 1);
    assert.equal(blockLinks[0].observation_id, observationRow.id);
    assert.equal(blockLinks[0].position, 0n);
    const observationContent = await store.read(await getDomainRow(
      database,
      'ContentObject',
      observationRow.content_object_id
    ));
    assert.deepEqual(JSON.parse(observationContent.toString('utf8')), observation.document);

    const requirements = await kernel.loadAttachmentObservationRequirements(
      database,
      store,
      [attachment],
      { entries: [{
        kind: 'attachment', ref: 'F1', target: attachment.attachmentId,
        name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes
      }] },
      profileSha256
    );
    assert.deepEqual(requirements, [{
      attachmentRef: 'F1',
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      cachedObservation: {
        attachmentRef: 'F1',
        summary: observation.document.summary,
        salientFacts: observation.document.salientFacts,
        uncertainties: observation.document.uncertainties
      }
    }]);

    const commitBeforeReplay = (await database.inspect()).currentCommitSeq;
    const replay = await compression.create(createCommand);
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.compressionBlockId, created.compressionBlockId);
    assert.equal((await database.inspect()).currentCommitSeq, commitBeforeReplay);
    assert.equal((await listDomainRows(database, 'AttachmentObservationLink', {})).length, 1);
    await assert.rejects(
      compression.create({
        ...createCommand,
        attachmentObservations: [{
          ...observation,
          document: { ...observation.document, summary: 'CONFLICTING OBSERVATION' }
        }]
      }),
      (error) => error?.code === 'COMPRESSION_IDEMPOTENCY_CONFLICT'
    );

    const replacementCommand = {
      conversationId: seeded.conversationId,
      previousBlockId: created.compressionBlockId,
      expectedHeadRootId: created.rootId,
      title: 'replacement observation compression',
      summary: 'REPLACEMENT-SUMMARY',
      previousStatus: 'disabled',
      idempotencyKey: 'observation-replacement'
    };
    const replacement = await compression.replace(replacementCommand);
    const replacementLinks = await listDomainRows(database, 'CompressionBlockObservationLink', {
      compression_block_id: replacement.compressionBlockId
    });
    assert.equal(replacementLinks.length, 1);
    assert.equal(replacementLinks[0].observation_id, observationRow.id);
    assert.equal(replacementLinks[0].position, 0n);
    assert.equal((await listDomainRows(database, 'AttachmentObservationLink', {})).length, 1);
    const replacementReplay = await compression.replace(replacementCommand);
    assert.equal(replacementReplay.deduplicated, true);
    assert.equal(replacementReplay.compressionBlockId, replacement.compressionBlockId);
  });
});

test('unavailable observations remain visible but never become reusable observation commits', () => {
  const profile = 'd'.repeat(64);
  const first = {
    attachmentRef: 'F1', attachmentId: 'unavailable-image', name: 'unavailable.png',
    mimeType: 'image/png', sizeBytes: 42
  };
  const second = { ...first, attachmentRef: 'F2', attachmentId: 'observed-image', name: 'observed.png' };
  const unavailable = {
    attachmentRef: 'F1', summary: 'Original attachment preserved without analysis.', salientFacts: [],
    uncertainties: ['Attachment content was not observed; visual or media details remain unknown.']
  };
  const observed = {
    attachmentRef: 'F2', summary: 'A red indicator.', salientFacts: ['The indicator is red.'], uncertainties: []
  };
  const requirements = [first, second];
  const observations = [unavailable, observed];
  const state = kernel.renderAttachmentObservationStateContent(requirements, observations);
  kernel.assertAttachmentObservationStateContent([state], requirements, observations);
  assert.match(state.parts[0].text, /Attachment content was not observed/);
  const commits = kernel.completeAttachmentObservationCommits(requirements, observations, profile);
  assert.deepEqual(commits.map((entry) => entry.attachmentId), [second.attachmentId]);
  assert.equal(commits[0].document.summary, observed.summary);
  assert.deepEqual(kernel.completeAttachmentObservationCommits([first], [unavailable], profile), []);
  assert.throws(() => kernel.completeAttachmentObservationCommits(requirements, [observed], profile), /one observation/);
  assert.throws(() => kernel.completeAttachmentObservationCommits(requirements, [unavailable, unavailable], profile), /duplicate/);
  assert.throws(() => kernel.completeAttachmentObservationCommits([first, first], observations, profile), /duplicate identities/);
  assert.throws(() => kernel.completeAttachmentObservationCommits(
    [first, { ...second, attachmentId: first.attachmentId }], observations, profile
  ), /duplicate identities/);
  assert.throws(() => kernel.completeAttachmentObservationCommits(
    requirements, [unavailable, { ...observed, attachmentRef: 'F3' }], profile
  ), /omitted/);
  assert.throws(() => kernel.completeAttachmentObservationCommits(
    [first], [{ ...unavailable, summary: '' }], profile
  ), /non-empty/);
});

test('unavailable observation documents are rejected at the durable encoding boundary', () => {
  assert.throws(() => kernel.attachmentObservationDocumentContent({
    kind: 'attachment_observation', analysisProfileSha256: 'd'.repeat(64),
    summary: 'Original attachment preserved without analysis.', salientFacts: [],
    uncertainties: ['Attachment content was not observed; visual or media details remain unknown.']
  }), /unavailable.*cannot be cached/i);
});

test('current observation contract isolates persisted unavailable caches without rewriting history', async () => {
  await withRuntime('attachment-observation-cache-contract', async (database, _fixtureContent, store) => {
    const seeded = await seedObservationCompressionTurn(database, store);
    const bytes = Buffer.from('original attachment content');
    const mediaContent = await store.ingest(database, bytes, 'image/png');
    const attachment = {
      attachmentId: 'cached-unavailable-attachment', name: 'cached-unavailable.png',
      mimeType: 'image/png', sizeBytes: bytes.byteLength
    };
    const attachmentRow = {
      id: attachment.attachmentId, sha256: mediaContent.sha256, byte_length: BigInt(bytes.byteLength),
      mime_type: attachment.mimeType, name: attachment.name, storage_mode: 'managed',
      content_object_id: mediaContent.id, created_at: NOW
    };
    const provider = { providerConfigId: 'cache-contract-provider', provider: 'gemini', modelId: 'cache-contract-model' };
    const previousProfile = createHash('sha256').update(kernel.canonicalPlainJson({
      kind: 'attachment_observation_analysis_profile', promptRevision: '2026-08-21', ...provider
    }, 'previous observation profile')).digest('hex');
    const unavailable = {
      attachmentRef: 'F1', summary: 'Original attachment preserved without analysis.', salientFacts: [],
      uncertainties: ['Attachment content was not observed; visual or media details remain unknown.']
    };
    const previousDocument = JSON.stringify({
      kind: 'attachment_observation', analysisProfileSha256: previousProfile,
      summary: unavailable.summary, salientFacts: unavailable.salientFacts, uncertainties: unavailable.uncertainties
    });
    const previousContent = await store.ingest(database, previousDocument, kernel.ATTACHMENT_OBSERVATION_CONTENT_TYPE);
    const previousLink = {
      id: kernel.attachmentObservationLinkId(attachment.attachmentId, previousProfile),
      attachment_id: attachment.attachmentId, analysis_profile_sha256: previousProfile,
      content_object_id: previousContent.id, created_at: NOW
    };
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Attachment').insert(attachmentRow),
      kernel.DOMAIN_REPOSITORIES.domain('AttachmentObservationLink').insert(previousLink)
    ]);
    const handles = { entries: [{
      kind: 'attachment', ref: 'F1', target: attachment.attachmentId,
      name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes
    }] };
    const profile = kernel.attachmentObservationAnalysisProfileSha256(provider);
    const load = () => kernel.loadAttachmentObservationRequirements(database, store, [attachment], handles, profile);
    const requirements = await load();
    assert.notEqual(profile, previousProfile);
    assert.equal(requirements[0].cachedObservation, undefined);
    const context = new kernel.ContextSequenceControlPlane(database, store);
    const compression = new kernel.ContextCompressionControlPlane(database, store);
    const create = async (observation, id) => {
      const command = {
        conversationId: seeded.conversationId, headRootId: await context.currentHeadRootId(seeded.conversationId),
        authoritySnapshotId: seeded.authoritySnapshotId, compressSegmentCount: 1, title: id, idempotencyKey: id,
        summary: [kernel.renderAttachmentObservationStateContent(requirements, [observation])],
        attachmentObservations: kernel.completeAttachmentObservationCommits(requirements, [observation], profile)
      };
      return { command, result: await compression.create(command) };
    };
    const unavailableCompression = await create(unavailable, 'current-contract-unavailable');
    const unavailableBlock = await getDomainRow(database, 'CompressionBlock', unavailableCompression.result.compressionBlockId);
    const unavailableSummary = await getDomainRow(database, 'ContentObject', unavailableBlock.summary_object_id);
    const unavailableSummaryBytes = await store.read(unavailableSummary);
    assert.equal((await load())[0].cachedObservation, undefined);
    assert.equal((await listDomainRows(database, 'AttachmentObservationLink', {})).length, 1);
    const recovered = {
      attachmentRef: 'F1', summary: 'Recovered observation under the current contract.',
      salientFacts: ['The indicator is red.'], uncertainties: []
    };
    const recoveredCompression = await create(recovered, 'current-contract-recovered');
    assert.deepEqual((await load())[0].cachedObservation, recovered);
    assert.equal((await listDomainRows(database, 'AttachmentObservationLink', {})).length, 2);
    assert.deepEqual(await getDomainRow(database, 'AttachmentObservationLink', previousLink.id), previousLink);
    assert.equal((await store.read(previousContent)).toString('utf8'), previousDocument);
    assert.deepEqual(await store.read(unavailableSummary), unavailableSummaryBytes);
    assert.deepEqual(await getDomainRow(database, 'Attachment', attachment.attachmentId), attachmentRow);
    assert.deepEqual(await store.read(mediaContent), bytes);
    assert.equal((await compression.create(recoveredCompression.command)).deduplicated, true);
    await assert.rejects(
      kernel.loadAttachmentObservationRequirements(database, store, [attachment], handles, previousProfile),
      /Unavailable attachment observations cannot be cached/
    );
  });
});

test('unavailable observations recover through real provider calls and database commits without rewriting history', async (t) => {
  await withRuntime('attachment-observation-recovery', async (database, _fixtureContent, store) => {
    const seeded = await seedObservationCompressionTurn(database, store);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XkW5WQAAAABJRU5ErkJggg==', 'base64');
    const mediaContent = await store.ingest(database, bytes, 'image/png');
    const attachment = {
      attachmentId: 'attachment-observation-target', name: 'observation-target.png',
      mimeType: 'image/png', sizeBytes: bytes.byteLength
    };
    await database.transaction([kernel.DOMAIN_REPOSITORIES.domain('Attachment').insert({
      id: attachment.attachmentId, sha256: mediaContent.sha256, byte_length: BigInt(bytes.byteLength),
      mime_type: attachment.mimeType, name: attachment.name, storage_mode: 'managed',
      content_object_id: mediaContent.id, created_at: NOW
    })]);
    const originalAttachment = await getDomainRow(database, 'Attachment', attachment.attachmentId);
    const profile = 'd'.repeat(64);
    const handles = { entries: [{
      kind: 'attachment', ref: 'F1', target: attachment.attachmentId,
      name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes
    }] };
    const recovered = {
      attachmentRef: 'F1', summary: 'Recovered real visual observation.',
      salientFacts: ['The indicator is red.'], uncertainties: []
    };
    let rejectObservation = true;
    let observationCalls = 0;
    let summaryCalls = 0;
    t.mock.method(globalThis, 'fetch', async (_input, init) => {
      assert.equal(typeof init.body, 'string');
      const observation = init.body.includes('Attachment observation contract revision');
      if (observation) observationCalls += 1;
      else summaryCalls += 1;
      if (observation && rejectObservation) {
        return new Response(JSON.stringify({ error: { message: 'Upstream request failed', type: 'upstream_error' } }), {
          status: 400, headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({
        id: 'offline-observation-recovery', object: 'chat.completion', created: 1, model: 'gpt-test',
        choices: [{ index: 0, message: {
          role: 'assistant', content: observation ? JSON.stringify(recovered) : '<summary>Preserve image F1.</summary>'
        }, finish_reason: 'stop' }]
      }), { headers: { 'content-type': 'application/json' } });
    });
    const capability = createLlmProviderCapability({
      settings: {
        id: 'offline-observation-provider', name: 'Offline observation provider', provider: 'openai-compatible',
        baseUrl: 'https://provider.invalid/v1', apiKey: 'offline-placeholder', model: 'gpt-test',
        models: [], modelConfigs: [], toolCallFormat: 'function-call', openaiResponsesTransport: 'http',
        stream: false, retryOnError: false, retryMaxAttempts: 0, enableMultimodalTools: true,
        contextWindowTokens: 65_536, createdAt: 1, updatedAt: 1
      },
      async resolveAttachment() {
        return { inlineData: {
          mimeType: attachment.mimeType, name: attachment.name, attachmentId: attachment.attachmentId,
          data: bytes.toString('base64'), sizeBytes: bytes.byteLength
        } };
      }
    });
    const context = new kernel.ContextSequenceControlPlane(database, store);
    const compression = new kernel.ContextCompressionControlPlane(database, store);
    const load = () => kernel.loadAttachmentObservationRequirements(database, store, [attachment], handles, profile);
    async function compress(id) {
      const requirements = await load();
      const terminal = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Observation recovery timed out.')), 10_000);
        capability.compact({
          id, blockId: `${id}-block`, conversationId: seeded.conversationId, methodKind: 'llm_summary',
          methodConfigSnapshot: {
            id: 'observation-recovery', name: 'Observation recovery', kind: 'llm_summary',
            trigger: { mode: 'manual' }, llmSummary: { targetTokens: 1_000 }, createdAt: 1, updatedAt: 1
          },
          contents: [{ role: 'user', parts: [
            { text: 'Preserve the actual visual evidence during compression.' },
            { inlineData: {
              mimeType: attachment.mimeType, name: attachment.name, attachmentId: attachment.attachmentId,
              sha256: mediaContent.sha256, sizeBytes: bytes.byteLength, storage: 'managed'
            } }
          ] }],
          attachmentObservationProfileSha256: profile, attachmentObservationRequirements: requirements
        }, (event) => {
          if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
          clearTimeout(timer);
          resolve(event);
        });
      });
      assert.equal(terminal.type, 'llm:compactDone', terminal.payload.message);
      const result = terminal.payload.result;
      kernel.assertAttachmentObservationStateContent(result.contents, requirements, result.attachmentObservations);
      const command = {
        conversationId: seeded.conversationId, headRootId: await context.currentHeadRootId(seeded.conversationId),
        authoritySnapshotId: seeded.authoritySnapshotId, compressSegmentCount: 1,
        title: id, summary: result.contents, idempotencyKey: id,
        attachmentObservations: kernel.completeAttachmentObservationCommits(requirements, result.attachmentObservations, profile)
      };
      return { created: await compression.create(command), command, result, cached: await load() };
    }
    try {
      const first = await compress('observation-unavailable-first');
      const firstBlock = await getDomainRow(database, 'CompressionBlock', first.created.compressionBlockId);
      const firstSummaryMetadata = await getDomainRow(database, 'ContentObject', firstBlock.summary_object_id);
      const firstSummary = await store.read(firstSummaryMetadata);
      const second = await compress('observation-unavailable-again');
      rejectObservation = false;
      const successful = await compress('observation-recovered');
      const reused = await compress('observation-reused');
      assert.equal(first.cached[0].cachedObservation, undefined);
      assert.equal(second.cached[0].cachedObservation, undefined);
      assert.deepEqual(successful.cached[0].cachedObservation, recovered);
      assert.deepEqual(reused.result.attachmentObservations, [recovered]);
      assert.equal(observationCalls, 3, 'retry failed observations but reuse the first successful result');
      assert.equal(summaryCalls, 4);
      assert.equal((await listDomainRows(database, 'AttachmentObservationLink', {})).length, 1);
      for (const attempt of [first, second]) {
        assert.equal((await listDomainRows(database, 'CompressionBlockObservationLink', {
          compression_block_id: attempt.created.compressionBlockId
        })).length, 0);
        assert.match(JSON.stringify(attempt.result.contents), /Attachment content was not observed/);
        assert.equal((await compression.create(attempt.command)).deduplicated, true);
      }
      assert.equal((await listDomainRows(database, 'CompressionBlockObservationLink', {})).length, 2);
      assert.deepEqual(await store.read(firstSummaryMetadata), firstSummary);
      assert.deepEqual(await getDomainRow(database, 'Attachment', attachment.attachmentId), originalAttachment);
      assert.deepEqual(await store.read(mediaContent), bytes);
      const commitSeq = (await database.inspect()).currentCommitSeq;
      assert.equal((await compression.create(successful.command)).deduplicated, true);
      assert.equal((await compression.create(reused.command)).deduplicated, true);
      assert.equal((await database.inspect()).currentCommitSeq, commitSeq);
    } finally {
      capability.dispose();
    }
  });
});

async function seedObservationCompressionTurn(database, store) {
  const conversationId = 'conversation-observation-persistence';
  await database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId, title: 'observation persistence', status: 'active',
      created_at: NOW, updated_at: NOW
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: 'agent-link-observation-persistence',
      conversation_id: conversationId,
      agent_id: 'agent-observation-persistence',
      role: 'default',
      created_at: NOW,
      updated_at: NOW
    })
  ]);
  const control = new kernel.TurnControlPlane(database, store, {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: 'fake-local', modelId: 'fake-model' }) },
          authoritySnapshot: { content: JSON.stringify({
            kind: 'effective-turn-authority',
            turnId: request.turnId,
            executorAgentId: request.executorAgentId,
            modelProfile: {
              compressionThresholdTokens: 1,
              contextWindowTokens: 200_000,
              tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
            },
            model: { providerConfigId: 'fake-local', modelId: 'fake-model', maxOutputTokens: 16_000 },
            policies: { toolPolicyId: 'tools-default', systemPromptId: 'prompt-default' }
          }) }
        };
      }
    }
  });
  const started = await control.input({
    source: { kind: 'command', key: 'observation-persistence-input' },
    conversationId,
    leaseOwnerId: 'observation-persistence-executor',
    hostBootId: 'observation-persistence-boot',
    leaseExpiresAt: '2026-08-22T00:00:00.000Z',
    content: 'user input with one managed visual attachment'
  });
  const authorities = await listDomainRows(database, 'AuthoritySnapshot', { turn_id: started.turnId });
  assert.equal(authorities.length, 1);
  return { conversationId, authoritySnapshotId: authorities[0].id };
}

async function listDomainRows(database, domain, where) {
  const result = await database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }));
  return result.snapshot;
}

async function getDomainRow(database, domain, id) {
  const result = await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain(domain).get(id)]);
  assert.ok(result.snapshot[0], `${domain} ${id} must exist`);
  return result.snapshot[0];
}

test('20 rounds and nested compression rebuild one request-local attachment catalog without durable copies', async () => {
  await withRuntime('attachment-catalog-lineage', async (database, fixtureContent, store) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    const steps = [
      repository('Conversation').insert({
        id: 'conversation-main', title: 'main', status: 'active', created_at: NOW, updated_at: NOW
      }),
      repository('Turn').insert({
        id: 'turn-main', conversation_id: 'conversation-main', status: 'active',
        created_at: NOW, updated_at: NOW, terminal_at: null
      }),
      repository('Attachment').insert({
        id: 'attachment-only-source',
        sha256: 'a'.repeat(64),
        byte_length: 45678n,
        mime_type: 'application/pdf',
        name: 'source.pdf',
        storage_mode: 'managed',
        content_object_id: null,
        created_at: NOW
      })
    ];
    const segments = [];
    for (let index = 0; index < 20; index += 1) {
      const contentId = fixtureContent.id;
      const messageId = `message-${index}`;
      const revisionId = `revision-${index}`;
      const segmentId = `segment-${index}`;
      segments.push({ segmentId });
      steps.push(
        repository('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repository('MessageRevision').insert({
          id: revisionId,
          message_id: messageId,
          revision_seq: 0n,
          role: index % 2 === 0 ? 'user' : 'model',
          content_object_id: contentId,
          created_at: NOW
        }),
        repository('MessagePartOfConversation').insert({
          id: `message-membership-${index}`,
          conversation_id: 'conversation-main',
          message_id: messageId,
          message_seq: BigInt(index + 1),
          created_at: NOW
        }),
        repository('ContextSegment').insert({
          id: segmentId,
          content_object_id: contentId,
          segment_kind: 'message',
          created_at: NOW
        }),
        repository('ContextSegmentSource').insert({
          id: `segment-source-${index}`,
          segment_id: segmentId,
          source_kind: 'message_revision',
          source_id: revisionId,
          source_revision: 0n,
          created_at: NOW
        })
      );
    }
    steps.push(
      repository('AttachmentLink').insert({
        id: 'attachment-link-only-source',
        message_revision_id: 'revision-0',
        attachment_id: 'attachment-only-source',
        position: 0n,
        created_at: NOW
      }),
      repository('CompressionBlock').insert({
        id: 'compression-block-main',
        conversation_id: 'conversation-main',
        status: 'active',
        authority_snapshot_id: 'authority-main',
        title_object_id: fixtureContent.id,
        summary_object_id: fixtureContent.id,
        created_at: NOW,
        updated_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'segment-compression-main',
        content_object_id: fixtureContent.id,
        segment_kind: 'compression',
        created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'segment-compression-main-source',
        segment_id: 'segment-compression-main',
        source_kind: 'compression_block',
        source_id: 'compression-block-main',
        source_revision: 0n,
        created_at: NOW
      }),
      ...segments.map((segment, index) => repository('CompressionBlockSource').insert({
        id: `compression-block-source-${index}`,
        compression_block_id: 'compression-block-main',
        segment_id: segment.segmentId,
        position: BigInt(index),
        created_at: NOW
      }))
    );
    await database.transaction(steps);

    const originalSnapshot = database.snapshot.bind(database);
    let projectionSnapshotCalls = 0;
    database.snapshot = async (...args) => {
      projectionSnapshotCalls += 1;
      return originalSnapshot(...args);
    };
    const projection = new kernel.AttachmentCatalogProjection(database);
    const expected = [{
      attachmentId: 'attachment-only-source',
      name: 'source.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 45678
    }];
    for (let round = 0; round < 20; round += 1) {
      assert.deepEqual(await projection.project('conversation-main', segments), expected);
    }
    const relationCatalogState = await projection.projectState(
      'conversation-main',
      [{ segmentId: 'segment-compression-main' }]
    );
    const relationCatalog = relationCatalogState.catalog;
    assert.deepEqual(relationCatalog, expected);
    assert.deepEqual(relationCatalogState.placements, [{
      kind: 'attachment_catalog_checkpoint',
      afterSegmentId: 'segment-compression-main',
      entries: expected
    }]);
    const handles = kernel.buildModelHandleCatalog([relationCatalog]);
    assert.deepEqual(handles.entries, [{
      kind: 'attachment',
      ref: 'F1',
      target: 'attachment-only-source',
      name: 'source.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 45678
    }]);
    assert.deepEqual(
      kernel.resolveModelToolArguments('read', { attachmentRef: 'F1' }, handles),
      { attachmentId: 'attachment-only-source' }
    );
    assert.ok(
      projectionSnapshotCalls <= 120,
      `isolated 20-round + nested projection should use bounded batched reads, observed ${projectionSnapshotCalls}`
    );
    database.snapshot = originalSnapshot;

    const [concurrentCatalog, concurrentEmpty] = await Promise.all([
      projection.project('conversation-main', [{ segmentId: 'segment-compression-main' }]),
      projection.project('conversation-main', [{ segmentId: 'segment-1' }])
    ]);
    assert.deepEqual(concurrentCatalog, expected);
    assert.deepEqual(concurrentEmpty, []);

    assert.deepEqual(await projection.project('conversation-main', [{ segmentId: 'segment-1' }]), []);
    await database.transaction([
      repository('Attachment').insert({
        id: 'attachment-late-link',
        sha256: 'b'.repeat(64),
        byte_length: 12n,
        mime_type: 'text/plain',
        name: 'late.txt',
        storage_mode: 'managed',
        content_object_id: null,
        created_at: NOW
      }),
      repository('AttachmentLink').insert({
        id: 'attachment-link-late',
        message_revision_id: 'revision-1',
        attachment_id: 'attachment-late-link',
        position: 0n,
        created_at: NOW
      })
    ]);
    const lateAttachment = {
      attachmentId: 'attachment-late-link',
      name: 'late.txt',
      mimeType: 'text/plain',
      sizeBytes: 12
    };
    assert.deepEqual(await projection.project('conversation-main', [{ segmentId: 'segment-1' }]), [
      lateAttachment
    ]);
    assert.deepEqual(await projection.projectState('conversation-main', [
      { segmentId: 'segment-0' },
      { segmentId: 'segment-1' }
    ]), {
      catalog: [...expected, lateAttachment],
      placements: [
        { kind: 'attachment_catalog_delta', afterSegmentId: 'segment-0', entries: expected },
        { kind: 'attachment_catalog_delta', afterSegmentId: 'segment-1', entries: [lateAttachment] }
      ]
    });
    assert.deepEqual(await projection.projectState(
      'conversation-main',
      [{ segmentId: 'segment-0' }],
      ['revision-1']
    ), {
      catalog: [...expected, lateAttachment],
      placements: [
        { kind: 'attachment_catalog_delta', afterSegmentId: 'segment-0', entries: expected },
        { kind: 'current_turn_delta', entries: [lateAttachment] }
      ]
    });

    const [attachments, links, compressionSources] = await Promise.all([
      database.snapshotAll(repository('Attachment').list({ orderBy: { column: 'id', direction: 'asc' }, limit: 100 })),
      database.snapshotAll(repository('AttachmentLink').list({ orderBy: { column: 'id', direction: 'asc' }, limit: 100 })),
      database.snapshotAll(repository('CompressionBlockSource').list({ orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))
    ]);
    assert.equal(attachments.snapshot.length, 2);
    assert.equal(links.snapshot.length, 2);
    assert.equal(compressionSources.snapshot.length, 20);
  });
});

test('message segment content mismatch fails closed before relation attachments are projected', async () => {
  await withRuntime('attachment-catalog-content-mismatch', async (database, fixtureContent, store) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    const otherContent = await store.ingest(
      database,
      JSON.stringify({ role: 'user', parts: [{ text: 'different durable content' }] }),
      'application/vnd.limcode.message+json'
    );
    await database.transaction([
      repository('Conversation').insert({
        id: 'conversation-content-mismatch', title: 'mismatch', status: 'active',
        created_at: NOW, updated_at: NOW
      }),
      repository('Message').insert({
        id: 'message-content-mismatch', created_at: NOW, updated_at: NOW, deleted_at: null
      }),
      repository('MessageRevision').insert({
        id: 'revision-content-mismatch', message_id: 'message-content-mismatch', revision_seq: 0n,
        role: 'user', content_object_id: fixtureContent.id, created_at: NOW
      }),
      repository('MessagePartOfConversation').insert({
        id: 'membership-content-mismatch', conversation_id: 'conversation-content-mismatch',
        message_id: 'message-content-mismatch', message_seq: 1n, created_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'segment-content-mismatch', content_object_id: otherContent.id,
        segment_kind: 'message', created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'source-content-mismatch', segment_id: 'segment-content-mismatch',
        source_kind: 'message_revision', source_id: 'revision-content-mismatch',
        source_revision: 0n, created_at: NOW
      })
    ]);
    const projection = new kernel.AttachmentCatalogProjection(database);
    await assert.rejects(
      projection.project('conversation-content-mismatch', [{ segmentId: 'segment-content-mismatch' }]),
      /content does not match MessageRevision/
    );
  });
});

test('message source revision mismatch fails closed', async () => {
  await withRuntime('attachment-catalog-revision-mismatch', async (database, fixtureContent) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    await database.transaction([
      repository('Conversation').insert({
        id: 'conversation-revision-mismatch', title: 'mismatch', status: 'active',
        created_at: NOW, updated_at: NOW
      }),
      repository('Message').insert({
        id: 'message-mismatch', created_at: NOW, updated_at: NOW, deleted_at: null
      }),
      repository('MessageRevision').insert({
        id: 'revision-mismatch', message_id: 'message-mismatch', revision_seq: 1n,
        role: 'user', content_object_id: fixtureContent.id, created_at: NOW
      }),
      repository('MessagePartOfConversation').insert({
        id: 'membership-revision-mismatch', conversation_id: 'conversation-revision-mismatch',
        message_id: 'message-mismatch', message_seq: 1n, created_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'segment-mismatch', content_object_id: fixtureContent.id,
        segment_kind: 'message', created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'source-mismatch', segment_id: 'segment-mismatch',
        source_kind: 'message_revision', source_id: 'revision-mismatch',
        source_revision: 0n, created_at: NOW
      })
    ]);
    const projection = new kernel.AttachmentCatalogProjection(database);
    await assert.rejects(
      projection.project('conversation-revision-mismatch', [{ segmentId: 'segment-mismatch' }]),
      /source_revision does not match revision_seq/
    );
  });
});

test('shared message segment resolves only the selected Conversation alias beyond the old three-row limit', async () => {
  await withRuntime('attachment-catalog-conversation-alias', async (database, fixtureContent) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    const steps = [];
    for (let index = 0; index < 300; index += 1) {
      steps.push(
        repository('Conversation').insert({
          id: `conversation-alias-${index}`, title: `alias-${index}`, status: 'active',
          created_at: NOW, updated_at: NOW
        }),
        repository('Message').insert({
          id: `message-alias-${index}`, created_at: NOW, updated_at: NOW, deleted_at: null
        }),
        repository('MessageRevision').insert({
          id: `revision-alias-${index}`, message_id: `message-alias-${index}`, revision_seq: 0n,
          role: 'user', content_object_id: fixtureContent.id, created_at: NOW
        }),
        repository('MessagePartOfConversation').insert({
          id: `membership-alias-${index}`, conversation_id: `conversation-alias-${index}`,
          message_id: `message-alias-${index}`, message_seq: 1n, created_at: NOW
        }),
        repository('ContextSegmentSource').insert({
          id: `source-alias-${String(index).padStart(3, '0')}`, segment_id: 'segment-shared-alias',
          source_kind: 'message_revision', source_id: `revision-alias-${index}`,
          source_revision: 0n, created_at: NOW
        })
      );
      if (index === 299) {
        steps.push(
          repository('Attachment').insert({
            id: 'attachment-alias-299', sha256: 'f'.repeat(64), byte_length: 300n,
            mime_type: 'image/png', name: 'alias-299.png', storage_mode: 'managed',
            content_object_id: null, created_at: NOW
          }),
          repository('AttachmentLink').insert({
            id: 'attachment-link-alias-299', message_revision_id: 'revision-alias-299',
            attachment_id: 'attachment-alias-299', position: 0n, created_at: NOW
          })
        );
      }
    }
    steps.unshift(repository('ContextSegment').insert({
      id: 'segment-shared-alias', content_object_id: fixtureContent.id,
      segment_kind: 'message', created_at: NOW
    }));
    await database.transaction(steps);

    const projection = new kernel.AttachmentCatalogProjection(database);
    assert.deepEqual(
      await projection.project('conversation-alias-299', [{ segmentId: 'segment-shared-alias' }]),
      [{
        attachmentId: 'attachment-alias-299',
        name: 'alias-299.png',
        mimeType: 'image/png',
        sizeBytes: 300
      }]
    );
  });
});

test('Conversation attachment handles stay stable when visible order changes and new media appears first', async () => {
  await withRuntime('conversation-attachment-handles', async (database) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    const attachments = [
      { attachmentId: 'attachment-old-one', name: 'old-one.png', mimeType: 'image/png', sizeBytes: 11 },
      { attachmentId: 'attachment-old-two', name: 'old-two.png', mimeType: 'image/png', sizeBytes: 22 },
      { attachmentId: 'attachment-new', name: 'new.png', mimeType: 'image/png', sizeBytes: 33 }
    ];
    await database.transaction([
      repository('Conversation').insert({
        id: 'conversation-handles', title: 'handles', status: 'active', created_at: NOW, updated_at: NOW
      }),
      ...attachments.map((entry, index) => repository('Attachment').insert({
        id: entry.attachmentId,
        sha256: String(index + 1).repeat(64),
        byte_length: BigInt(entry.sizeBytes),
        mime_type: entry.mimeType,
        name: entry.name,
        storage_mode: 'managed',
        content_object_id: null,
        created_at: NOW
      }))
    ]);

    const registry = new kernel.ConversationAttachmentHandleRegistry(database, { now: () => NOW });
    const first = await registry.ensure('conversation-handles', attachments.slice(0, 2));
    assert.deepEqual(first.entries.map(({ target, ref }) => [target, ref]), [
      ['attachment-old-one', 'F1'],
      ['attachment-old-two', 'F2']
    ]);

    const reordered = await registry.ensure('conversation-handles', [attachments[2], attachments[1], attachments[0]]);
    assert.deepEqual(reordered.entries.map(({ target, ref }) => [target, ref]), [
      ['attachment-new', 'F3'],
      ['attachment-old-two', 'F2'],
      ['attachment-old-one', 'F1']
    ]);
    const rebuilt = kernel.buildModelHandleCatalog([
      { inlineData: { attachmentId: 'attachment-new', ...attachments[2] } },
      attachments
    ], reordered.entries);
    assert.equal(kernel.modelHandleRef(rebuilt, 'attachment', 'attachment-old-one'), 'F1');
    assert.equal(kernel.modelHandleRef(rebuilt, 'attachment', 'attachment-old-two'), 'F2');
    assert.equal(kernel.modelHandleRef(rebuilt, 'attachment', 'attachment-new'), 'F3');

    const replayed = await new kernel.ConversationAttachmentHandleRegistry(database).ensure(
      'conversation-handles',
      attachments
    );
    assert.deepEqual(replayed.entries.map(({ target, ref }) => [target, ref]), [
      ['attachment-old-one', 'F1'],
      ['attachment-old-two', 'F2'],
      ['attachment-new', 'F3']
    ]);
    const links = await database.snapshotAll(repository('ConversationAttachmentHandleLink').list({
      where: { conversation_id: 'conversation-handles' }, orderBy: { column: 'id', direction: 'asc' }, limit: 100
    }));
    assert.equal(links.snapshot.length, 3);
  });
});

test('fork snapshot preserves source attachment handle sequence for the copied prefix', async () => {
  await withRuntime('conversation-attachment-handle-fork', async (database, fixtureContent) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    await database.transaction([
      repository('Conversation').insert({
        id: 'conversation-handle-source', title: 'source', status: 'active', created_at: NOW, updated_at: NOW
      }),
      repository('Message').insert({
        id: 'message-handle-source', created_at: NOW, updated_at: NOW, deleted_at: null
      }),
      repository('MessageRevision').insert({
        id: 'revision-handle-source', message_id: 'message-handle-source', revision_seq: 0n,
        role: 'user', content_object_id: fixtureContent.id, created_at: NOW
      }),
      repository('MessageCurrentRevisionLink').insert({
        id: 'current-handle-source', message_id: 'message-handle-source',
        revision_id: 'revision-handle-source', updated_at: NOW
      }),
      repository('MessagePartOfConversation').insert({
        id: 'membership-handle-source', conversation_id: 'conversation-handle-source',
        message_id: 'message-handle-source', message_seq: 1n, created_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'segment-handle-source', content_object_id: fixtureContent.id,
        segment_kind: 'message', created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'segment-source-handle-source', segment_id: 'segment-handle-source',
        source_kind: 'message_revision', source_id: 'revision-handle-source',
        source_revision: 0n, created_at: NOW
      }),
      repository('Attachment').insert({
        id: 'attachment-handle-source', sha256: '9'.repeat(64), byte_length: 9n,
        mime_type: 'image/png', name: 'fork.png', storage_mode: 'managed',
        content_object_id: null, created_at: NOW
      }),
      repository('AttachmentLink').insert({
        id: 'attachment-link-handle-source', message_revision_id: 'revision-handle-source',
        attachment_id: 'attachment-handle-source', position: 0n, created_at: NOW
      }),
      repository('ConversationAttachmentHandleLink').insert({
        id: kernel.conversationAttachmentHandleLinkId(
          'conversation-handle-source',
          'attachment-handle-source'
        ),
        conversation_id: 'conversation-handle-source', attachment_id: 'attachment-handle-source',
        handle_seq: 7n, created_at: NOW
      })
    ]);

    const plan = await prepareConversationForkSnapshot(database, {
      sourceConversationId: 'conversation-handle-source',
      targetConversationId: 'conversation-handle-target',
      boundaryMessageSeq: 1n,
      targetAgentId: 'agent-target',
      now: NOW
    });
    const handleInsert = plan.inserts.find((step) =>
      step.kind === 'insert' && step.domain === 'ConversationAttachmentHandleLink'
    );
    assert.ok(handleInsert);
    assert.equal(handleInsert.row.conversation_id, 'conversation-handle-target');
    assert.equal(handleInsert.row.attachment_id, 'attachment-handle-source');
    assert.equal(handleInsert.row.handle_seq, 7n);

    await database.transaction([
      repository('Conversation').insert({
        id: 'conversation-handle-target', title: 'target', status: 'active', created_at: NOW, updated_at: NOW
      }),
      ...plan.assertions,
      ...plan.inserts
    ]);
    const targetLinks = await database.snapshotAll(repository('ConversationAttachmentHandleLink').list({
      where: { conversation_id: 'conversation-handle-target' },
      orderBy: { column: 'id', direction: 'asc' },
      limit: 10
    }));
    assert.equal(targetLinks.snapshot.length, 1);
    assert.equal(targetLinks.snapshot[0].handle_seq, 7n);
  });
});

test('shared tool-pair segment ignores deleted-fork aliases and selects the target Conversation pair', async () => {
  await withRuntime('attachment-catalog-tool-alias', async (database, fixtureContent) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    const steps = [repository('ContextSegment').insert({
      id: 'segment-shared-tool-pair', content_object_id: fixtureContent.id,
      segment_kind: 'tool_pair', created_at: NOW
    })];
    for (let index = 0; index < 5; index += 1) {
      steps.push(
        repository('Conversation').insert({
          id: `conversation-tool-${index}`, title: `tool-${index}`, status: 'active',
          created_at: NOW, updated_at: NOW
        }),
        repository('Turn').insert({
          id: `turn-tool-${index}`, conversation_id: `conversation-tool-${index}`, status: 'terminated',
          created_at: NOW, updated_at: NOW, terminal_at: NOW
        }),
        repository('Message').insert({
          id: `message-tool-result-${index}`, created_at: NOW, updated_at: NOW, deleted_at: null
        }),
        repository('MessageRevision').insert({
          id: `revision-tool-result-${index}`, message_id: `message-tool-result-${index}`,
          revision_seq: 1n, role: 'tool', content_object_id: fixtureContent.id, created_at: NOW
        }),
        repository('MessagePartOfConversation').insert({
          id: `membership-tool-result-${index}`, conversation_id: `conversation-tool-${index}`,
          message_id: `message-tool-result-${index}`, message_seq: 1n, created_at: NOW
        }),
        repository('ToolCall').insert({
          id: `tool-call-alias-${index}`, turn_id: `turn-tool-${index}`, call_seq: 1n,
          tool_name: 'read', status: 'terminal', arguments_object_id: fixtureContent.id,
          created_at: NOW, updated_at: NOW
        }),
        repository('ToolModelResult').insert({
          id: `tool-result-alias-${index}`, tool_call_id: `tool-call-alias-${index}`,
          message_revision_id: `revision-tool-result-${index}`, created_at: NOW
        }),
        repository('ContextSegmentSource').insert({
          id: `source-tool-call-${index}`, segment_id: 'segment-shared-tool-pair',
          source_kind: 'tool_call', source_id: `tool-call-alias-${index}`,
          source_revision: 1n, created_at: NOW
        }),
        repository('ContextSegmentSource').insert({
          id: `source-tool-result-${index}`, segment_id: 'segment-shared-tool-pair',
          source_kind: 'tool_model_result', source_id: `tool-result-alias-${index}`,
          source_revision: 1n, created_at: NOW
        })
      );
    }
    steps.push(
      repository('ContextSegmentSource').insert({
        id: 'source-tool-call-deleted-fork', segment_id: 'segment-shared-tool-pair',
        source_kind: 'tool_call', source_id: 'tool-call-deleted-fork',
        source_revision: 1n, created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'source-tool-result-deleted-fork', segment_id: 'segment-shared-tool-pair',
        source_kind: 'tool_model_result', source_id: 'tool-result-deleted-fork',
        source_revision: 1n, created_at: NOW
      }),
      repository('Attachment').insert({
        id: 'attachment-tool-target', sha256: 'e'.repeat(64), byte_length: 42n,
        mime_type: 'image/png', name: 'tool-target.png', storage_mode: 'managed',
        content_object_id: null, created_at: NOW
      }),
      repository('AttachmentLink').insert({
        id: 'attachment-link-tool-target', message_revision_id: 'revision-tool-result-4',
        attachment_id: 'attachment-tool-target', position: 0n, created_at: NOW
      })
    );
    await database.transaction(steps);

    const projection = new kernel.AttachmentCatalogProjection(database);
    assert.deepEqual(
      await projection.project('conversation-tool-4', [{ segmentId: 'segment-shared-tool-pair' }]),
      [{
        attachmentId: 'attachment-tool-target',
        name: 'tool-target.png',
        mimeType: 'image/png',
        sizeBytes: 42
      }]
    );
  });
});

test('native tool attachments become visible only at the chronological result occurrence', async () => {
  await withRuntime('native-result-catalog', async (database, fixtureContent) => {
    const insert = (domain, row) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(row);
    await database.transaction([
      insert('Conversation', {
        id: 'native-catalog-conversation', title: 'native catalog', status: 'active',
        created_at: NOW, updated_at: NOW
      }),
      insert('Turn', {
        id: 'native-catalog-turn', conversation_id: 'native-catalog-conversation', status: 'terminated',
        created_at: NOW, updated_at: NOW, terminal_at: NOW
      }),
      insert('Message', {
        id: 'native-catalog-result-message', created_at: NOW, updated_at: NOW, deleted_at: null
      }),
      insert('MessageRevision', {
        id: 'native-catalog-result-revision', message_id: 'native-catalog-result-message',
        revision_seq: 1n, role: 'tool', content_object_id: fixtureContent.id, created_at: NOW
      }),
      insert('MessagePartOfConversation', {
        id: 'native-catalog-membership', conversation_id: 'native-catalog-conversation',
        message_id: 'native-catalog-result-message', message_seq: 1n, created_at: NOW
      }),
      insert('ToolCall', {
        id: 'native-catalog-call', turn_id: 'native-catalog-turn', call_seq: 1n,
        tool_name: 'read', status: 'terminal', arguments_object_id: fixtureContent.id,
        created_at: NOW, updated_at: NOW
      }),
      insert('ToolModelResult', {
        id: 'native-catalog-result', tool_call_id: 'native-catalog-call',
        message_revision_id: 'native-catalog-result-revision', created_at: NOW
      }),
      ...['call', 'result', 'invalid-result'].flatMap((name) => [
        insert('ContextSegment', {
          id: `native-catalog-segment-${name}`, content_object_id: fixtureContent.id,
          segment_kind: 'tool_pair', created_at: NOW
        }),
        insert('ContextSegmentSource', {
          id: `native-catalog-source-${name}`, segment_id: `native-catalog-segment-${name}`,
          source_kind: name === 'call' ? 'tool_call' : 'tool_model_result',
          source_id: name === 'call' ? 'native-catalog-call' : 'native-catalog-result',
          source_revision: name === 'invalid-result' ? 2n : 1n, created_at: NOW
        })
      ]),
      insert('Attachment', {
        id: 'native-catalog-image', sha256: 'f'.repeat(64), byte_length: 42n,
        mime_type: 'image/png', name: 'delayed.png', storage_mode: 'managed',
        content_object_id: null, created_at: NOW
      }),
      insert('AttachmentLink', {
        id: 'native-catalog-image-link', message_revision_id: 'native-catalog-result-revision',
        attachment_id: 'native-catalog-image', position: 0n, created_at: NOW
      })
    ]);
    const projection = new kernel.AttachmentCatalogProjection(database);
    const call = { segmentId: 'native-catalog-segment-call' };
    const result = { segmentId: 'native-catalog-segment-result' };
    const expected = [{
      attachmentId: 'native-catalog-image', name: 'delayed.png', mimeType: 'image/png', sizeBytes: 42
    }];
    assert.deepEqual(await projection.project('native-catalog-conversation', [call]), []);
    assert.deepEqual(await projection.project('native-catalog-conversation', [call, result]), expected);
    assert.deepEqual(await projection.project('native-catalog-conversation', [result]), expected);
    await assert.rejects(projection.project('native-catalog-conversation', [
      { segmentId: 'native-catalog-segment-invalid-result' }
    ]));
  });
});

test('compression lineage cycles fail closed without damaging the original expandable source', async () => {
  await withRuntime('attachment-catalog-cycle', async (database, fixtureContent) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    await database.transaction([
      repository('Conversation').insert({
        id: 'conversation-cycle', title: 'cycle', status: 'active', created_at: NOW, updated_at: NOW
      }),
      repository('CompressionBlock').insert({
        id: 'cycle-block-a', conversation_id: 'conversation-cycle', status: 'active',
        authority_snapshot_id: 'authority-cycle', title_object_id: fixtureContent.id,
        summary_object_id: fixtureContent.id, created_at: NOW, updated_at: NOW
      }),
      repository('CompressionBlock').insert({
        id: 'cycle-block-b', conversation_id: 'conversation-cycle', status: 'active',
        authority_snapshot_id: 'authority-cycle', title_object_id: fixtureContent.id,
        summary_object_id: fixtureContent.id, created_at: NOW, updated_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'cycle-segment-a', content_object_id: fixtureContent.id, segment_kind: 'compression', created_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'cycle-segment-b', content_object_id: fixtureContent.id, segment_kind: 'compression', created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'cycle-source-a', segment_id: 'cycle-segment-a', source_kind: 'compression_block',
        source_id: 'cycle-block-a', source_revision: 0n, created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'cycle-source-b', segment_id: 'cycle-segment-b', source_kind: 'compression_block',
        source_id: 'cycle-block-b', source_revision: 0n, created_at: NOW
      }),
      repository('CompressionBlockSource').insert({
        id: 'cycle-block-source-a', compression_block_id: 'cycle-block-a',
        segment_id: 'cycle-segment-b', position: 0n, created_at: NOW
      }),
      repository('CompressionBlockSource').insert({
        id: 'cycle-block-source-b', compression_block_id: 'cycle-block-b',
        segment_id: 'cycle-segment-a', position: 0n, created_at: NOW
      })
    ]);

    const projection = new kernel.AttachmentCatalogProjection(database);
    await assert.rejects(
      projection.project('conversation-cycle', [{ segmentId: 'cycle-segment-a' }]),
      /Compression lineage cycle detected/
    );
    const sources = await database.snapshotAll(repository('CompressionBlockSource').list({
      orderBy: { column: 'id', direction: 'asc' }, limit: 10
    }));
    assert.deepEqual(
      sources.snapshot.map((row) => row.id).sort(),
      ['cycle-block-source-a', 'cycle-block-source-b']
    );
  });
});
