import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Window eligibility for pending runtime deliveries: ownership is claimed and kept only by a window
// that can execute the work it is held for. An idle Conversation waiting for deliveries is placed by
// the continuations they start (a continuation inherits its source Turn's frozen work environment);
// a wake whose continuation cannot run here hands the Conversation back.
const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { emptyConversationContextHandleStateStep } = await load('backend/reliableKernel/conversationContextHandleState.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const {
  evaluateConversationEntryEligibility,
  evaluateConversationHostEligibility
} = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { createRuntimeDeliveryWakeHandler } = await load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');
const { ReliableChildAgentCoordinator } = await load('backend/reliableKernel/childAgentCoordinator.js');
const { runAgentTool } = await load('backend/world/modules/tools/definitions/runAgent/index.js');
const { readFrozenTurnAuthority, frozenWorkEnvironmentPolicy } = await load('backend/reliableKernel/frozenAuthority.js');
const { preparedContentObjectSteps } = await load('backend/reliableKernel/contentObjectTransaction.js');
const { workEnvironmentIdFromUri } = await load('shared/workEnvironmentCatalog.js');

const PROVIDER_ID = 'delivery-placement-provider';
const PROJECT_ONE = 'file:///workspace/project-one';
const PROJECT_TWO = 'file:///workspace/project-two';
const PROJECT_TWO_FOLDER = { uri: PROJECT_TWO, name: '项目二' };
const PROJECT_TWO_ENV = workEnvironmentIdFromUri(PROJECT_TWO);
const PROJECT_TWO_RECORD = { id: PROJECT_TWO_ENV, name: '项目二', displayPath: '/workspace/project-two', available: true };
/** A work environment chosen for the Conversation, for example a remote server available in every window. */
const CHOSEN = { id: 'work-env-chosen', name: '远程环境', displayPath: '/remote/work', available: true };
/** A local folder chosen for the Conversation that only one window has. */
const FOLDER_F = { id: 'work-env-folder-f', name: '目录 F', displayPath: '/workspace/f', available: true };
const TEST_FILE = fileURLToPath(import.meta.url);

const workerMode = process.env.LIMCODE_DELIVERY_WORKER;
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

