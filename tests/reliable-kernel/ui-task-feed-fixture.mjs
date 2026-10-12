import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const clientFeed = require(path.join(compiled, 'shared/reliableKernelClientFeed.js'));
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);

const conversationId = 'task-feed-conversation';
const foreignConversationId = 'task-feed-foreign-conversation';
const turnId = 'task-feed-turn';
const foreignTurnId = 'task-feed-foreign-turn';
const messageId = 'task-feed-native-message';
const at = '2026-09-24T16:00:00.000Z';
const rewrite = (status) => ({ kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'Write tests', status }] });
const update = (status) => ({ kind: 'task_list.operation', mode: 'update', items: [{ title: 'Write tests', status }] });
const planResult = (status) => ({ output: {
  kind: 'submit_plan.result', proposalId: 'task-feed-proposal', status, executionTarget: 'current_conversation'
} });

/** The Runtime a Conversation with a task list, its settled rewrite and still-running task tools. */
export async function createTaskRuntime() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-task-live-feed-'));
  let database;
  const close = async () => {
    if (database) await database.close();
    database = undefined;
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    const root = await kernel.resetCandidateRuntimeRoot(directory);
    database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'task-live-feed' });
    const cas = kernel.ContentAddressedStore.forDatabase(root.authority, database);
    const json = async (value, type = 'application/json') => (await cas.ingest(database, JSON.stringify(value), type)).id;
    const modelBody = await json({ role: 'model', parts: [{ text: '任务' }] }, 'application/vnd.limcode.message+json');
    const userBody = await json({ role: 'user', parts: [{ text: '继续' }] }, 'application/vnd.limcode.message+json');
    const recipe = await json({ recipe: 'task-live-feed' });
    const message = (id, seq, role, owner = conversationId, turn = turnId) => [
      row('Message', { id, created_at: at, updated_at: at, deleted_at: null }),
      row('MessageRevision', { id: `${id}-revision`, message_id: id, revision_seq: 1n, role,
        content_object_id: role === 'model' ? modelBody : userBody, created_at: at }),
      row('MessageCurrentRevisionLink', { id: `${id}-current`, message_id: id, revision_id: `${id}-revision`, updated_at: at }),
      row('MessagePartOfConversation', { id: `${id}-member`, conversation_id: owner, message_id: id, message_seq: BigInt(seq), created_at: at }),
      row('MessageTurnLink', { id: `${id}-turn`, turn_id: turn, message_id: id, role, created_at: at })
    ];
    const request = (id, turn, seq) => [row('ModelRequest', { id, turn_id: turn, request_seq: BigInt(seq), status: 'prepared',
      terminal_state: null, provider_id: 'fixture-provider', model_id: 'fixture-model', context_window_tokens: 128000n,
      compression_threshold_tokens: 100000n, estimated_context_tokens: 1n, authority_snapshot_id: `${id}-authority`,
      settings_snapshot_object_id: null, recipe_object_id: recipe, usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }, created_at: at, updated_at: at }),
      row('Operation', { id: `${id}-operation`, owner_kind: 'model_request', owner_id: id, operation_seq: 1n, tool_call_id: null,
        status: 'pending', created_at: at, updated_at: at }),
      row('Attempt', { id: `${id}-attempt`, operation_id: `${id}-operation`, attempt_seq: 1n, status: 'pending',
        created_at: at, updated_at: at, completed_at: null }),
      row('ModelContextProjection', { id: `${id}-projection`, owner_kind: 'model_request', owner_id: id,
        root_id: `${id}-context-root`, purpose: 'provider-request', created_at: at })];
    const call = async (id, name, args, source, ordinal, turn = turnId, seq = ordinal + 1) => [
      row('ToolCall', { id, turn_id: turn, call_seq: BigInt(seq), tool_name: name, status: 'terminal',
        arguments_object_id: await json(args), created_at: at, updated_at: at }),
      row('ToolCallSourceLink', { id: `${id}-source`, tool_call_id: id, model_request_id: source.request, message_id: source.message,
        provider_call_id: `${id}-provider`, provider_ordinal: BigInt(ordinal), batch_id: `${id}-batch`, batch_ordinal: 0n,
        thought_signature: null, created_at: at })
    ];
    const oldSource = { request: 'task-feed-old-request', message: 'task-feed-old-message' };
    const nativeSource = { request: 'task-feed-native-request', message: messageId };
    const foreignSource = { request: 'task-feed-foreign-request', message: 'task-feed-foreign-message' };
    await database.transaction([
      row('Conversation', { id: conversationId, title: 'Tasks', status: 'active', created_at: at, updated_at: at }),
      row('Conversation', { id: foreignConversationId, title: 'Other', status: 'active', created_at: at, updated_at: at }),
      row('Turn', { id: turnId, conversation_id: conversationId, status: 'terminated', created_at: at, updated_at: at, terminal_at: at }),
      row('Turn', { id: foreignTurnId, conversation_id: foreignConversationId, status: 'terminated', created_at: at, updated_at: at, terminal_at: at }),
      ...message('task-feed-old-message', 1, 'model'),
      ...message(messageId, 2, 'model'),
      ...message('task-feed-foreign-message', 1, 'model', foreignConversationId, foreignTurnId),
      ...request(oldSource.request, turnId, 1),
      ...request(nativeSource.request, turnId, 2),
      ...request(foreignSource.request, foreignTurnId, 1),
      row('ModelRequestMessageLink', { id: 'task-feed-old-request-link', model_request_id: oldSource.request, message_id: oldSource.message, created_at: at }),
      row('ModelRequestMessageLink', { id: 'task-feed-native-request-link', model_request_id: nativeSource.request, message_id: messageId, created_at: at }),
      row('ModelRequestMessageLink', { id: 'task-feed-foreign-request-link', model_request_id: foreignSource.request, message_id: foreignSource.message, created_at: at }),
      ...await call('task-feed-base', 'update_task_list', rewrite('pending'), oldSource, 0, turnId, 1),
      // The arguments are optimistic on purpose: only a committed result artifact may show them.
      ...await call('task-feed-update-one', 'update_task_list', update('completed'), nativeSource, 0, turnId, 2),
      ...await call('task-feed-update-two', 'update_task_list', update('completed'), nativeSource, 1, turnId, 3),
      ...await call('task-feed-plan', 'submit_plan', { plan: '完成', taskList: rewrite('completed') }, nativeSource, 2, turnId, 4),
      ...await call('task-feed-rejected-plan', 'submit_plan', { plan: '放弃', taskList: rewrite('completed') }, nativeSource, 3, turnId, 5),
      ...await call('task-feed-latest-rewrite', 'update_task_list', rewrite('completed'), nativeSource, 4, turnId, 6),
      ...await call('task-feed-foreign-plan', 'submit_plan', { plan: '别处', taskList: rewrite('completed') }, foreignSource, 0, foreignTurnId, 1)
    ]);
    const settle = async (toolCallId, { operation = 'succeeded', detail, outcome = false } = {}) => {
      const steps = [];
      if (operation) steps.push(row('Operation', { id: `${toolCallId}-operation`, owner_kind: 'tool_call', owner_id: toolCallId,
        operation_seq: 1n, tool_call_id: toolCallId, status: operation, created_at: at, updated_at: at }));
      if (detail) steps.push(row('ToolResultArtifact', { id: `${toolCallId}-artifact`, tool_call_id: toolCallId, role: 'no_effect_result',
        content_object_id: await json({ toolCallId, status: 'succeeded', detail }), created_at: at }));
      if (outcome) steps.push(row('ToolOutcome', { id: `${toolCallId}-outcome`, tool_call_id: toolCallId, status: 'succeeded',
        content_object_id: null, created_at: at }));
      await database.transaction(steps);
    };
    await settle('task-feed-base', { detail: { kind: 'task-list', operation: rewrite('pending') }, outcome: true });
    return { database, settle, close,
      appendMessages(from, count) {
        return database.transaction(Array.from({ length: count }, (_value, offset) =>
          message(`task-feed-later-${from + offset}`, 3 + from + offset, 'user')).flat());
      }
    };
  } catch (error) {
    await close();
    throw error;
  }
}
