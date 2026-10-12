import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const clientFeed = require(path.join(compiled, 'shared/reliableKernelClientFeed.js'));
const INITIAL_WINDOW_SIZE = 200;
const BASE_TIME = Date.parse('2026-10-13T00:00:00Z');
export async function createRolloverFixture(prefix, options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-${prefix}-`));
  let database;
  let feed;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    database = await kernel.RuntimeDatabase.open(candidate.authority);
    const store = kernel.ContentAddressedStore.forDatabase(candidate.authority, database);
    const content = await store.ingest(database, JSON.stringify({ role: 'model', parts: [{ text: prefix }] }), 'application/vnd.limcode.message+json');
    const conversationId = `${prefix}-conversation`;
    const turnId = `${prefix}-turn`;
    const at = timestamp(0);
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId,
        title: prefix,
        status: 'active',
        created_at: at,
        updated_at: at
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: turnId,
        conversation_id: conversationId,
        status: 'terminated',
        created_at: at,
        updated_at: at,
        terminal_at: at
      })
    ]);

    for (let first = 1; first <= INITIAL_WINDOW_SIZE; first += 40) {
      const steps = [];
      for (let sequence = first; sequence < first + 40; sequence += 1) {
        steps.push(...terminalBundleSteps({ prefix, conversationId, turnId, contentObjectId: content.id, sequence }));
      }
      await database.transaction(steps);
    }

    if (options.runningProcessOnFirst) {
      const first = ids(prefix, 1);
      await database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Process').insert({
          id: `${prefix}-process-001`,
          status: 'running',
          wrapper_nonce: `${prefix}-wrapper`,
          wrapper_pid: 101n,
          child_pid: 102n,
          process_group_id: 102n,
          start_fingerprint: `${prefix}-start`,
          command_digest: `${prefix}-command`,
          spool_locator: `${prefix}-spool`,
          retained_bytes: 0n,
          retained_chunks: 0n,
          dropped_bytes: 0n,
          truncated: 0n,
          started_at: timestamp(1),
          updated_at: timestamp(1),
          completed_at: null
        }),
        kernel.DOMAIN_REPOSITORIES.domain('ProcessOriginLink').insert({
          id: `${prefix}-process-origin-001`,
          process_id: `${prefix}-process-001`,
          tool_call_id: first.tool,
          created_at: timestamp(1)
        })
      ]);
    }

    const frames = [];
    feed = new kernel.BoundedClientFeed(database);
    const connection = await feed.connect({
      activeConversationId: conversationId,
      send(frame) { frames.push(frame); }
    });
    let consumed = 0;
    let state = clientFeed.createEmptyReliableKernelClientState();
    const consume = () => {
      const frame = frames[consumed++];
      assert.ok(frame, 'the database commit must produce one feed frame');
      const applied = clientFeed.applyReliableKernelDataMessage(state, frame);
      assert.equal(applied.snapshotRequired, false, applied.reason);
      assert.ok(applied.ack);
      state = applied.state;
      feed.acknowledge(applied.ack);
      return frame;
    };
    assert.equal(consume().type, 'reliable-kernel.snapshot');

    return {
      prefix,
      parent,
      database,
      feed,
      frames,
      conversationId,
      turnId,
      history: new kernel.ClientHistoryReader(database),
      get state() { return state; },
      async append(sequence) {
        const before = frames.length;
        await database.transaction(terminalBundleSteps({
          prefix, conversationId, turnId, contentObjectId: content.id, sequence
        }));
        assert.equal(frames.length, before + 1, 'one terminal bundle commit must produce one atomic feed frame');
        return consume();
      },
      async finishProcess() {
        const before = frames.length;
        await database.transaction([
          kernel.DOMAIN_REPOSITORIES.domain('Process').update(`${prefix}-process-001`, {
            status: 'exited',
            updated_at: timestamp(301),
            completed_at: timestamp(301)
          })
        ]);
        assert.equal(frames.length, before + 1);
        return consume();
      },
      async close() {
        feed.disconnect(connection.sessionId);
        feed.close();
        await database.close();
        await fs.rm(parent, { recursive: true, force: true });
      }
    };
  } catch (error) {
    feed?.close();
    await database?.close();
    await fs.rm(parent, { recursive: true, force: true });
    throw error;
  }
}

function terminalBundleSteps({ prefix, conversationId, turnId, contentObjectId, sequence }) {
  const recordIds = ids(prefix, sequence);
  const at = timestamp(sequence);
  return [
    kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
      id: recordIds.message, created_at: at, updated_at: at, deleted_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
      id: recordIds.revision,
      message_id: recordIds.message,
      revision_seq: 1n,
      role: 'model',
      content_object_id: contentObjectId,
      created_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
      id: recordIds.current,
      message_id: recordIds.message,
      revision_id: recordIds.revision,
      updated_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insert({
      id: recordIds.membership,
      conversation_id: conversationId,
      message_id: recordIds.message,
      message_seq: BigInt(sequence),
      created_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
      id: recordIds.messageTurn,
      turn_id: turnId,
      message_id: recordIds.message,
      role: 'model',
      created_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').insert({
      id: recordIds.request,
      turn_id: turnId,
      request_seq: BigInt(sequence),
      status: 'prepared',
      terminal_state: null,
      provider_id: 'fixture-provider',
      model_id: 'fixture-model',
      context_window_tokens: 128000n,
      compression_threshold_tokens: 100000n,
      estimated_context_tokens: 1n,
      authority_snapshot_id: `${prefix}-authority`,
      settings_snapshot_object_id: null,
      recipe_object_id: contentObjectId,
      usage_json: null,
      stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null },
      created_at: at,
      updated_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('Operation').insert({
      id: recordIds.operation,
      owner_kind: 'model_request',
      owner_id: recordIds.request,
      operation_seq: 1n,
      tool_call_id: null,
      status: 'pending',
      created_at: at,
      updated_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('Attempt').insert({
      id: recordIds.attempt,
      operation_id: recordIds.operation,
      attempt_seq: 1n,
      status: 'pending',
      created_at: at,
      updated_at: at,
      completed_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ModelContextProjection').insert({
      id: recordIds.projection,
      owner_kind: 'model_request',
      owner_id: recordIds.request,
      root_id: `${prefix}-context-root-${String(sequence).padStart(3, '0')}`,
      purpose: 'provider-request',
      created_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').insert({
      id: recordIds.requestMessage,
      model_request_id: recordIds.request,
      message_id: recordIds.message,
      created_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ToolCall').insert({
      id: recordIds.tool,
      turn_id: turnId,
      call_seq: BigInt(sequence),
      tool_name: 'read_file',
      status: 'pending',
      arguments_object_id: contentObjectId,
      created_at: at,
      updated_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').insert({
      id: recordIds.toolSource,
      tool_call_id: recordIds.tool,
      model_request_id: recordIds.request,
      message_id: recordIds.message,
      provider_call_id: `${prefix}-provider-call-${sequence}`,
      provider_ordinal: 0n,
      batch_id: `${prefix}-batch-${sequence}`,
      batch_ordinal: 0n,
      thought_signature: null,
      created_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ToolExecution').insert({
      id: recordIds.execution,
      tool_call_id: recordIds.tool,
      status: 'pending',
      wait_deadline_at: null,
      started_at: at,
      updated_at: at,
      completed_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('Attempt').update(recordIds.attempt, {
      status: 'failed',
      updated_at: at,
      completed_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('Operation').update(recordIds.operation, {
      status: 'failed',
      updated_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').update(recordIds.request, {
      status: 'terminal',
      terminal_state: 'failed',
      updated_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ToolCall').update(recordIds.tool, {
      status: 'terminal',
      updated_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ToolExecution').update(recordIds.execution, {
      status: 'completed',
      updated_at: at,
      completed_at: at
    })
  ];
}

export function ids(prefix, sequence) {
  const suffix = String(sequence).padStart(3, '0');
  return {
    message: `${prefix}-message-${suffix}`,
    revision: `${prefix}-revision-${suffix}`,
    current: `${prefix}-current-${suffix}`,
    membership: `${prefix}-membership-${suffix}`,
    messageTurn: `${prefix}-message-turn-${suffix}`,
    request: `${prefix}-request-${suffix}`,
    projection: `${prefix}-projection-${suffix}`,
    operation: `${prefix}-operation-${suffix}`,
    attempt: `${prefix}-attempt-${suffix}`,
    requestMessage: `${prefix}-request-message-${suffix}`,
    tool: `${prefix}-tool-${suffix}`,
    toolSource: `${prefix}-tool-source-${suffix}`,
    execution: `${prefix}-execution-${suffix}`
  };
}

function timestamp(sequence) {
  return new Date(BASE_TIME + sequence * 1000).toISOString();
}

export function windowEvictions(frame) {
  return frame.changes.filter((change) =>
    change.operation === 'remove' && change.removalCause === 'window-eviction'
  );
}
