import { createOwnershipScope } from './ownership-scope-fixture.mjs';
// Focused production ownership boundary; old review matrices are absent.
import assert from 'node:assert/strict';

import childProcess from 'node:child_process';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();

const kernel = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/index.js')
).href);

const { emptyConversationContextHandleStateStep } = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/conversationContextHandleState.js')
).href);

const { ReliableConversationRunner } = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/application/reliableKernel/ReliableConversationRunner.js')
).href);

const ownerModule = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/ConversationRuntimeOwnerManager.js')
).href);

const hostControl = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/runtimeHostControl.js')
).href);

const claimPrimitives = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/runtimeClaimPrimitives.js')
).href);

const { RELIABLE_KERNEL_SNAPSHOT_MESSAGE } = await import(pathToFileURL(
  path.join(root, 'dist/extension/shared/reliableKernelClientFeed.js')
).href);

const {
  ConversationRuntimeOwnerManager,
  conversationRuntimeOwnerClaimPath,
  isConversationRuntimeOwnerReleasedError
} = ownerModule;

const { withRuntimeMaintenance, assertRuntimeHostsOffline } = hostControl;

const OWNER_BUSY_CODE = 'conversation-runtime-owner-busy';

const OWNER_INVALID_CODE = 'conversation-runtime-owner-invalid';

const OWNER_MISMATCH_CODE = 'conversation-runtime-owner-mismatch';

const HOSTS_ACTIVE_CODE = 'runtime-hosts-active';

const PROVIDER_ID = 'owner-proof-provider';

const PAST = '2020-01-01T00:00:00.000Z';

const TEST_FILE = fileURLToPath(import.meta.url);

const workerMode = process.env.LIMCODE_OWNER_WORKER;

async function runWorker(mode) {
  if (mode === 'host-holder') return runHostHolder();
  if (mode === 'claimer') return runClaimer();
  if (mode === 'turn-driver') return runTurnDriver();
  if (mode === 'input-attempt') return runInputAttempt();
  if (mode === 'maintenance-holder') return runMaintenanceHolder();
  if (mode === 'admission-holder') return runAdmissionHolder();
  if (mode === 'scoped-opener') return runScopedOpener();
  throw new Error(`Unknown worker mode: ${mode}`);
}

async function runHostHolder() {
  const hostBootId = requiredEnv('LIMCODE_OWNER_HOST');
  const database = await openWorkerDatabase(hostBootId);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await database.close().catch(() => undefined);
  };
  const claim = process.env.LIMCODE_OWNER_CLAIM;
  let ownerToken;
  if (claim) {
    await database.conversationOwners.claim(claim);
    ownerToken = (await readOwnerRecord(database.binding.paths, claim))?.ownerToken;
  }
  await writeJson(requiredEnv('LIMCODE_OWNER_READY'), { pid: process.pid, hostBootId, ownerToken });
  const gate = process.env.LIMCODE_OWNER_GATE;
  if (gate) {
    await waitForFile(gate, 300_000);
    await close();
    return;
  }
  // 无 gate 的持有者只靠信号退出：SIGTERM 优雅关闭（释放记录），SIGKILL 留下全部痕迹。
  await new Promise((resolve) => {
    process.once('SIGTERM', () => { void close().then(resolve); });
  });
}

async function runClaimer() {
  const hostBootId = requiredEnv('LIMCODE_OWNER_HOST');
  const conversationId = requiredEnv('LIMCODE_OWNER_CLAIM');
  const claimMode = process.env.LIMCODE_OWNER_MODE === 'try' ? 'try' : 'claim';
  const readyPath = process.env.LIMCODE_OWNER_READY;
  const goPath = process.env.LIMCODE_OWNER_GO;
  const holdPath = process.env.LIMCODE_OWNER_HOLD;
  const database = await openWorkerDatabase(hostBootId);
  try {
    if (readyPath) await writeJson(readyPath, { pid: process.pid, hostBootId });
    if (goPath) await waitForFile(goPath, 300_000);
    let result;
    try {
      if (claimMode === 'try') {
        const acquired = await database.conversationOwners.tryClaim(conversationId);
        result = acquired
          ? { outcome: 'claimed', hostBootId }
          : { outcome: 'busy', hostBootId, via: 'try-false' };
      } else {
        await database.conversationOwners.claim(conversationId);
        result = { outcome: 'claimed', hostBootId };
      }
    } catch (error) {
      result = {
        outcome: error?.code === OWNER_BUSY_CODE ? 'busy' : 'error',
        hostBootId,
        code: error?.code ?? null,
        conversationId: error?.conversationId ?? null,
        ownerHostBootId: error?.owner?.hostBootId ?? null,
        ownerProcessId: error?.owner?.processId ?? null,
        message: String(error?.message ?? error)
      };
    }
    await writeJson(requiredEnv('LIMCODE_OWNER_RESULT'), result);
    // 可选保持期：父进程先核验持久化所有权记录，再放行本进程释放。
    if (holdPath) await waitForFile(holdPath, 300_000);
  } finally {
    await database.close().catch(() => undefined);
  }
}

