// The window freeze of an exclusive data-directory operation (blind review coord #2): from beforeGo
// until the operation ended, the window that asked refuses every write command at its entry (the
// Facade and the command router), reads go on, background claims stay blocked, and only work from
// before the freeze counts as its work. Real ReliableKernelApplication, ReliableConversationRunner,
// command router and SQLite; the claim probe and the entry eligibility are wired like
// VscodeReliableKernelProductRuntime, whose freezeNewExecution is called as is.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const warnings = [];
class StubEventEmitter {
  listeners = new Set();
  event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
class StubUri {
  constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath; this.scheme = 'file'; this.authority = ''; }
  static file(fsPath) { return new StubUri(fsPath); }
  static joinPath(base, ...parts) { return new StubUri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.fsPath}`; }
}
const vscodeStub = {
  Uri: StubUri, EventEmitter: StubEventEmitter, ViewColumn: { One: 1 },
  workspace: { workspaceFolders: [], name: 'fixture' },
  window: {
    async showInformationMessage() {},
    async showWarningMessage(message) { warnings.push(message); },
    async showErrorMessage() {},
    registerWebviewPanelSerializer() { return { dispose() {} }; }
  }
};
Module._load = function load(request, parent, isMain) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiled = (relative) => path.join(process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension'), relative);
const load = (relative) => import(pathToFileURL(compiled(relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { emptyConversationContextHandleStateStep } = await load('backend/reliableKernel/conversationContextHandleState.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const {
  createDiagnosedConversationHostEligibility, evaluateConversationEntryEligibility, evaluateConversationHostEligibility,
  viewConversationHostEligibility
} = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { BridgeMessageType } = require(compiled('shared/protocol.js'));
const { VscodeReliableKernelProductRuntime: ProductRuntime, freezableClaimProbe } = require(compiled('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js'));
const { VscodeReliableKernelApplicationFacade: Facade } = require(compiled('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'));
const { VscodeReliableKernelCommandRouter } = require(compiled('backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js'));
const { RuntimeWriteGate } = require(compiled('backend/application/reliableKernel/runtimeWriteGate.js'));
const PROVIDER_ID = 'freeze-provider';
const REFUSED = '正在迁移数据目录，完成后再操作。';

test('冻结期间（beforeGo 到操作结束）本窗口在入口拒绝一切写命令并说明原因：新消息、重试、编辑后运行、压缩、审批、改名、删除都不写入，也不调用模型；查看照常；解冻后照常', { timeout: 120_000 }, async (t) => {
  const window = await openWindow(t);
  await createConversation(window.app, 'conversation-a');
  await createConversation(window.app, 'conversation-b');
  assert.equal(await window.facade.hasOwnedExecution(), false, 'idle before the freeze');
  const thaw = window.facade.freezeNewWork('迁移数据目录');
  warnings.length = 0;

  // New input is refused at the router's entry: the composer gets a rejection it keeps the text for.
  const posted = await window.send({
    type: BridgeMessageType.TurnStart,
    payload: { conversationId: 'conversation-a', command: { commandId: 'input-while-frozen', expectedVersion: 0, issuedAt: Date.now() }, text: '开始' }
  });
  const rejected = posted.find((message) => message.type === BridgeMessageType.TurnInputResult);
  assert.deepEqual({ status: rejected?.payload.status, admitted: rejected?.payload.admitted, message: rejected?.payload.message },
    { status: 'rejected', admitted: false, message: REFUSED });
  // Every other command that writes: refused with the same reason before anything is looked at.
  for (const type of [
    BridgeMessageType.MessageRetryFrom, BridgeMessageType.MessageEdit, BridgeMessageType.CompressionStart,
    BridgeMessageType.InteractionResolve, BridgeMessageType.MessageDeleteFrom, BridgeMessageType.TurnInterrupt,
    BridgeMessageType.ConversationSettingsUpdate, BridgeMessageType.GlobalSettingsUpdate, BridgeMessageType.ConversationCreate
  ]) {
    const answer = await window.send({ type, payload: { conversationId: 'conversation-a', command: { commandId: `${type}-frozen` } } });
    assert.ok(answer.some((message) => message.type === BridgeMessageType.Error && message.payload.requestType === type
      && message.payload.message === REFUSED), `${type}: ${JSON.stringify(answer)}`);
  }
  // The sidebar and panels call the Facade directly: refused there, and the reason is shown.
  await assert.rejects(window.facade.renameConversationTitle('conversation-b', '改个名字'), { message: REFUSED });
  await assert.rejects(window.facade.deleteConversation('conversation-b'), { message: REFUSED });
  await assert.rejects(window.facade.createConversation(), { message: REFUSED });
  assert.ok(warnings.length >= 13 && warnings.every((message) => message.endsWith(REFUSED)), JSON.stringify(warnings));
  assert.equal(window.provider.calls, 0, 'no model was called');
  assert.deepEqual(await rows(window.app, 'TurnIntent'), []);
  assert.equal((await rows(window.app, 'Conversation', { id: 'conversation-b' }))[0]?.title, 'conversation-b');
  assert.equal((await rows(window.app, 'Conversation')).length, 2);
  // Reads go on.
  const pong = await window.send({ type: BridgeMessageType.Ping, payload: { text: 'still here' } });
  assert.equal(pong.find((message) => message.type === BridgeMessageType.Pong)?.payload.text, 'still here');
  // Background claims of Conversations this window does not own stay blocked, and nothing became work.
  assert.equal(await window.app.database.conversationOwners.tryClaimEligible('conversation-b'), 'ineligible');
  assert.equal(await window.facade.hasOwnedExecution(), false);

  thaw();
  const accepted = await window.send({
    type: BridgeMessageType.TurnStart,
    payload: { conversationId: 'conversation-a', command: { commandId: 'input-after-thaw', expectedVersion: 0, issuedAt: Date.now() }, text: '开始' }
  });
  assert.equal(accepted.find((message) => message.type === BridgeMessageType.TurnInputResult)?.payload.admitted, true);
  await window.provider.started;
  assert.equal(await window.facade.hasOwnedExecution(), true, 'the Turn started after the thaw is work');
  window.provider.release();
  assert.equal(await window.facade.renameConversationTitle('conversation-b', '改个名字'), true);
});

test('冻结期间只看冻结前已有的工作：之前开始的 Turn 与仍在进行的写命令算忙；冻结后查看时的临时占用不算', { timeout: 120_000 }, async (t) => {
  const window = await openWindow(t);
  await createConversation(window.app, 'conversation-a');
  await createConversation(window.app, 'conversation-b');

  // A Turn started before the freeze keeps the window busy while frozen.
  const started = await window.send({
    type: BridgeMessageType.TurnStart,
    payload: { conversationId: 'conversation-a', command: { commandId: 'input-before', expectedVersion: 0, issuedAt: Date.now() }, text: '开始' }
  });
  const turnId = started.find((message) => message.type === BridgeMessageType.TurnInputResult)?.payload.turnId;
  await window.provider.started;
  const thawRunning = window.facade.freezeNewWork('迁移数据目录');
  assert.equal(await window.facade.hasOwnedExecution(), true, 'a Turn from before the freeze is work');
  window.provider.release();
  await eventually(async () => (await rows(window.app, 'Turn', { id: turnId }))[0]?.status === 'terminated', 60_000, 'Turn 未完成');
  await eventually(async () => !(await window.facade.hasOwnedExecution()), 30_000, 'Turn 结束后窗口仍忙');
  // Join the terminal drive's separate admission check before isolating the view's ownership.
  await window.runner.waitForIdle();
  // While frozen, a view that holds a Conversation for a moment is not work of this window.
  let busyWhileViewing;
  await window.app.database.conversationOwners.run('conversation-b', async () => {
    busyWhileViewing = await window.facade.hasOwnedExecution();
  });
  assert.equal(busyWhileViewing, false);
  thawRunning();
  // Not frozen, the same is work (a command in progress).
  let busyUnfrozen;
  await window.app.database.conversationOwners.run('conversation-b', async () => {
    busyUnfrozen = await window.facade.hasOwnedExecution();
  });
  assert.equal(busyUnfrozen, true);

  // A write command admitted before the freeze and still running: its effects cannot be told apart,
  // so the whole freeze counts as busy (beforeGo then thaws and goes back to waiting).
  let finishWrite;
  const write = window.facade.writeGate.run(() => new Promise((resolve) => { finishWrite = resolve; }));
  const thawWriting = window.facade.freezeNewWork('迁移数据目录');
  assert.equal(await window.facade.hasOwnedExecution(), true);
  finishWrite();
  await write;
  assert.equal(await window.facade.hasOwnedExecution(), true, 'still counted: it may have started work in any Conversation');
  thawWriting();
  assert.equal(await window.facade.hasOwnedExecution(), false);
  // Thawing twice is harmless.
  thawWriting();
  assert.equal(window.facade.writeGate.frozen, false);
});

test('最后一轮盲审 #5：冻结期间打开对话面板接管一个冻结前不属于本窗口的对话时只做控制类收尾，不认领执行（不续跑、不准入）；冻结前拥有的对话照常；解冻后照常', { timeout: 60_000 }, async (t) => {
  const window = await openWindow(t);
  await createConversation(window.app, 'conversation-a');
  await createConversation(window.app, 'conversation-b');
  const owners = window.app.database.conversationOwners;
  await owners.claim('conversation-a');
  const thaw = window.facade.freezeNewWork('迁移数据目录');
  // A view opened meanwhile: recoverServedConversation holds the Conversation (conversationOwners.run),
  // then its runner recovery asks to execute it (tryOwnConversation → tryClaimEligible).
  let viaView;
  let busyWhileViewing;
  await owners.run('conversation-b', async () => {
    viaView = await owners.tryClaimEligible('conversation-b');
    busyWhileViewing = await window.facade.hasOwnedExecution();
  });
  assert.equal(viaView, 'ineligible', 'owned by the view by then, but not before the freeze: nothing resumes here');
  assert.equal(busyWhileViewing, false);
  assert.equal(await owners.tryClaimEligible('conversation-b'), 'ineligible', 'nor in the background');
  assert.equal(await owners.tryClaimEligible('conversation-a'), 'owned', 'owned before the freeze: goes on');
  thaw();
  assert.equal(await owners.tryClaimEligible('conversation-b'), 'owned', 'thawed: as before');
});

/** One window: the Runtime, its Runner and command router, and the Facade's write gate, wired like the product. */
async function openWindow(t) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-write-freeze-'));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  const provider = gatedProvider();
  const app = await kernel.ReliableKernelApplication.open(new kernel.RootAuthority(() => candidate.binding.paths.dataRootPath), fixtureDependencies(provider));
  const runner = new ReliableConversationRunner(app, `freeze-window:${app.database.hostBootId}`, () => {}, undefined, undefined);
  const executionGate = { frozen: 0 };
  const owners = app.database.conversationOwners;
  const eligibility = createDiagnosedConversationHostEligibility(async (id) => evaluateConversationHostEligibility({
    database: app.database, contentStore: app.contentStore, workspaceFolderUris: () => [], workEnvironments: async () => []
  }, id));
  owners.setClaimEligibilityProbe(freezableClaimProbe(executionGate, owners, async (id) => (await eligibility(id)).eligible));
  runner.setEntryEligibility(async (id, options) => {
    try {
      return (await evaluateConversationEntryEligibility({
        database: app.database, contentStore: app.contentStore, workspaceFolderUris: () => [], workEnvironments: async () => [],
        nextTurnWorkEnvironment: (conversationId, next) => app.turns.previewNextTurnWorkEnvironment(conversationId, next?.executorAgentId)
      }, id, options)).eligible ? 'eligible' : 'ineligible';
    } catch { return 'unknown'; }
  });
  const product = {
    application: app,
    conversations: runner,
    childAgents: { async resume() { return false; } },
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    async ensureCapabilitiesReady() {},
    conversationHostEligibility: (conversationId) => viewConversationHostEligibility(eligibility, conversationId),
    freezeNewExecution: (owned) => ProductRuntime.prototype.freezeNewExecution.call({ executionGate }, owned)
  };
  const facade = Object.assign(Object.create(Facade.prototype), {
    product, writeGate: new RuntimeWriteGate(), historyEntries: [], refreshConversationHistory: async () => {}
  });
  const router = new VscodeReliableKernelCommandRouter(product, { writeGate: facade.writeGate });
  let next = 0;
  t.after(async () => {
    provider.release();
    runner.dispose();
    await app.beginHandoff().catch(() => undefined);
    await runner.waitForIdle().catch(() => undefined);
    await app.close();
    await fs.rm(outer, { recursive: true, force: true });
  });
  return {
    app, runner, provider, facade, router,
    /** Sends one Webview command through the router's entry and returns what was posted back. */
    async send(message) {
      const id = `freeze-${next += 1}`;
      const posted = [];
      let answered;
      const done = new Promise((resolve) => { answered = resolve; });
      const webview = { async postMessage(value) { posted.push(value); if (value.correlationId === id) answered(); return true; } };
      router.handle('freeze-client', webview, { id, channel: 'command', ...message });
      await Promise.race([done, sleep(3_000)]);
      await sleep(20);
      return posted;
    }
  };
}

async function createConversation(app, conversationId) {
  const now = new Date().toISOString();
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now }),
    emptyConversationContextHandleStateStep(conversationId, now),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now
    })
  ]);
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
      markStarted();
      await new Promise((resolve, reject) => {
        const signal = controls.signal;
        const onAbort = () => reject(signal.reason ?? new Error('aborted'));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        void gate.then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: '完成' }] } });
    }
  };
}

function fixtureDependencies(provider) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'freeze-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: { providerConfigId: provider.providerId, provider: 'fixture', modelId: 'freeze-model', retryPolicy: { enabled: false, maxRetries: 0 } },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: { id: 'freeze-tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
              planReviewPolicy: { mode: 'optional' },
              systemPrompt: { id: 'freeze-prompt', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
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
        host: { definitions() { return []; }, async cancelTurnWaits() {}, async dispose() {} }
      })
  };
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 1_000
  }))).snapshot;
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