test('H1：续跑的源 Turn 冻结项目环境、对话所选环境是远程环境：没打开项目的窗口不认领也不占住，项目窗口续跑并能发新消息（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('h1');
  let setup; let w3; let child;
  try {
    const conversationId = 'conversation-h1';
    // Turn A ran in the project window and froze the project's own work environment; it started a
    // background process that finished while the Conversation was idle. The user has since chosen CHOSEN.
    setup = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: 'A 完成' }] }]), {
      folders: [PROJECT_TWO], label: 'setup', frozen: PROJECT_TWO_ENV, environments: [PROJECT_TWO_RECORD]
    });
    await createConversation(setup.app, conversationId, PROJECT_TWO_FOLDER);
    const turnA = await setup.runner.input({ commandId: 'h1-a', conversationId, text: 'A：启动后台构建' });
    await eventually(async () => (await rows(setup.app, 'Turn', { id: turnA.turnId }))[0]?.status === 'terminated', 30_000, 'A 未结束');
    await setup.runner.waitForIdle();
    const created = await pendingProcessDelivery(setup.app, 'proc-h1', conversationId, turnA.turnId);
    await setup.close(); setup = undefined;

    // W2: project two not open; CHOSEN available and chosen, so a new Turn could start here.
    const files = workerFiles(outer, 'w2');
    child = spawnWorker(dataRoot, 'window', { ...files.env, LIMCODE_DELIVERY_CONVERSATION: conversationId,
      LIMCODE_DELIVERY_CONFIG: JSON.stringify({ folders: [PROJECT_ONE], environments: [CHOSEN], selected: CHOSEN.id, frozen: CHOSEN.id }) });
    const w2 = await waitForWorkerJson(child, files.ready, 90_000);
    assert.equal(w2.everOwned, false, 'W2 不能执行这项续跑，不认领');
    assert.deepEqual(w2.handled, [], 'W2 不处理这条投递');
    assert.deepEqual(w2.eligibility, { eligible: false, reason: 'project_not_open', projectUri: PROJECT_TWO, projectName: '项目二' });
    assert.equal(w2.newTurnEntry.eligible, true, '对比：W2 可以开始新的 Turn（所选环境可用）');

    // W3, the project window, while W2 stays open.
    const provider3 = scriptedProvider([{ role: 'model', parts: [{ text: '续跑完成' }] }, { role: 'model', parts: [{ text: '新消息回复' }] }]);
    w3 = await openHost(dataRoot, provider3, {
      folders: [PROJECT_TWO], label: 'w3', frozen: CHOSEN.id, selected: CHOSEN.id, environments: [CHOSEN, PROJECT_TWO_RECORD], wake: true
    });
    assert.deepEqual(await w3.eligibility(conversationId), { eligible: true });
    await w3.app.recover();
    await w3.runner.recoverStartup();
    await eventually(async () => {
      await w3.app.refreshExternalRuntimeWork();
      return provider3.calls >= 1;
    }, 60_000, '项目窗口没有续跑');
    await w3.runner.waitForIdle();
    assert.deepEqual(w3.handled.map((h) => [h.action, h.acknowledged]), [['start_continuation', true]]);
    const continuation = (await rows(w3.app, 'Turn', { conversation_id: conversationId })).find((turn) => turn.id !== turnA.turnId);
    assert.equal(continuation?.status, 'terminated');
    assert.equal((await frozenPolicy(w3.app, continuation.id)).defaultWorkEnvironmentId, PROJECT_TWO_ENV, '续跑继承源 Turn 的项目环境');
    assert.notEqual((await rows(w3.app, 'RuntimeDelivery', { id: created.delivery.id }))[0]?.state, 'pending');
    const next = await w3.runner.input({ commandId: 'h1-new', conversationId, text: '项目窗口的新消息' });
    assert.equal(next.admitted, true, '项目窗口的新消息不被挡');
    await eventually(async () => provider3.calls === 2, 30_000, '新消息没有执行');

    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 60_000, true);
    const result = await readJson(files.result);
    assert.equal(result.everOwned, false, 'W2 始终没有占住对话');
    assert.deepEqual(result.handled, []);
  } finally {
    if (child) await fs.writeFile(workerFiles(outer, 'w2').finish, 'finish\n', 'utf8').catch(() => undefined);
    await setup?.close();
    await w3?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('H1 反向：对话在项目窗口判为合格，但续跑的源 Turn 冻结了只有另一窗口才有的目录 F：项目窗口不认领，有 F 的窗口续跑（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('h1-reverse');
  let setup; let wf; let child;
  try {
    const conversationId = 'conversation-h1-reverse';
    // The project folder moved; in a window with folder F the user chose F, and Turn A there froze F.
    setup = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: 'A 完成' }] }]), {
      folders: [PROJECT_ONE], label: 'setup', frozen: FOLDER_F.id, selected: FOLDER_F.id, environments: [FOLDER_F]
    });
    await createConversation(setup.app, conversationId, PROJECT_TWO_FOLDER);
    const turnA = await setup.runner.input({ commandId: 'r-a', conversationId, text: 'A：在 F 中启动后台任务' });
    await eventually(async () => (await rows(setup.app, 'Turn', { id: turnA.turnId }))[0]?.status === 'terminated', 30_000, 'A 未结束');
    await setup.runner.waitForIdle();
    const created = await pendingProcessDelivery(setup.app, 'proc-reverse', conversationId, turnA.turnId);
    await setup.close(); setup = undefined;

    // The project window: project two open, F not here. Before the fix the idle project rule claimed it.
    const files = workerFiles(outer, 'project');
    child = spawnWorker(dataRoot, 'window', { ...files.env, LIMCODE_DELIVERY_CONVERSATION: conversationId,
      LIMCODE_DELIVERY_CONFIG: JSON.stringify({ folders: [PROJECT_TWO], environments: [PROJECT_TWO_RECORD], frozen: PROJECT_TWO_ENV }) });
    const project = await waitForWorkerJson(child, files.ready, 90_000);
    assert.equal(project.everOwned, false, '项目窗口不能执行这项续跑，不认领');
    assert.deepEqual(project.handled, []);
    assert.equal(project.eligibility.eligible, false);
    assert.equal(project.eligibility.reason, 'work_environment_unavailable');
    assert.equal(project.eligibility.turnId, turnA.turnId);
    assert.equal(project.eligibility.workEnvironmentId, FOLDER_F.id);

    const provider = scriptedProvider([{ role: 'model', parts: [{ text: 'F 中续跑完成' }] }]);
    wf = await openHost(dataRoot, provider, {
      folders: [PROJECT_ONE], label: 'wf', frozen: FOLDER_F.id, selected: FOLDER_F.id, environments: [FOLDER_F], wake: true
    });
    await wf.app.recover();
    await wf.runner.recoverStartup();
    await eventually(async () => {
      await wf.app.refreshExternalRuntimeWork();
      return provider.calls >= 1;
    }, 60_000, '有 F 的窗口没有续跑');
    await wf.runner.waitForIdle();
    const continuation = (await rows(wf.app, 'Turn', { conversation_id: conversationId })).find((turn) => turn.id !== turnA.turnId);
    assert.equal(continuation?.status, 'terminated');
    assert.equal((await frozenPolicy(wf.app, continuation.id)).defaultWorkEnvironmentId, FOLDER_F.id);
    assert.notEqual((await rows(wf.app, 'RuntimeDelivery', { id: created.delivery.id }))[0]?.state, 'pending');

    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 60_000, true);
    assert.equal((await readJson(files.result)).everOwned, false, '项目窗口始终没有占住对话');
  } finally {
    if (child) await fs.writeFile(workerFiles(outer, 'project').finish, 'finish\n', 'utf8').catch(() => undefined);
    await setup?.close();
    await wf?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('H1 子 Agent 答复：父对话等待子 Agent 的答复时按派出子 Agent 的父 Turn 冻结的环境放置', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('h1-answer');
  let host;
  try {
    const conversationId = 'conversation-h1-answer';
    let parentCalls = 0;
    const provider = {
      providerId: PROVIDER_ID,
      calls: 0,
      async sendFullRequest(request, controls) {
        this.calls += 1;
        let content;
        if (request.conversationId === conversationId) {
          parentCalls += 1;
          content = parentCalls === 1
            ? { role: 'model', parts: [{ id: 'spawn', functionCall: { name: 'run_agent',
              args: { operation: 'spawn', taskName: 'answer', prompt: '子任务', foregroundWaitMs: 0 } } }] }
            : { role: 'model', parts: [{ text: `父第 ${parentCalls} 次` }] };
        } else {
          content = { role: 'model', parts: [{ text: '子任务完成' }] };
        }
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
      }
    };
    // No wake handler: the child's answer stays pending for the parent Conversation.
    host = await openHost(dataRoot, provider, {
      folders: [PROJECT_ONE], label: 'answer', frozen: FOLDER_F.id, selected: FOLDER_F.id, environments: [FOLDER_F], children: true
    });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const parent = await host.runner.input({ commandId: 'answer-parent', conversationId, text: '派一个子 Agent' });
    await eventually(async () => (await rows(host.app, 'Turn', { id: parent.turnId }))[0]?.status === 'terminated', 30_000, '父 Turn 未结束');
    const [execution] = await rows(host.app, 'ChildExecution', {});
    await eventually(async () => (await rows(host.app, 'RuntimeDelivery', { target_conversation_id: conversationId }))
      .some((delivery) => delivery.state === 'pending' && delivery.phase === 'next_turn' && delivery.target_turn_id === null),
    30_000, '子 Agent 的答复没有投递给父对话');
    await host.runner.waitForIdle();
    assert.equal((await rows(host.app, 'Turn', { conversation_id: conversationId, status: 'active' })).length, 0, '父对话空闲');
    const [item] = await rows(host.app, 'RuntimeInboxItem', { source_kind: 'answer_submission' });
    assert.ok(item, '答复经 answer_submission 投递');
    assert.equal(execution.child_conversation_id !== conversationId, true);
    const probe = (folders, environments) => evaluateConversationHostEligibility({
      database: host.app.database, contentStore: host.app.contentStore,
      workspaceFolderUris: () => folders, workEnvironments: async () => environments,
      nextTurnWorkEnvironment: async () => ({ workEnvironmentId: CHOSEN.id, policy: {} })
    }, conversationId);
    // A window that could start a new Turn (preview succeeds) but lacks F, the parent Turn's work environment.
    assert.deepEqual(await probe([PROJECT_TWO], [PROJECT_TWO_RECORD, CHOSEN]), {
      eligible: false, reason: 'work_environment_unavailable', turnId: parent.turnId, workEnvironmentId: FOLDER_F.id
    });
    assert.deepEqual(await probe([PROJECT_ONE], [FOLDER_F]), { eligible: true }, '有 F 的窗口服务它');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('H1 交还：唤醒处理因本窗口不能执行续跑而返回未确认时交还对话归属，即使资格探针认为本窗口合格、对话仍有待处理投递', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('h1-handback');
  let setup; let host;
  try {
    const conversationId = 'conversation-h1-handback';
    setup = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: 'A 完成' }] }]), {
      folders: [PROJECT_TWO], label: 'setup', frozen: PROJECT_TWO_ENV, environments: [PROJECT_TWO_RECORD]
    });
    await createConversation(setup.app, conversationId, PROJECT_TWO_FOLDER);
    const turnA = await setup.runner.input({ commandId: 'hb-a', conversationId, text: 'A' });
    await eventually(async () => (await rows(setup.app, 'Turn', { id: turnA.turnId }))[0]?.status === 'terminated', 30_000, 'A 未结束');
    await setup.runner.waitForIdle();
    await pendingProcessDelivery(setup.app, 'proc-handback', conversationId, turnA.turnId);
    await setup.close(); setup = undefined;

    host = await openHost(dataRoot, scriptedProvider([]), {
      folders: [PROJECT_ONE], label: 'hb', frozen: CHOSEN.id, selected: CHOSEN.id, environments: [CHOSEN], wake: true
    });
    // A claim probe that answers eligible (it disagrees with the continuation's own decision).
    host.app.database.conversationOwners.setClaimEligibilityProbe(async () => true);
    await host.app.recover();
    await host.runner.recoverStartup();
    await eventually(async () => {
      await host.app.refreshExternalRuntimeWork();
      return host.handled.length > 0;
    }, 30_000, '投递调度没有处理这条投递');
    assert.deepEqual(host.handled.map((h) => [h.action, h.acknowledged]).slice(0, 1), [['start_continuation', false]]);
    assert.equal(await host.app.database.hasConversationRuntimeWork(conversationId), true, '投递仍待处理');
    await eventually(async () => !host.owns(conversationId), 5_000, '不能执行续跑的窗口仍持有对话归属');
  } finally {
    await setup?.close();
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('放置判定：混合工作（活动 Turn 在所选环境、排队消息冻结项目环境）要求打开项目；继承源 Turn 的续跑入口也要求现有工作可放置', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('mixed');
  let host;
  try {
    const conversationId = 'conversation-mixed';
    const provider = gatedProvider();
    const frozen = { value: CHOSEN.id };
    host = await openHost(dataRoot, provider, {
      folders: [PROJECT_TWO], label: 'mixed', frozenRef: frozen, environments: [CHOSEN, PROJECT_TWO_RECORD]
    });
    host.runner.setEntryEligibility(async () => 'eligible');
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const first = await host.runner.input({ commandId: 'm-1', conversationId, text: '在所选环境运行' });
    await provider.started;
    frozen.value = PROJECT_TWO_ENV;
    await host.runner.input({ commandId: 'm-2', conversationId, text: '排队（冻结项目环境）' });
    const [queued] = await rows(host.app, 'TurnIntent', { conversation_id: conversationId, state: 'queued' });
    assert.ok(queued, '第二条排队');
    // A window without project two whose catalog marks both environments available.
    const elsewhere = {
      database: host.app.database, contentStore: host.app.contentStore,
      workspaceFolderUris: () => [PROJECT_ONE],
      workEnvironments: async () => [CHOSEN, PROJECT_TWO_RECORD],
      nextTurnWorkEnvironment: async () => ({ workEnvironmentId: CHOSEN.id, policy: {} })
    };
    const refused = { eligible: false, reason: 'project_not_open', projectUri: PROJECT_TWO, projectName: '项目二' };
    assert.deepEqual(await evaluateConversationHostEligibility(elsewhere, conversationId), refused, '排队消息需要项目打开');
    assert.deepEqual(await evaluateConversationEntryEligibility(elsewhere, conversationId, { inheritsFromTurnId: first.turnId }), refused,
      '继承运行中 Turn 的续跑也要求现有排队工作可放置');
    const here = { ...elsewhere, workspaceFolderUris: () => [PROJECT_TWO] };
    assert.deepEqual(await evaluateConversationHostEligibility(here, conversationId), { eligible: true });
    provider.release();
    await eventually(async () => provider.calls === 2, 30_000, '排队消息没有执行');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('空闲对话：下一个 Turn 的预览带错误（即使同时给出工作环境）不算可在本窗口开始；无错误才算', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('idle-preview');
  let host;
  try {
    host = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_ONE], label: 'idle' });
    const conversationId = 'conversation-idle-preview';
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const probe = (preview) => evaluateConversationHostEligibility({
      database: host.app.database, contentStore: host.app.contentStore,
      workspaceFolderUris: () => [PROJECT_ONE], workEnvironments: async () => [CHOSEN],
      nextTurnWorkEnvironment: async () => preview
    }, conversationId);
    const refused = { eligible: false, reason: 'project_not_open', projectUri: PROJECT_TWO, projectName: '项目二' };
    assert.deepEqual(await probe({ workEnvironmentId: CHOSEN.id, error: '工作环境未获当前策略允许' }), refused);
    assert.deepEqual(await probe({ error: '当前窗口的工作环境不可用' }), refused);
    assert.deepEqual(await probe(undefined), refused);
    assert.deepEqual(await probe({ workEnvironmentId: CHOSEN.id, policy: {} }), { eligible: true });
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

/** A finished background Process started by `sourceTurnId` and its automatic delivery to the idle Conversation. */
async function pendingProcessDelivery(app, id, conversationId, sourceTurnId) {
  const repo = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
  const at = new Date().toISOString();
  const payload = await app.contentStore.prepare(app.database, JSON.stringify({ kind: 'process_completion',
    processId: id, processReceiptId: `receipt-${id}`, sourceTurnId, conversationId }),
  'application/vnd.limcode.process-completion+json');
  await app.database.transaction([
    ...preparedContentObjectSteps([payload], 'fixture_process_result'),
    repo('Process').insert({ id, status: 'exited', wrapper_nonce: `nonce-${id}`, wrapper_pid: 0n, child_pid: null,
      process_group_id: null, start_fingerprint: `fingerprint-${id}`, command_digest: `digest-${id}`,
      spool_locator: `spool/${id}`, retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n,
      started_at: at, updated_at: at, completed_at: at }),
    repo('ProcessCompletionSourceLink').insert({ id: `source-${id}`, process_id: id, conversation_id: conversationId,
      source_turn_id: sourceTurnId, source_tool_call_id: `${id}-tool`, created_at: at }),
    repo('ProcessReceipt').insert({ id: `receipt-${id}`, process_id: id, outcome: 'succeeded', exit_code: 0n,
      exit_signal: null, wrapper_nonce: `nonce-${id}`, start_fingerprint: `fingerprint-${id}`, received_at: at }),
    repo('RuntimeInboxItem').insert({ id, dedupe_key: `fixture:${id}`, source_kind: 'process_receipt',
      source_id: `receipt-${id}`, state: 'available', created_at: at, updated_at: at }),
    repo('RuntimeInboxPayloadLink').insert({ id: `payload-${id}`, inbox_item_id: id,
      content_object_id: payload.metadata.id, created_at: at })
  ]);
  const created = await app.runtime.deliveries.createAutomatic({ inboxItemId: id, targetConversationId: conversationId, sourceTurnId });
  assert.equal(created.delivery.phase, 'next_turn');
  assert.equal(created.delivery.state, 'pending');
  return created;
}

}

/** Another window on the same Runtime root, open until the test lets it finish. */
async function runWorker(mode) {
  if (mode !== 'window') throw new Error(`Unknown worker ${mode}`);
  const dataRoot = requiredEnv('LIMCODE_DELIVERY_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_DELIVERY_CONVERSATION');
  const config = JSON.parse(requiredEnv('LIMCODE_DELIVERY_CONFIG'));
  const host = await openHost(dataRoot, scriptedProvider([]), { ...config, label: 'worker', wake: true });
  let everOwned = false;
  const owners = host.app.database.conversationOwners;
  const claims = [];
  for (const method of ['claim', 'tryClaim', 'run', 'tryClaimEligible']) {
    const original = owners[method].bind(owners);
    owners[method] = async (...args) => {
      if (args[0] === conversationId) claims.push(method);
      return original(...args);
    };
  }
  const watch = setInterval(() => { if (host.owns(conversationId)) everOwned = true; }, 5);
  try {
    await host.app.recover();
    await host.runner.recoverStartup();
    // Several delivery and recovery passes.
    for (let i = 0; i < 6; i += 1) {
      await host.app.refreshExternalRuntimeWork();
      host.runner.recoverUnheldTurns();
      await sleep(250);
    }
    await writeJson(requiredEnv('LIMCODE_DELIVERY_READY'), {
      everOwned: everOwned || host.owns(conversationId),
      claims,
      handled: host.handled,
      eligibility: await host.eligibility(conversationId),
      newTurnEntry: await host.entry(conversationId)
    });
    // Stay open (and keep scanning) while the other window works.
    const finish = requiredEnv('LIMCODE_DELIVERY_FINISH');
    for (;;) {
      try { await fs.access(finish); break; } catch { /* not yet */ }
      await host.app.refreshExternalRuntimeWork();
      host.runner.recoverUnheldTurns();
      await sleep(100);
    }
    await writeJson(requiredEnv('LIMCODE_DELIVERY_RESULT'), { everOwned: everOwned || host.owns(conversationId), handled: host.handled });
  } finally {
    clearInterval(watch);
    await host.close();
  }
}

async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  const environments = (options.environments ?? []).map((environment) => ({ ...environment }));
  const frozen = options.frozenRef ?? { value: options.frozen ?? null };
  // Stands in for VscodeConfigurationAuthority.previewWorkEnvironment: an explicit choice first,
  // then the project's own folder; the same policy compile() freezes.
  const previewWorkEnvironment = async (request) => {
    const selected = options.selected;
    const id = selected ?? (request.workspace ? workEnvironmentIdFromUri(request.workspace.uri) : undefined);
    if (!id) return {};
    const available = selected
      ? environments.some((environment) => environment.id === id && environment.available)
      : folders.includes(request.workspace.uri);
    if (!available) return { error: `当前窗口的工作环境不可用：${id}，请打开对应目录或重新选择。` };
    return { workEnvironmentId: id, policy: { id: null, enabled: false, allowedWorkEnvironmentIds: [id], defaultWorkEnvironmentId: id } };
  };
  let coordinator;
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, frozen, previewWorkEnvironment, options.children ? () => coordinator : undefined)
  );
  if (options.children) {
    coordinator = new ReliableChildAgentCoordinator({
      database: app.database, ...app.runtime, modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: 'agent-worker', agentType: 'worker' }; } },
      modelProfiles: { async initializeConversation() { return { created: true }; } },
      deliveryWakeups: app.processDeliveries, ownedProcessCleanup: app.childOwnedProcessCleanup, deadHostEffects: app.phaseDRecovery
    });
  }
  const runnerErrors = [];
  const runner = new ReliableConversationRunner(app, `${options.label}:${app.database.hostBootId}`,
    (error, context) => runnerErrors.push({ error, context }));
  const handled = [];
  if (options.wake) {
    const handler = createRuntimeDeliveryWakeHandler({ application: () => app, conversations: () => runner, children: () => coordinator });
    app.processDeliveries.setWakeHandler(async (request) => {
      const result = await handler(request);
      handled.push({ action: request.action, sourceKind: request.sourceKind, sourceTurnId: request.sourceTurnId, ...result });
      return result;
    });
  }
  const base = {
    database: app.database,
    contentStore: app.contentStore,
    workspaceFolderUris: () => folders,
    workEnvironments: async () => environments,
    nextTurnWorkEnvironment: (id, next) => app.turns.previewNextTurnWorkEnvironment(id, next?.executorAgentId)
  };
  // The same wiring as VscodeReliableKernelProductRuntime.
  const eligibility = (conversationId) => evaluateConversationHostEligibility(base, conversationId);
  const entry = (conversationId, next) => evaluateConversationEntryEligibility(base, conversationId, next);
  app.database.conversationOwners.setClaimEligibilityProbe(async (conversationId) => (await eligibility(conversationId)).eligible);
  runner.setEntryEligibility(async (conversationId, next) => {
    try {
      return (await entry(conversationId, next)).eligible ? 'eligible' : 'ineligible';
    } catch {
      return 'unknown';
    }
  });
  let closed = false;
  return {
    app, runner, runnerErrors, folders, environments, eligibility, entry, handled, coordinator,
    owns: (conversationId) => app.database.conversationOwners.owns(conversationId),
    async close() {
      if (closed) return;
      closed = true;
      runner.dispose();
      await app.beginHandoff().catch(() => undefined);
      await runner.waitForIdle().catch(() => undefined);
      await coordinator?.dispose().catch(() => undefined);
      await app.close();
    }
  };
}