async function runTurnDriver() {
  const conversationId = requiredEnv('LIMCODE_OWNER_CONVERSATION');
  const marker = requiredEnv('LIMCODE_OWNER_MARKER');
  const startedPath = requiredEnv('LIMCODE_OWNER_STARTED');
  const gatePath = requiredEnv('LIMCODE_OWNER_GATE');
  let providerCalls = 0;
  const runnerErrors = [];
  const provider = {
    providerId: PROVIDER_ID,
    async sendFullRequest(_request, controls) {
      providerCalls += 1;
      await fs.writeFile(startedPath, `${process.pid}\n`, 'utf8');
      await waitForFile(gatePath, 300_000);
      await controls.onEvent({
        kind: 'completed',
        streamSeq: '1',
        content: { role: 'model', parts: [{ text: `${marker}正文` }] }
      });
    }
  };
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => requiredEnv('LIMCODE_OWNER_DATA_ROOT')),
    ownerProofDependencies(provider)
  );
  const runner = new ReliableConversationRunner(
    app,
    `owner-proof-driver:${app.database.hostBootId}`,
    (error, context) => runnerErrors.push({ error: String(error?.stack ?? error), context })
  );
  try {
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now
      }),
      emptyConversationContextHandleStateStep(conversationId, now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main',
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    const started = await runner.input({
      commandId: `input-${conversationId}`,
      conversationId,
      text: '请等待放行信号后回答。'
    });
    await waitForFile(startedPath, 60_000);
    const ownsWhileActive = app.database.conversationOwners.owns(conversationId);
    const idleReleaseWhileActive = await app.database.conversationOwners.releaseIfIdle(conversationId);
    await eventually(async () => (await listRows(app, 'Turn', { id: started.turnId }))[0]?.status === 'terminated',
      120_000, `Turn ${started.turnId} 未在放行后终结`);
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, {
        title: marker, updated_at: new Date().toISOString()
      })
    ]);
    await writeJson(requiredEnv('LIMCODE_OWNER_RESULT'), {
      turnId: started.turnId,
      ownsWhileActive,
      idleReleaseWhileActive,
      providerCalls,
      terminalStatus: (await listRows(app, 'Turn', { id: started.turnId }))[0]?.status ?? null,
      runnerErrors
    });
  } finally {
    runner.dispose();
    await app.close().catch(() => undefined);
  }
}

async function runInputAttempt() {
  const target = requiredEnv('LIMCODE_OWNER_TARGET');
  let providerCalls = 0;
  const provider = {
    providerId: PROVIDER_ID,
    async sendFullRequest() {
      providerCalls += 1;
      throw new Error('异主会话绝不可派发 Provider。');
    }
  };
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => requiredEnv('LIMCODE_OWNER_DATA_ROOT')),
    ownerProofDependencies(provider)
  );
  const runner = new ReliableConversationRunner(app, `owner-proof-attempt:${app.database.hostBootId}`);
  try {
    let result;
    try {
      await runner.input({ commandId: `foreign-input-${target}`, conversationId: target, text: '不应被接纳。' });
      result = { outcome: 'admitted' };
    } catch (error) {
      result = {
        outcome: error?.code === OWNER_BUSY_CODE ? 'rejected' : 'error',
        code: error?.code ?? null,
        conversationId: error?.conversationId ?? null,
        message: String(error?.message ?? error)
      };
    }
    result.providerCalls = providerCalls;
    await writeJson(requiredEnv('LIMCODE_OWNER_RESULT'), result);
  } finally {
    runner.dispose();
    await app.close().catch(() => undefined);
  }
}

