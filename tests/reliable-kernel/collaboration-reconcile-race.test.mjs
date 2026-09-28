import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// Collaboration convergence (CollaborationControlPlane.reconcile) is level-triggered and runs from
// several places at once: another window of the data set, this Host's runtime convergence (100 ms
// after a relevant commit), the startup recovery, a data-root relocation's settlement. A task no Turn
// will answer gets exactly one failure reply however those runs interleave: the run that finds the
// reply already sent by another uses it, and none of them fails. The startup recovery in particular
// must not fail there: it starts the process exit observers only after that reconcile.
const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');

const PROVIDER_ID = 'reconcile-race-provider';
const PROJECT = { uri: 'file:///workspace/reconcile-race', name: '收敛竞争' };
const [REQUESTER, PEER] = ['conversation-requester', 'conversation-peer'];
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

test('两个收敛交错：一个正要发失败回复时，另一个抢先发出同一条回复并把任务记为失败；后到的一方直接用已发出的回复，不报错，只有一条回复', { timeout: 120_000 }, async (t) => {
  const app = await openRuntime(t, 'interleaved');
  await failedFollowup(app, 'followup-interleaved');
  const collaboration = app.runtime.collaboration;
  const race = interleaveAtSecondTaskRead(collaboration, () => collaboration.reconcile());

  await collaboration.reconcile();
  assert.equal(race.fired, true, '另一个收敛确实插在了"重放之后、再读任务之前"');
  assert.equal(race.otherError, undefined);
  assert.equal(race.taskAfterOther, 'failed', '插进来的收敛已发出回复并把任务记为失败');
  await assertOneFailureReply(app, 'followup-interleaved');
});

test('两个收敛自然竞争（不挂钩子，随机错开 0–12ms）：每一次都不报错，每个任务只有一条回复', { timeout: 180_000 }, async (t) => {
  const app = await openRuntime(t, 'natural');
  const collaboration = app.runtime.collaboration;
  const outcomes = [];
  for (let run = 0; run < 16; run += 1) {
    const id = `followup-natural-${run}`;
    await failedFollowup(app, id);
    const offset = Math.floor(Math.random() * 13);
    const [first, second] = await Promise.allSettled([
      collaboration.reconcile(),
      sleep(offset).then(() => collaboration.reconcile())
    ]);
    outcomes.push([offset, ...[first, second].map((result) => result.status === 'fulfilled' ? 'ok' : String(result.reason?.message ?? result.reason))]);
    await assertOneFailureReply(app, id);
  }
  assert.deepEqual(outcomes.filter(([, first, second]) => first !== 'ok' || second !== 'ok'), [], JSON.stringify(outcomes));
});

test('启动恢复与运行时收敛并发：收敛抢先发出同一条失败回复，恢复不失败，进程退出观察器照常启动', { timeout: 120_000 }, async (t) => {
  const app = await openRuntime(t, 'recover');
  await failedFollowup(app, 'followup-recover');
  let observersStarted = 0;
  const startExitObservers = app.processes.startExitObservers;
  app.processes.startExitObservers = async function (...args) {
    observersStarted += 1;
    return startExitObservers.apply(this, args);
  };
  // This Host's runtime convergence (its timer fires 100 ms after a relevant commit) runs to the end
  // right inside the recovery's reconcile, after its replay found no reply yet.
  const race = interleaveAtSecondTaskRead(app.runtime.collaboration, () => app.runRuntimeConvergence());

  await app.recover();
  assert.equal(race.fired, true);
  assert.equal(race.taskAfterOther, 'failed', '收敛已发出回复并把任务记为失败');
  assert.equal(observersStarted, 1, '恢复走完：退出观察器启动');
  assert.equal(app.processes.exitObserversEnabled, true);
  await assertOneFailureReply(app, 'followup-recover');
});

// ---- fixture ----

/**
 * Runs `other` to its end the moment `collaboration` reads the pending task for the second time in
 * a failure reply (sendInternal: the first read resolves the reply's source, the second decides
 * whether the task still owes it), that is after the reply's replay found nothing. Fires once.
 */
function interleaveAtSecondTaskRead(collaboration, other) {
  const existing = collaboration.existing;
  const state = { fired: false, reads: 0, otherError: undefined, taskAfterOther: undefined };
  collaboration.existing = async function (domain, id) {
    if (!state.fired && domain === 'CollaborationRequest' && ++state.reads === 2) {
      state.fired = true;
      try {
        await other();
      } catch (error) {
        state.otherError = error;
      }
      state.taskAfterOther = (await existing.call(this, domain, id)).state;
    }
    return existing.call(this, domain, id);
  };
  return state;
}

/**
 * A cross-conversation followup from the requester to the peer whose only delivery failed: no Turn
 * will answer it, so convergence owes the requester one failure reply (collaboration-lifecycle's
 * fixture). Ids derive from `id`.
 */