function gatedProvider() {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  return {
    providerId: PROVIDER_ID,
    started,
    release: () => release(),
    get calls() { return calls; },
    async sendFullRequest(_request, controls) {
      calls += 1;
      if (calls === 1) {
        markStarted();
        await gate;
      }
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: `回复${calls}` }] } });
    }
  };
}

function scriptedProvider(replies) {
  let calls = 0;
  return {
    providerId: PROVIDER_ID,
    get calls() { return calls; },
    async sendFullRequest(_request, controls) {
      calls += 1;
      const content = replies[calls - 1];
      if (!content) throw new Error(`Unexpected Provider call ${calls}.`);
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
    }
  };
}

function fixtureDependencies(provider, frozen, previewWorkEnvironment, coordinator) {
  return {
    authorityCompiler: {
      previewWorkEnvironment,
      async compile(request) {
        const defaultWorkEnvironmentId = frozen.value;
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'delivery-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: { providerConfigId: provider.providerId, provider: 'openai-compatible', modelId: 'delivery-model', retryPolicy: { enabled: false, maxRetries: 0 } },
              modelProfile: { compressionThresholdTokens: 100_000, contextWindowTokens: 128_000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
              toolPolicy: { id: 'delivery-tools', allowedTools: coordinator ? ['run_agent'] : [], preset: coordinator ? 'yolo' : 'custom', toolConfigs: {}, sourceConfigs: {} },
              planReviewPolicy: { mode: 'off' },
              systemPrompt: { id: 'delivery-prompt', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: {
                id: null,
                enabled: false,
                allowedWorkEnvironmentIds: defaultWorkEnvironmentId ? [defaultWorkEnvironmentId] : [],
                defaultWorkEnvironmentId
              }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async (id) => ({ id, rootPath: os.tmpdir() }),
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: {
      async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      }
    },
    providers: {
      resolve(providerId) {
        if (providerId !== provider.providerId) throw new Error(`Unexpected provider ${providerId}.`);
        return provider;
      }
    },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({
        database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
        host: {
          definitions() { return coordinator ? [runAgentTool] : []; },
          async dispatchSpecial(_definition, input, authority, signal, admission) {
            return coordinator?.().dispatch(input, signal, authority, admission);
          },
          async cancelTurnWaits(input) { await coordinator?.().cancelParentWaits(input); },
          async quiesce(reason) { await coordinator?.().quiesce(reason); },
          async dispose() {}
        }
      })
  };
}

async function frozenPolicy(app, turnId) {
  const [snapshot] = await rows(app, 'AuthoritySnapshot', { turn_id: turnId });
  return frozenWorkEnvironmentPolicy((await readFrozenTurnAuthority(app.database, app.contentStore, snapshot.id, turnId)).document);
}

async function createConversation(app, conversationId, project) {
  const now = new Date().toISOString();
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now
    }),
    emptyConversationContextHandleStateStep(conversationId, now),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main',
      role: 'default', created_at: now, updated_at: now
    }),
    ...(project ? projectFolderAssignmentSteps({ conversationId, folder: project, now }) : [])
  ]);
}