async function runMaintenanceHolder() {
  const authority = new kernel.RootAuthority(() => requiredEnv('LIMCODE_OWNER_DATA_ROOT'));
  const binding = await authority.current();
  const claimPath = hostControl.runtimeMaintenanceClaimPath(binding.paths);
  let result;
  try {
    await withRuntimeMaintenance(binding.paths, async () => {
      let claimToken = null;
      try {
        claimToken = JSON.parse(await fs.readFile(path.join(claimPath, 'owner.json'), 'utf8'))?.claimToken ?? null;
      } catch { /* 记录不可得时仍上报 pid */ }
      await writeJson(requiredEnv('LIMCODE_OWNER_READY'), { pid: process.pid, claimToken });
      if (process.env.LIMCODE_OWNER_GATE) await waitForFile(process.env.LIMCODE_OWNER_GATE, 300_000);
      if (process.env.LIMCODE_OWNER_FINISHED) {
        await fs.writeFile(process.env.LIMCODE_OWNER_FINISHED, 'done\n', 'utf8');
      }
    });
    result = { outcome: 'completed' };
  } catch (error) {
    result = { outcome: 'error', code: error?.code ?? null, message: String(error?.message ?? error) };
  }
  await writeJson(requiredEnv('LIMCODE_OWNER_RESULT'), result);
}

async function runAdmissionHolder() {
  const configurationRoot = requiredEnv('LIMCODE_OWNER_CONFIG_ROOT');
  const claimPath = hostControl.runtimeDataRootAdmissionClaimPath(configurationRoot);
  let result;
  try {
    await hostControl.withRuntimeDataRootAdmission(configurationRoot, async () => {
      let claimToken = null;
      try {
        claimToken = JSON.parse(await fs.readFile(path.join(claimPath, 'owner.json'), 'utf8'))?.claimToken ?? null;
      } catch { /* 记录不可得时仍上报 pid */ }
      await writeJson(requiredEnv('LIMCODE_OWNER_READY'), { pid: process.pid, claimToken });
      if (process.env.LIMCODE_OWNER_GATE) await waitForFile(process.env.LIMCODE_OWNER_GATE, 300_000);
      if (process.env.LIMCODE_OWNER_FINISHED) {
        await fs.writeFile(process.env.LIMCODE_OWNER_FINISHED, 'done\n', 'utf8');
      }
    });
    result = { outcome: 'completed' };
  } catch (error) {
    result = { outcome: 'error', code: error?.code ?? null, message: String(error?.message ?? error) };
  }
  await writeJson(requiredEnv('LIMCODE_OWNER_RESULT'), result);
}

async function runScopedOpener() {
  const configurationRoot = requiredEnv('LIMCODE_OWNER_CONFIG_ROOT');
  const hostBootId = requiredEnv('LIMCODE_OWNER_HOST');
  const authority = new kernel.RootAuthority(
    () => requiredEnv('LIMCODE_OWNER_DATA_ROOT'),
    undefined,
    () => configurationRoot
  );
  if (process.env.LIMCODE_OWNER_ATTEMPTING) {
    await fs.writeFile(process.env.LIMCODE_OWNER_ATTEMPTING, `${process.pid}\n`, 'utf8');
  }
  let result;
  try {
    const database = await kernel.RuntimeDatabase.open(authority, { hostBootId });
    try {
      let finishedVisibleAtOpen = false;
      if (process.env.LIMCODE_OWNER_FINISHED) {
        finishedVisibleAtOpen = await fs.access(process.env.LIMCODE_OWNER_FINISHED)
          .then(() => true, () => false);
      }
      result = { outcome: 'opened', hostBootId, finishedVisibleAtOpen };
    } finally {
      await database.close().catch(() => undefined);
    }
  } catch (error) {
    result = { outcome: 'error', code: error?.code ?? null, message: String(error?.message ?? error) };
  }
  await writeJson(requiredEnv('LIMCODE_OWNER_RESULT'), result);
}

function ownerProofDependencies(provider) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'owner-proof-model' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: provider.providerId,
                provider: 'fixture',
                modelId: 'owner-proof-model',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'owner-proof-tools',
                allowedTools: [],
                preset: 'custom',
                toolConfigs: {},
                sourceConfigs: {}
              },
              systemPrompt: { id: 'owner-proof-prompt', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: {
                id: null,
                enabled: false,
                allowedWorkEnvironmentIds: [],
                defaultWorkEnvironmentId: null
              }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      async callTool() { return null; }
    },
    mcpPolicyGate: {
      async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
    },
    attachmentSettings: {
      async loadGlobalSettings() {
        return {
          section: 'attachments',
          settings: { maxStoredInlineFileMb: 25 },
          filePath: 'settings/attachments.json'
        };
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
        database,
        contentStore,
        effects: runtime.effects,
        files,
        fileMutations,
        processes,
        mcp,
        interactions,
        host: {
          definitions() { return []; },
          async cancelTurnWaits() {},
          async dispose() {}
        }
      })
  };
}