async function failedFollowup(app, id) {
  const now = new Date().toISOString();
  const payload = await app.contentStore.ingest(app.database, `请复核部署脚本（${id}）`, 'text/vnd.limcode.collaboration-message');
  await app.database.transaction([
    repo('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode: 'followup', created_at: now }, { column: 'message_seq', scope: {} }),
    repo('CollaborationMessageSourceLink').insert({ id: `${id}-source`, message_id: id, conversation_id: REQUESTER, source_kind: 'tool',
      source_key: id, turn_id: null, tool_call_id: null, created_at: now }),
    repo('RuntimeInboxItem').insert({ id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id,
      state: 'routed', created_at: now, updated_at: now }),
    repo('CollaborationMessageTargetLink').insert({ id: `${id}-target`, message_id: id, conversation_id: PEER, inbox_item_id: `${id}-inbox`,
      anchor_turn_id: null, created_at: now }),
    repo('CollaborationMessagePayloadLink').insert({ id: `${id}-payload`, message_id: id, content_object_id: payload.id, created_at: now }),
    repo('RuntimeInboxPayloadLink').insert({ id: `${id}-inbox-payload`, inbox_item_id: `${id}-inbox`, content_object_id: payload.id, created_at: now }),
    repo('RuntimeDelivery').insert({ id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: PEER, target_turn_id: null,
      phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'failed', failure_reason: 'wake-dead-letter:fixture',
      created_at: now, updated_at: now }),
    repo('CollaborationBudget').insert({ id: `${id}-budget`, origin_kind: 'turn', origin_key: `${id}-origin`,
      authority_turn_id: `${id}-historical-turn`, created_at: now }),
    repo('CollaborationRequest').insert({ id: `${id}-request`, message_id: id, budget_id: `${id}-budget`, automatic: 1n, state: 'pending',
      created_at: now, updated_at: now })
  ]);
}

/** The task failed and its requester got exactly one reply, delivered once. */
async function assertOneFailureReply(app, id) {
  assert.equal((await rows(app, 'CollaborationRequest', { id: `${id}-request` }))[0].state, 'failed', `任务 ${id} 记为失败`);
  const replies = await rows(app, 'CollaborationMessageReplyLink', { request_message_id: id });
  assert.equal(replies.length, 1, `任务 ${id} 只有一条回复`);
  const [target] = await rows(app, 'CollaborationMessageTargetLink', { message_id: replies[0].message_id });
  assert.equal(target.conversation_id, REQUESTER);
  assert.equal((await rows(app, 'RuntimeDelivery', { inbox_item_id: target.inbox_item_id })).length, 1, `任务 ${id} 的回复只投递一次`);
  const [source] = await rows(app, 'CollaborationMessageSourceLink', { message_id: replies[0].message_id });
  assert.deepEqual([source.source_kind, source.turn_id], ['completion', null], '是没有轮次作答的失败回复');
}

/** A Runtime of its own, its runtime convergence held so that only the test decides when it runs. */
async function openRuntime(t, label) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-reconcile-race-${label}-`));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  const dataRoot = candidate.binding.paths.dataRootPath;
  const app = await kernel.ReliableKernelApplication.open(new kernel.RootAuthority(() => dataRoot), {
    ...fixtureDependencies(),
    holdRuntimeConvergence: true
  });
  t.after(async () => {
    await app.close();
    await fs.rm(outer, { recursive: true, force: true });
  });
  for (const conversationId of [REQUESTER, PEER]) await createConversation(app, conversationId);
  return app;
}

async function createConversation(app, conversationId) {
  const now = new Date().toISOString();
  await app.database.transaction([
    repo('Conversation').insert({ id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now }),
    repo('AgentConversationLink').insert({
      id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now
    }),
    ...projectFolderAssignmentSteps({ conversationId, folder: PROJECT, now })
  ]);
}

function fixtureDependencies() {
  const provider = {
    providerId: PROVIDER_ID,
    async sendFullRequest() { throw new Error('这些用例不应调用模型。'); }
  };
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: PROVIDER_ID, modelId: 'reconcile-race-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: { providerConfigId: PROVIDER_ID, provider: 'openai-compatible', modelId: 'reconcile-race-model', retryPolicy: { enabled: false, maxRetries: 0 } },
              modelProfile: { compressionThresholdTokens: 100_000, contextWindowTokens: 128_000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
              toolPolicy: { id: 'reconcile-race-tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
              planReviewPolicy: { mode: 'off' },
              systemPrompt: { id: 'reconcile-race-prompt', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('这些用例不应调用 MCP。'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: {
      async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      }
    },
    providers: {
      resolve(providerId) {
        if (providerId !== PROVIDER_ID) throw new Error(`Unexpected provider ${providerId}.`);
        return provider;
      }
    },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({
        database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
        host: { definitions() { return []; }, async cancelTurnWaits() {}, async dispose() {} }
      })
  };
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(repo(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