async function createIsolatedRoot(label) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-delivery-${label}-`));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  return { outer, dataRoot: candidate.binding.paths.dataRootPath };
}

async function rows(appOrDatabase, domain, where = {}) {
  const database = appOrDatabase.database ?? appOrDatabase;
  return (await database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
}

function workerFiles(outer, name) {
  const files = {
    ready: path.join(outer, `${name}-ready.json`),
    finish: path.join(outer, `${name}-finish`),
    result: path.join(outer, `${name}-result.json`)
  };
  return {
    ...files,
    env: { LIMCODE_DELIVERY_READY: files.ready, LIMCODE_DELIVERY_FINISH: files.finish, LIMCODE_DELIVERY_RESULT: files.result }
  };
}

function spawnWorker(dataRoot, mode, environment) {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, LIMCODE_DELIVERY_WORKER: mode, LIMCODE_DELIVERY_DATA_ROOT: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { child.output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { child.output.stderr += chunk; });
  return child;
}

/** Waits for a worker's JSON file, failing at once (with its output) if the worker exits first. */
async function waitForWorkerJson(child, filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readJson(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`delivery worker exited before ${path.basename(filePath)} (code=${child.exitCode})\n${child.output.stdout}\n${child.output.stderr}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await sleep(20);
  }
}

async function stopChild(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForExit(child, 15_000).catch(() => undefined);
}

function waitForExit(child, timeoutMs, rejectNonZero = false) {
  return new Promise((resolve, reject) => {
    const settle = (code, signal) => {
      if (rejectNonZero && code !== 0) {
        reject(new Error(`delivery worker failed (code=${code}, signal=${signal})\n${child.output?.stdout ?? ''}\n${child.output?.stderr ?? ''}`));
      } else {
        resolve({ code, signal });
      }
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      settle(child.exitCode, child.signalCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`delivery worker timed out after ${timeoutMs}ms\n${child.output?.stdout ?? ''}\n${child.output?.stderr ?? ''}`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      settle(code, signal);
    });
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(value)}\n`, 'utf8');
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function eventually(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(20);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment: ${name}`);
  return value;
}