async function createIsolatedRoot(label) {
  return createOwnershipScope(label);
}

async function openWorkerDatabase(hostBootId) {
  const authority = new kernel.RootAuthority(() => requiredEnv('LIMCODE_OWNER_DATA_ROOT'));
  return kernel.RuntimeDatabase.open(authority, { hostBootId });
}

async function readOwnerRecord(paths, conversationId) {
  const claimPath = conversationRuntimeOwnerClaimPath(paths, conversationId);
  return JSON.parse(await fs.readFile(path.join(claimPath, 'owner.json'), 'utf8'));
}

async function listRows(appOrDatabase, domain, where = {}) {
  const database = appOrDatabase.database ?? appOrDatabase;
  return (await database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
}

async function countRows(app, domain) {
  return (await listRows(app, domain)).length;
}

async function snapshotModelStreamState(app) {
  return {
    requests: await listRows(app, 'ModelRequest'),
    fences: await listRows(app, 'ModelStreamFence'),
    checkpoints: await listRows(app, 'ModelStreamCheckpoint')
  };
}

function spawnTracked(children, mode, dataRoot, environment) {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...environment,
      LIMCODE_OWNER_WORKER: mode,
      LIMCODE_OWNER_DATA_ROOT: dataRoot
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  children.push(child);
  return child;
}

function waitForExit(child, timeoutMs, rejectNonZero = false) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const settle = (code, signal) => {
      if (rejectNonZero && code !== 0) {
        reject(new Error(`ownership worker failed (code=${code}, signal=${signal})\n${stdout}\n${stderr}`));
      } else {
        resolve({ code, signal, stdout, stderr });
      }
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      settle(child.exitCode, child.signalCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ownership worker timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      settle(code, signal);
    });
  });
}

async function cleanupChildren(children) {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child, 15_000).catch(() => undefined);
  }
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await sleep(20);
  }
}

