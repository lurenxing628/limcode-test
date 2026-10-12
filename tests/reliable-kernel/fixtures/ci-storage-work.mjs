import fs from 'node:fs/promises';
import path from 'node:path';
import { kernel, repo, load, relocation, roots, NOW, temporaryRoot, initializeRoot } from './ci-storage-relocation.mjs';

const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
const { preparedContentObjectSteps } = load('backend/reliableKernel/contentObjectTransaction.js');
export const { settleRelocatedWork } = load('backend/application/reliableKernel/relocatedWorkSettlement.js');
export const { openSettlingRelocatedWork, relocatedWorkBeforeOpen } = load('backend/application/reliableKernel/relocatedWorkOpening.js');

/** One application and worker; each scenario owns separate Conversation/command identities. */
export async function createWorkFixture() {
  const base = await temporaryRoot('limcode-ci-relocated-work-');
  const dataSet = await initializeRoot(path.join(base, 'old-home'));
  await roots.selectVscodeRuntimeDataSet({ globalStoragePath: dataSet.root }, 'default');
  const calls = { models: 0, tools: 0, mcp: 0 };
  const app = await kernel.ReliableKernelApplication.open(dataSet.authority, {
    holdRuntimeConvergence: true,
    authorityCompiler: { async compile(request) { return {
      turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: 'ci-storage', modelId: 'ci-model' }) },
      authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority', turnId: request.turnId,
        conversationId: request.conversationId, executorAgentId: request.executorAgentId,
        model: { providerConfigId: 'ci-storage', provider: 'openai-compatible', modelId: 'ci-model', retryPolicy: { enabled: false, maxRetries: 0 } },
        modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
        toolPolicy: { id: 'ci-storage-tools', allowedTools: [], preset: 'yolo', toolConfigs: {}, sourceConfigs: {} },
        planReviewPolicy: { mode: 'off' }, systemPrompt: { id: 'ci-storage-prompt', text: '' },
        runtimeContext: { id: null, name: '', template: '' },
        workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
      }) }
    }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { calls.mcp++; throw new Error('收尾不执行MCP'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve(providerId) { return { providerId, async sendFullRequest() { calls.models++; throw new Error('收尾不调用模型'); } }; } },
    toolDispatcher: { definitions() { return []; }, async dispatch() { calls.tools++; throw new Error('收尾不执行工具'); } }
  });
  const f = { base, dataSet, app, calls, placement: { configurationRootPath: dataSet.root, runtimeScopeRootPath: dataSet.root },
    target: path.join(base, 'new-home'), noticeFile: path.join(dataSet.root, relocation.DATA_ROOT_MOVED_NOTICE_FILE),
    async close() { await app.close(); await fs.rm(base, { recursive: true, force: true }); }
  };
  f.rows = async (domain, where = {}) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
  f.get = async (domain, id) => (await app.database.snapshot([repo(domain).get(id)])).snapshot[0];
  f.conversation = async id => {
    await app.database.transaction([
      repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
      emptyConversationContextHandleStateStep(id, NOW),
      repo('AgentConversationLink').insert({ id: `${id}-agent`, conversation_id: id, agent_id: 'ci-agent', role: 'default', created_at: NOW, updated_at: NOW })
    ]);
  };
  f.input = (conversationId, key, content = key) => app.database.conversationOwners.run(conversationId, () => app.turns.input({
    source: { kind: 'command', key }, conversationId, leaseOwnerId: `ci:${app.database.hostBootId}`,
    hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), content, contentType: 'text/plain; charset=utf-8'
  }));
  f.release = async turnId => {
    const [lease] = await f.rows('ExecutionLease', { turn_id: turnId });
    if (lease) await app.turns.releaseExecutionLease({ id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) });
  };
  f.completed = async (conversationId, turnId) => app.database.transaction([
    repo('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
    repo('TurnTermination').insert({ id: `${turnId}-termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture completed', created_at: NOW })
  ]);
  f.finish = async turnId => {
    const [lease] = await f.rows('ExecutionLease', { turn_id: turnId });
    const fence = { id: lease.id, conversationId: lease.conversation_id, turnId, ownerId: lease.owner_id,
      hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
    await kernel.runWithExecutionLeaseFence(fence, () => app.turns.terminal({
      source: { kind: 'internal', key: `ci-finish:${turnId}` }, turnId, terminalStatus: 'completed', reason: 'fixture completed'
    }));
  };
  f.inventory = async () => app.database.relocatedWorkInventory();
  f.settle = async () => settleRelocatedWork({ application: app, inventory: await f.inventory(), targetRootPath: f.target });
  f.notice = async (relocationId, inventory, state = 'pending') => {
    const settlement = state === 'pending' ? { state } : { state, at: NOW, by: 'ci-installation' };
    const notice = { kind: 'limcode-data-root-moved', targetRootPath: f.target, relocationId, movedAt: NOW,
      installation: { id: 'ci-installation', label: 'test' },
      carriedWork: { dataSets: [{ id: 'default', dataSetId: app.database.binding.dataSetId, inventory, settlement }] } };
    await fs.writeFile(f.noticeFile, JSON.stringify(notice));
    return notice;
  };
  return f;
}

export async function createChildAnswer(f, id, parentConversationId, parentTurnId) {
  const { app } = f;
  const payload = await app.contentStore.prepare(app.database, `answer from ${id}`, 'text/plain');
  await app.database.transaction([
    ...preparedContentObjectSteps([payload], 'ci_child_answer'),
    repo('Conversation').insert({ id: `${id}-conversation`, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
    repo('ChildExecution').insert({ id: `${id}-child`, child_conversation_id: `${id}-conversation`, status: 'idle', created_at: NOW, updated_at: NOW }),
    repo('ChildExecutionParentLink').insert({ id: `${id}-parent`, child_execution_id: `${id}-child`, source_tool_call_id: `${id}-spawn`, parent_child_execution_id: null, parent_turn_id: parentTurnId, created_at: NOW }),
    repo('Turn').insert({ id: `${id}-turn`, conversation_id: `${id}-conversation`, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
    repo('TurnTermination').insert({ id: `${id}-termination`, turn_id: `${id}-turn`, terminal_status: 'completed', reason: 'fixture', created_at: NOW }),
    repo('ChildExecutionTurnLink').insert({ id: `${id}-lineage`, child_execution_id: `${id}-child`, turn_id: `${id}-turn`, turn_seq: 1n, created_at: NOW }),
    repo('AnswerBridge').insert({ id: `${id}-bridge`, child_execution_id: `${id}-child`, current_submission_id: `${id}-submission`, status: 'submitted', created_at: NOW, updated_at: NOW }),
    repo('AnswerSubmission').insert({ id: `${id}-submission`, answer_bridge_id: `${id}-bridge`, submission_seq: 1n, turn_id: `${id}-turn`, interrupted: 0n, created_at: NOW }),
    repo('AnswerPayload').insert({ id: `${id}-answer-payload`, submission_id: `${id}-submission`, title: null, content_object_id: payload.metadata.id, byte_length: payload.metadata.byte_length, created_at: NOW }),
    repo('RuntimeInboxItem').insert({ id: `${id}-inbox`, dedupe_key: `ci:${id}`, source_kind: 'answer_submission', source_id: `${id}-submission`, state: 'available', created_at: NOW, updated_at: NOW }),
    repo('RuntimeInboxPayloadLink').insert({ id: `${id}-payload`, inbox_item_id: `${id}-inbox`, content_object_id: payload.metadata.id, created_at: NOW })
  ]);
  const delivery = await app.runtime.deliveries.createAutomatic({ inboxItemId: `${id}-inbox`, targetConversationId: parentConversationId, sourceTurnId: parentTurnId });
  await app.database.transaction([repo('RuntimeDeliveryWake').insert({ id: `${id}-wake`, delivery_id: delivery.delivery.id,
    state: 'pending', claim_owner_host_boot_id: null, claim_generation: 0n, claim_expires_at: null,
    attempt_count: 0n, failure_count: 0n, next_attempt_at: NOW, last_error: null, acknowledged_at: null, created_at: NOW, updated_at: NOW })]);
  return { deliveryId: delivery.delivery.id };
}

export async function createProcessDispatch(f, id, conversationId, sourceTurnId) {
  const { app } = f;
  const request = await app.contentStore.prepare(app.database, JSON.stringify({ kind: 'process_exit', processId: id }), 'application/json');
  await app.database.transaction([
    ...preparedContentObjectSteps([request], 'ci_process_exit'),
    repo('Process').insert({ id, status: 'exited', wrapper_nonce: `${id}-nonce`, wrapper_pid: 0n, child_pid: null, process_group_id: null,
      start_fingerprint: `${id}-fingerprint`, command_digest: `${id}-command`, spool_locator: id, retained_bytes: 0n, retained_chunks: 0n,
      dropped_bytes: 0n, truncated: 0n, started_at: NOW, updated_at: NOW, completed_at: NOW }),
    repo('ProcessCompletionSourceLink').insert({ id: `${id}-source`, process_id: id, conversation_id: conversationId, source_turn_id: sourceTurnId, source_tool_call_id: `${id}-tool`, created_at: NOW }),
    repo('ProcessReceipt').insert({ id: `${id}-receipt`, process_id: id, outcome: 'succeeded', exit_code: 0n, exit_signal: null,
      wrapper_nonce: `${id}-nonce`, start_fingerprint: `${id}-fingerprint`, received_at: NOW }),
    repo('Operation').insert({ id: `${id}-operation`, owner_kind: 'process', owner_id: id, operation_seq: 1n, tool_call_id: null, status: 'succeeded', created_at: NOW, updated_at: NOW }),
    repo('Attempt').insert({ id: `${id}-attempt`, operation_id: `${id}-operation`, attempt_seq: 1n, status: 'succeeded', created_at: NOW, updated_at: NOW, completed_at: NOW }),
    repo('EffectIntent').insert({ id: `${id}-intent`, attempt_id: `${id}-attempt`, effect_kind: 'process_exit', dispatch_state: 'receipt_written', request_object_id: request.metadata.id, created_at: NOW, updated_at: NOW }),
    repo('ProcessCompletionDispatch').insert({ id: `${id}-dispatch`, process_receipt_id: `${id}-receipt`, state: 'pending', claim_owner_host_boot_id: null,
      claim_generation: 0n, claim_expires_at: null, attempt_count: 0n, failure_count: 0n, next_attempt_at: null, last_error: null, completed_at: null, created_at: NOW, updated_at: NOW })
  ]);
  return `${id}-dispatch`;
}

export async function createPendingFollowup(f, id, requester, target, sourceTurnId) {
  const { app } = f;
  const payload = await app.contentStore.ingest(app.database, '请复核这项工作', 'text/vnd.limcode.collaboration-message');
  const deliveryId = `${id}-delivery`;
  await app.database.transaction([
    repo('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode: 'followup', created_at: NOW }, { column: 'message_seq', scope: {} }),
    repo('CollaborationMessageSourceLink').insert({ id: `${id}-source`, message_id: id, conversation_id: requester, source_kind: 'tool', source_key: id, turn_id: sourceTurnId, tool_call_id: null, created_at: NOW }),
    repo('RuntimeInboxItem').insert({ id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id, state: 'routed', created_at: NOW, updated_at: NOW }),
    repo('CollaborationMessageTargetLink').insert({ id: `${id}-target`, message_id: id, conversation_id: target, inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: NOW }),
    repo('CollaborationMessagePayloadLink').insert({ id: `${id}-payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
    repo('RuntimeInboxPayloadLink').insert({ id: `${id}-inbox-payload`, inbox_item_id: `${id}-inbox`, content_object_id: payload.id, created_at: NOW }),
    repo('RuntimeDelivery').insert({ id: deliveryId, inbox_item_id: `${id}-inbox`, target_conversation_id: target, target_turn_id: null,
      phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null, created_at: NOW, updated_at: NOW }),
    repo('CollaborationBudget').insert({ id: `${id}-budget`, origin_kind: 'turn', origin_key: `${id}-origin`, authority_turn_id: sourceTurnId, created_at: NOW }),
    repo('CollaborationRequest').insert({ id: `${id}-request`, message_id: id, budget_id: `${id}-budget`, automatic: 1n, state: 'pending', created_at: NOW, updated_at: NOW }),
    repo('RuntimeDeliveryWake').insert({ id: `${id}-wake`, delivery_id: deliveryId, state: 'pending', claim_owner_host_boot_id: null,
      claim_generation: 0n, claim_expires_at: null, attempt_count: 0n, failure_count: 0n, next_attempt_at: NOW, last_error: null, acknowledged_at: null, created_at: NOW, updated_at: NOW })
  ]);
  return { deliveryId };
}