async function waitForJson(filePath, timeoutMs) {
  await waitForFile(filePath, timeoutMs);
  return readJson(filePath);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
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

if (workerMode) runWorker(workerMode).then(() => process.exit(0), error => { console.error(error?.stack ?? error); process.exit(1); });

export const scenario2 = async () => {
  const { outer, binding } = await createIsolatedRoot('stale-callback');
  let app;
  let runner;
  try {
    const conversationId = 'conversation-stale-callback';
    const providerErrors = [];
    const runnerErrors = [];
    let resolveGate;
    const gate = new Promise((resolve) => { resolveGate = resolve; });
    let markStarted;
    const providerStarted = new Promise((resolve) => { markStarted = resolve; });
    let providerReturned = false;
    const provider = {
      providerId: PROVIDER_ID,
      async sendFullRequest(_request, controls) {
        markStarted();
        await gate;
        try {
          // Both ordinary deltas and a late completion must retain the stale-authority
          // contract, even though local checkpoint retry sees an already-aborted signal first.
          for (const event of [
            { kind: 'output_delta', streamSeq: '1', content: { text: '陈旧增量不应提交' } },
            { kind: 'completed', streamSeq: '2', content: { role: 'model', parts: [{ text: '陈旧回调不应提交' }] } }
          ]) {
            try { await controls.onEvent(event); }
            catch (error) { providerErrors.push(error); }
          }
        } finally {
          providerReturned = true;
        }
      }
    };

    const authority = new kernel.RootAuthority(() => binding.paths.dataRootPath);
    app = await kernel.ReliableKernelApplication.open(authority, ownerProofDependencies(provider));
    runner = new ReliableConversationRunner(
      app,
      `stale-callback-runner:${app.database.hostBootId}`,
      (error) => runnerErrors.push(error)
    );
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now
      }),
      emptyConversationContextHandleStateStep(conversationId, now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main',
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    const started = await runner.input({
      commandId: 'stale-callback-input',
      conversationId,
      text: '先等待，再被中断。'
    });
    await providerStarted;
    await eventually(async () => (await listRows(app, 'ExecutionLease', { turn_id: started.turnId })).length === 1,
      30_000, 'Turn 未建立 ExecutionLease');

    await runner.interrupt({
      commandId: 'stale-callback-interrupt',
      conversationId,
      turnId: started.turnId,
      reason: 'test_stale_callback_fence'
    });
    await eventually(async () => (await listRows(app, 'Turn', { id: started.turnId }))[0]?.status === 'terminated',
      30_000, 'Turn 未被中断终结');
    await eventually(async () => (await listRows(app, 'ExecutionLease', { turn_id: started.turnId })).length === 0,
      30_000, '终结后 ExecutionLease 未清除');
    await eventually(() => !app.database.conversationOwners.owns(conversationId),
      30_000, '终结后 Conversation 所有权未被空闲释放');

    const messagesBefore = await countRows(app, 'Message');
    const revisionsBefore = await countRows(app, 'MessageRevision');
    const modelStateBefore = await snapshotModelStreamState(app);
    resolveGate();
    await eventually(() => providerReturned, 30_000, 'Provider 未完成陈旧回调尝试');
    // 陈旧回调可能在触达写入前被直接忽略；无论走哪条路，任何浮出的错误都必须是 handoff 家族。
    for (const error of [...providerErrors, ...runnerErrors]) {
      assert.equal(kernel.isExecutionHandoffError(error), true,
        `陈旧回调路径不得产生非 handoff 家族错误: ${error?.stack ?? error}`);
    }
    assert.equal(await countRows(app, 'Message'), messagesBefore, '陈旧回调不得新增 Message');
    assert.equal(await countRows(app, 'MessageRevision'), revisionsBefore, '陈旧回调不得新增 MessageRevision');
    assert.deepEqual(await snapshotModelStreamState(app), modelStateBefore,
      '被忽略的陈旧回调不得改动 ModelRequest/ModelStreamFence/ModelStreamCheckpoint 状态');
    assert.equal((await listRows(app, 'Turn', { id: started.turnId }))[0]?.status, 'terminated');
    assert.equal((await listRows(app, 'TurnTermination', { turn_id: started.turnId }))[0]?.terminal_status, 'interrupted');
    assert.equal((await listRows(app, 'ExecutionLease', { turn_id: started.turnId })).length, 0);

    await assert.rejects(
      kernel.runWithExecutionLeaseFence({
        id: 'stale-callback-lease',
        conversationId,
        turnId: started.turnId,
        ownerId: 'stale-owner',
        hostBootId: 'stale-host',
        generation: 1n
      }, () => app.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, {
          title: '陈旧写入不应提交', updated_at: new Date().toISOString()
        })
      ])),
      (error) => isConversationRuntimeOwnerReleasedError(error),
      '本地释放后的栅栏写入必须抛出 ConversationRuntimeOwnerReleasedError'
    );
    assert.equal((await listRows(app, 'Conversation', { id: conversationId }))[0]?.title, conversationId,
      '本地释放后的栅栏写入绝不可提交');

    const freshId = 'conversation-fence-cas';
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: freshId, title: freshId, status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: `${freshId}-turn`, conversation_id: freshId, status: 'terminated',
        created_at: now, updated_at: now, terminal_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: `${freshId}-lease`, conversation_id: freshId, turn_id: `${freshId}-turn`,
        owner_id: 'moved-owner', host_boot_id: 'moved-host', generation: 5n,
        acquired_at: now, expires_at: PAST
      })
    ]);
    // 只有当前持有者才会走到租约代际 CAS；未持有会话的栅栏写入会先被所有权栅栏拒绝。
    await app.database.conversationOwners.claim(freshId);
    await assert.rejects(
      kernel.runWithExecutionLeaseFence({
        id: `${freshId}-lease`,
        conversationId: freshId,
        turnId: `${freshId}-turn`,
        ownerId: 'moved-owner',
        hostBootId: 'moved-host',
        generation: 4n
      }, () => app.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').update(freshId, {
          title: '旧代际写入不应提交', updated_at: new Date().toISOString()
        })
      ])),
      (error) => kernel.isExecutionHandoffError(error) && !isConversationRuntimeOwnerReleasedError(error),
      '旧代际写入必须被 ExecutionLease 代际 CAS 拒绝'
    );
    assert.equal((await listRows(app, 'Conversation', { id: freshId }))[0]?.title, freshId,
      '旧代际 CAS 写入绝不可提交');
  } finally {
    runner?.dispose();
    if (app) await app.close().catch(() => undefined);
    await fs.rm(outer, { recursive: true, force: true });
  }
};
