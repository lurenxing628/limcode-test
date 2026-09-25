import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();
const kernel = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/index.js')
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
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

test('多宿主在同一数据集并行推进不同 Conversation，外部提交经有界 Client Feed 对端可见（跨进程运行时证明）', {
  timeout: 240_000
}, async () => {
  const children = [];
  const { outer, binding } = await createIsolatedRoot('parallel');
  const dataRoot = binding.paths.dataRootPath;
  let observer;
  let feed;
  let feedConnection;
  try {
    const conversationA = 'conversation-parallel-a';
    const conversationB = 'conversation-parallel-b';
    const markerA = '宿主甲完成标记';
    const markerB = '宿主乙完成标记';
    const driverA = spawnTracked(children, 'turn-driver', dataRoot, {
      LIMCODE_OWNER_CONVERSATION: conversationA,
      LIMCODE_OWNER_MARKER: markerA,
      LIMCODE_OWNER_STARTED: path.join(outer, 'a-started'),
      LIMCODE_OWNER_GATE: path.join(outer, 'a-gate'),
      LIMCODE_OWNER_RESULT: path.join(outer, 'a-result.json')
    });
    await waitForFile(path.join(outer, 'a-started'), 60_000);
    const driverB = spawnTracked(children, 'turn-driver', dataRoot, {
      LIMCODE_OWNER_CONVERSATION: conversationB,
      LIMCODE_OWNER_MARKER: markerB,
      LIMCODE_OWNER_STARTED: path.join(outer, 'b-started'),
      LIMCODE_OWNER_GATE: path.join(outer, 'b-gate'),
      LIMCODE_OWNER_RESULT: path.join(outer, 'b-result.json')
    });
    await waitForFile(path.join(outer, 'b-started'), 60_000);

    observer = await openObserverDatabase(binding, 'observer-parallel');
    await eventually(async () => (await listRows(observer, 'Turn', { conversation_id: conversationA }))[0]?.status === 'active',
      30_000, '宿主甲的 Turn 未进入活动状态');
    await eventually(async () => (await listRows(observer, 'Turn', { conversation_id: conversationB }))[0]?.status === 'active',
      30_000, '宿主乙的 Turn 未进入活动状态');

    const received = [];
    const feedFailures = [];
    feed = new kernel.BoundedClientFeed(observer);
    feedConnection = await feed.connect({
      activeConversationId: conversationA,
      send(message) {
        received.push(message);
        setImmediate(() => {
          try {
            feed.acknowledge({
              sessionId: message.sessionId,
              hostBootId: message.hostBootId,
              messageSeq: message.messageSeq
            });
          } catch (error) {
            feedFailures.push(error);
          }
        });
      },
      onFailure(error) { feedFailures.push(error); }
    });
    await eventually(() => received.length >= 1, 15_000, 'Client Feed 初始快照未到达');
    assert.equal(received.some((message) => JSON.stringify(message).includes(markerA)), false,
      '初始快照不得包含宿主甲之后才写入的标记');

    const versionBefore = await observer.externalDataVersion();
    await fs.writeFile(path.join(outer, 'a-gate'), 'release\n', 'utf8');
    await waitForExit(driverA, 120_000, true);
    const resultA = await readJson(path.join(outer, 'a-result.json'));
    assert.equal(resultA.providerCalls, 1);
    assert.equal(resultA.ownsWhileActive, true, '活动 Turn 期间本宿主必须持有 Conversation 所有权');
    assert.equal(resultA.idleReleaseWhileActive, false, '活动 Turn 期间空闲释放必须被 pending-work 探针拒绝');
    assert.equal(resultA.terminalStatus, 'terminated');
    assert.deepEqual(resultA.runnerErrors, []);

    await eventually(() => received.some((message) => JSON.stringify(message).includes(markerA)),
      30_000, '外部宿主的提交未经有界 Client Feed 刷新到本宿主');
    assert.ok(received.some((message) => message.type === RELIABLE_KERNEL_SNAPSHOT_MESSAGE
      && JSON.stringify(message).includes(markerA)), '外部提交必须触发一次有界快照刷新');
    const versionAfter = await observer.externalDataVersion();
    assert.notEqual(versionAfter, versionBefore, '外部 SQLite 写入必须推进 externalDataVersion');
    assert.equal((await listRows(observer, 'Conversation', { id: conversationA }))[0]?.title, markerA,
      '外部宿主的 Conversation 写入必须对本宿主持久可见');
    assert.equal((await listRows(observer, 'Turn', { conversation_id: conversationA }))[0]?.status, 'terminated');

    await fs.writeFile(path.join(outer, 'b-gate'), 'release\n', 'utf8');
    await waitForExit(driverB, 120_000, true);
    const resultB = await readJson(path.join(outer, 'b-result.json'));
    assert.equal(resultB.providerCalls, 1);
    assert.equal(resultB.ownsWhileActive, true);
    assert.equal(resultB.idleReleaseWhileActive, false);
    assert.equal(resultB.terminalStatus, 'terminated');
    assert.deepEqual(resultB.runnerErrors, []);
    assert.equal((await listRows(observer, 'Turn', { conversation_id: conversationB }))[0]?.status, 'terminated');
    assert.equal((await listRows(observer, 'Conversation', { id: conversationB }))[0]?.title, markerB);
    assert.deepEqual(feedFailures, []);

    feed.disconnect(feedConnection.sessionId);
    feedConnection = undefined;
  } finally {
    if (feed && feedConnection) feed.disconnect(feedConnection.sessionId);
    if (observer) await observer.close().catch(() => undefined);
    await cleanupChildren(children);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('被动宿主可持久请求中断活宿主的 Turn，不能执行其它越权写入，收尾后自动让出', {
  timeout: 180_000
}, async () => {
  const children = [];
  const { outer, binding } = await createIsolatedRoot('remote-interrupt');
  const conversationId = 'conversation-remote-interrupt';
  const gatePath = path.join(outer, 'provider-gate');
  let observer;
  let runner;
  try {
    const driver = spawnTracked(children, 'turn-driver', binding.paths.dataRootPath, {
      LIMCODE_OWNER_CONVERSATION: conversationId,
      LIMCODE_OWNER_MARKER: '远端中断',
      LIMCODE_OWNER_STARTED: path.join(outer, 'provider-started'),
      LIMCODE_OWNER_GATE: gatePath,
      LIMCODE_OWNER_RESULT: path.join(outer, 'driver-result.json')
    });
    await waitForFile(path.join(outer, 'provider-started'), 60_000);
    observer = await kernel.ReliableKernelApplication.open(
      new kernel.RootAuthority(() => binding.paths.dataRootPath),
      ownerProofDependencies({ providerId: PROVIDER_ID, async sendFullRequest() {
        assert.fail('被动宿主不得派发 Provider');
      } })
    );
    runner = new ReliableConversationRunner(observer, `remote-interrupt:${observer.database.hostBootId}`);
    const [turn] = await listRows(observer, 'Turn', { conversation_id: conversationId });
    const [lease] = await listRows(observer, 'ExecutionLease', { turn_id: turn.id });
    assert.equal(turn.status, 'active');
    assert.equal(await observer.database.conversationOwners.tryClaim(conversationId), false,
      '活宿主仍是唯一 writer');
    await assert.rejects(observer.turns.interrupt({
      source: { kind: 'command', key: 'foreign-ordinary-interrupt' },
      turnId: turn.id, reason: '普通控制面仍必须有 owner'
    }), { code: OWNER_BUSY_CODE });
    await assert.rejects(runner.interrupt({
      commandId: 'wrong-lease-generation', conversationId, turnId: turn.id,
      expectedLeaseGeneration: String(BigInt(lease.generation) + 1n), reason: '不得误中断'
    }), /generation was replaced/);
    assert.equal((await listRows(observer, 'PendingTurnInput', { turn_id: turn.id })).length, 0);
    await assert.rejects(observer.turns.requestExternalInterrupt('unrelated-conversation', {
      source: { kind: 'command', key: 'wrong-conversation' }, turnId: turn.id, reason: '不得串会话'
    }), /does not belong/);

    const requested = await runner.interrupt({
      commandId: 'remote-stop', conversationId, turnId: turn.id,
      expectedLeaseGeneration: String(lease.generation), reason: '从另一窗口停止'
    });
    assert.ok(requested.pendingTurnInputId, '远端只提交持久中断请求');
    assert.equal(observer.database.conversationOwners.owns(conversationId), false,
      '提交请求不取得另一个宿主的 writer owner');
    assert.equal((await listRows(observer, 'PendingTurnInput', { turn_id: turn.id })).length, 1);
    await eventually(async () => (await listRows(observer, 'TurnTermination', { turn_id: turn.id }))[0]?.terminal_status === 'interrupted',
      30_000, '活宿主未观察到持久中断并完成终态');
    const duplicate = await runner.interrupt({
      commandId: 'remote-stop', conversationId, turnId: turn.id,
      expectedLeaseGeneration: String(lease.generation), reason: '相同命令重试'
    });
    assert.equal(duplicate.deduplicated, true, '重复请求只回放同一 receipt');
    assert.equal((await listRows(observer, 'PendingTurnInput', { turn_id: turn.id })).length, 1);

    await fs.writeFile(gatePath, 'release\n', 'utf8');
    await waitForExit(driver, 120_000, true);
    assert.equal(await observer.database.conversationOwners.tryClaim(conversationId), true,
      '宿主收尾退出后另一个窗口无需关闭面板即可接管');
    assert.equal(await observer.database.conversationOwners.releaseIfIdle(conversationId), true);
  } finally {
    await fs.writeFile(gatePath, 'release\n', 'utf8').catch(() => undefined);
    runner?.dispose();
    if (observer) await observer.close().catch(() => undefined);
    await cleanupChildren(children);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('同一 Conversation 的跨进程并发 claim 只有一个胜者，同宿主并发 claim 单飞（所有权管理器作用域）', {
  timeout: 120_000
}, async () => {
  const children = [];
  const { outer, binding } = await createIsolatedRoot('race');
  const dataRoot = binding.paths.dataRootPath;
  try {
    const singleFlight = 'conversation-single-flight';
    const manager = new ConversationRuntimeOwnerManager(binding, 'single-flight-host');
    manager.setPendingWorkProbe(async () => false);
    const peerManager = new ConversationRuntimeOwnerManager(binding, 'single-flight-peer');
    peerManager.setPendingWorkProbe(async () => false);
    try {
      await Promise.all([manager.claim(singleFlight), manager.claim(singleFlight), manager.tryClaim(singleFlight)]);
      assert.equal(manager.owns(singleFlight), true, '同宿主并发 claim 必须单飞共享同一次获取');
      assert.equal(await peerManager.tryClaim(singleFlight), false,
        '另一存活宿主管理器只能看到忙碌');
      await assert.rejects(peerManager.claim(singleFlight),
        (error) => error?.code === OWNER_BUSY_CODE
          && error?.conversationId === singleFlight
          && error?.owner?.hostBootId === 'single-flight-host');
      assert.equal(await manager.releaseIfIdle(singleFlight), true);
      assert.equal(manager.owns(singleFlight), false);
      assert.equal(await peerManager.tryClaim(singleFlight), true, '释放后另一宿主必须可以认领');
      assert.equal(await peerManager.releaseIfIdle(singleFlight), true);
    } finally {
      await manager.close();
      await peerManager.close();
    }

    const raced = 'conversation-raced';
    const goPath = path.join(outer, 'go');
    const holdA = path.join(outer, 'race-a-hold');
    const holdB = path.join(outer, 'race-b-hold');
    const claimerA = spawnTracked(children, 'claimer', dataRoot, {
      LIMCODE_OWNER_HOST: 'race-host-a',
      LIMCODE_OWNER_CLAIM: raced,
      LIMCODE_OWNER_MODE: 'claim',
      LIMCODE_OWNER_READY: path.join(outer, 'race-a-ready'),
      LIMCODE_OWNER_GO: goPath,
      LIMCODE_OWNER_HOLD: holdA,
      LIMCODE_OWNER_RESULT: path.join(outer, 'race-a-result.json')
    });
    const claimerB = spawnTracked(children, 'claimer', dataRoot, {
      LIMCODE_OWNER_HOST: 'race-host-b',
      LIMCODE_OWNER_CLAIM: raced,
      LIMCODE_OWNER_MODE: 'claim',
      LIMCODE_OWNER_READY: path.join(outer, 'race-b-ready'),
      LIMCODE_OWNER_GO: goPath,
      LIMCODE_OWNER_HOLD: holdB,
      LIMCODE_OWNER_RESULT: path.join(outer, 'race-b-result.json')
    });
    await waitForFile(path.join(outer, 'race-a-ready'), 60_000);
    await waitForFile(path.join(outer, 'race-b-ready'), 60_000);
    await fs.writeFile(goPath, 'go\n', 'utf8');
    const results = await Promise.all([
      waitForJson(path.join(outer, 'race-a-result.json'), 60_000),
      waitForJson(path.join(outer, 'race-b-result.json'), 60_000)
    ]);
    const winners = results.filter((result) => result.outcome === 'claimed');
    const losers = results.filter((result) => result.outcome === 'busy');
    assert.equal(winners.length, 1, '跨进程并发 claim 必须恰好一个胜者');
    assert.equal(losers.length, 1);
    assert.equal(losers[0].code, OWNER_BUSY_CODE);
    assert.equal(losers[0].conversationId, raced);
    assert.equal(losers[0].ownerHostBootId, winners[0].hostBootId, '败者必须看到胜者的宿主身份');
    assert.equal(typeof losers[0].ownerProcessId, 'number');
    assert.ok(losers[0].message.includes(raced), '占用错误信息必须指名被占用的会话');
    const record = await readOwnerRecord(binding.paths, raced);
    assert.equal(record.hostBootId, winners[0].hostBootId, '持久化所有权记录必须属于胜者');
    await fs.writeFile(holdA, 'release\n', 'utf8');
    await fs.writeFile(holdB, 'release\n', 'utf8');
    await waitForExit(claimerA, 60_000, true);
    await waitForExit(claimerB, 60_000, true);
  } finally {
    await cleanupChildren(children);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('活动 pin、并发调用与空闲释放串行化（所有权管理器作用域）', { timeout: 120_000 }, async () => {
  const { outer, binding } = await createIsolatedRoot('pins');
  const manager = new ConversationRuntimeOwnerManager(binding, 'pin-host');
  manager.setPendingWorkProbe(async () => false);
  try {
    const idle = 'conversation-idle';
    await manager.claim(idle);
    assert.equal(await manager.releaseIfIdle(idle), true, '被动视图不持有 owner；无活动工作应立即释放');
    await assert.rejects(manager.assertOwned(idle),
      (error) => error?.code === OWNER_MISMATCH_CODE);

    const pinned = 'conversation-pinned';
    await manager.run(pinned, async () => {
      assert.equal(manager.owns(pinned), true);
      assert.equal(await manager.releaseIfIdle(pinned), false, '活动 pin 期间不得空闲释放');
    });
    assert.equal(manager.owns(pinned), false, 'run 结束后无待处理工作必须立即空闲释放');

    const nested = 'conversation-nested-pin';
    await manager.run(nested, () => manager.run(nested, async () => {
      assert.equal(await manager.releaseIfIdle(nested), false, '嵌套 pin 必须计数而非提前释放');
    }));
    assert.equal(manager.owns(nested), false);

    const concurrent = 'conversation-overlapping-pins';
    let started;
    let finish;
    const began = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { finish = resolve; });
    const first = manager.run(concurrent, async () => { started(); await gate; });
    await began;
    await manager.run(concurrent, async () => {
      assert.equal(await manager.releaseIfIdle(concurrent), false);
    });
    assert.equal(manager.owns(concurrent), true, '另一并发操作的 pin 必须保留 owner');
    finish();
    await first;
    assert.equal(manager.owns(concurrent), false);
  } finally {
    await manager.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('pending-work 探针在活动 pin 清零后保留所有权，探针失败与默认探针均保守保留（所有权管理器作用域）', {
  timeout: 120_000
}, async () => {
  const { outer, binding } = await createIsolatedRoot('probe');
  const retained = 'conversation-probe-retained';
  let pending = true;
  const probed = new ConversationRuntimeOwnerManager(binding, 'probed-host');
  probed.setPendingWorkProbe(async () => pending);
  const throwing = new ConversationRuntimeOwnerManager(binding, 'throwing-host');
  throwing.setPendingWorkProbe(async () => { throw new Error('探针故障'); });
  const conservative = new ConversationRuntimeOwnerManager(binding, 'conservative-host');
  try {
    await probed.claim(retained);
    assert.equal(await probed.releaseIfIdle(retained), false, '有待处理工作时不得释放');
    await probed.sweepIdle();
    assert.equal(probed.owns(retained), true, 'sweepIdle 必须保留仍有待处理工作的会话');
    pending = false;
    await probed.sweepIdle();
    assert.equal(probed.owns(retained), false, '待处理工作清零后 sweepIdle 必须释放');

    const threwConversation = 'conversation-probe-throws';
    await throwing.claim(threwConversation);
    assert.equal(await throwing.releaseIfIdle(threwConversation), false,
      '探针失败绝不能被解释为没有待处理工作');
    assert.equal(throwing.owns(threwConversation), true);

    const defaultConversation = 'conversation-probe-default';
    await conservative.claim(defaultConversation);
    assert.equal(await conservative.releaseIfIdle(defaultConversation), false,
      '未安装真实探针前默认探针必须保守保留');
  } finally {
    await probed.close();
    await throwing.close();
    await conservative.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('pending-work 判定边界：超过 25 条来源记录不得遮蔽更旧的运行中进程，前台完成进程不得保留（数据库探针证明）', {
  timeout: 120_000
}, async () => {
  const { outer, authority, binding } = await createIsolatedRoot('work-probe');
  let database;
  try {
    database = await openObserverDatabase(binding, 'work-probe-host');
    const store = new kernel.ContentAddressedStore(authority, binding);
    const conversationId = 'conversation-work-probe';
    const now = new Date().toISOString();
    const hasWork = () => database.hasConversationRuntimeWork(conversationId);
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now
      })
    ]);
    assert.equal(await hasWork(), false, '没有任何运行时事实的会话不得保留');

    const processInsert = (id, status, at) => kernel.DOMAIN_REPOSITORIES.domain('Process').insert({
      id, status,
      wrapper_nonce: `nonce-${id}`, wrapper_pid: 0n, child_pid: null, process_group_id: null,
      start_fingerprint: `fingerprint-${id}`, command_digest: `digest-${id}`, spool_locator: `spool/${id}`,
      retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n,
      started_at: at, updated_at: at, completed_at: status === 'running' ? null : at
    });
    const sourceInsert = (id, at) => kernel.DOMAIN_REPOSITORIES.domain('ProcessCompletionSourceLink').insert({
      id: `source-${id}`, process_id: id, conversation_id: conversationId,
      source_turn_id: `${id}-turn`, source_tool_call_id: `${id}-tool`, created_at: at
    });
    const receiptInsert = (id, at) => kernel.DOMAIN_REPOSITORIES.domain('ProcessReceipt').insert({
      id: `receipt-${id}`, process_id: id, outcome: 'succeeded', exit_code: 0n, exit_signal: null,
      wrapper_nonce: `nonce-${id}`, start_fingerprint: `fingerprint-${id}`, received_at: at
    });

    const runningId = 'process-oldest-running';
    await database.transaction([
      processInsert(runningId, 'running', '2026-01-01T00:00:00.000Z'),
      sourceInsert(runningId, '2026-01-01T00:00:00.000Z')
    ]);
    assert.equal(await hasWork(), true, '运行中进程必须保留会话所有权');

    const terminalSteps = [];
    for (let ordinal = 0; ordinal < 29; ordinal += 1) {
      const id = `process-terminal-${String(ordinal).padStart(2, '0')}`;
      const at = new Date(Date.parse('2026-01-02T00:00:00.000Z') + ordinal * 1_000).toISOString();
      terminalSteps.push(processInsert(id, 'exited', at), sourceInsert(id, at), receiptInsert(id, at));
    }
    await database.transaction(terminalSteps);
    assert.equal(await hasWork(), true, '超过 25 条更新的终态记录不得遮蔽更旧的运行中进程');

    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Process').update(runningId, {
        status: 'exited', updated_at: now, completed_at: now
      }),
      receiptInsert(runningId, now)
    ]);
    assert.equal(await hasWork(), false,
      '前台完成且有回执、无后台退出 Operation、无派发的进程不得保留');

    const backgroundId = 'process-terminal-00';
    const prepared = await store.prepare(
      database,
      `{"kind":"process_exit","processId":"${backgroundId}"}\n`,
      'process_exit_request'
    );
    await database.transaction([
      ...(prepared.insert ? [prepared.insert] : []),
      kernel.DOMAIN_REPOSITORIES.domain('Operation').insert({
        id: `operation-${backgroundId}`, owner_kind: 'process', owner_id: backgroundId,
        operation_seq: 1n, tool_call_id: null, status: 'succeeded', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').insert({
        id: `attempt-${backgroundId}`, operation_id: `operation-${backgroundId}`,
        attempt_seq: 1n, status: 'succeeded', created_at: now, updated_at: now, completed_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('EffectIntent').insert({
        id: `intent-${backgroundId}`, attempt_id: `attempt-${backgroundId}`,
        effect_kind: 'process_exit', dispatch_state: 'receipt_written',
        request_object_id: prepared.metadata.id, created_at: now, updated_at: now
      })
    ]);
    assert.equal(await hasWork(), true,
      '有后台退出 Operation 证据但缺少完成派发的进程必须保留');

    const dispatchId = `dispatch-receipt-${backgroundId}`;
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').insert({
        id: dispatchId, process_receipt_id: `receipt-${backgroundId}`, state: 'pending',
        claim_owner_host_boot_id: null, claim_generation: 0n, claim_expires_at: null,
        attempt_count: 0n, failure_count: 0n, next_attempt_at: null, last_error: null,
        completed_at: null, created_at: now, updated_at: now
      })
    ]);
    assert.equal(await hasWork(), true, '待派发的完成投递必须保留');

    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').update(dispatchId, {
        state: 'claimed',
        claim_owner_host_boot_id: database.hostBootId,
        claim_generation: 1n,
        claim_expires_at: new Date(Date.now() + 60_000).toISOString(),
        attempt_count: 1n,
        next_attempt_at: null,
        updated_at: now
      })
    ]);
    assert.equal(await hasWork(), true, '已认领中的完成投递必须保留');

    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').update(dispatchId, {
        state: 'completed',
        claim_owner_host_boot_id: null,
        claim_expires_at: null,
        next_attempt_at: null,
        last_error: null,
        completed_at: now,
        updated_at: now
      })
    ]);
    assert.equal(await hasWork(), false, '完成派发结束后后台进程不得继续保留');
  } finally {
    if (database) await database.close().catch(() => undefined);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('真实终止的宿主进程所有权可被接管并留下死亡代际墓碑（跨进程 SIGKILL 证明）', { timeout: 120_000 }, async () => {
  const children = [];
  const { outer, binding } = await createIsolatedRoot('takeover');
  const dataRoot = binding.paths.dataRootPath;
  try {
    const conversationId = 'conversation-takeover';
    const holder = spawnTracked(children, 'host-holder', dataRoot, {
      LIMCODE_OWNER_HOST: 'doomed-host',
      LIMCODE_OWNER_CLAIM: conversationId,
      LIMCODE_OWNER_READY: path.join(outer, 'holder-ready.json')
    });
    const ready = await waitForJson(path.join(outer, 'holder-ready.json'), 60_000);
    assert.equal(typeof ready.pid, 'number');
    assert.equal(typeof ready.ownerToken, 'string');
    holder.kill('SIGKILL');
    await waitForExit(holder, 30_000);

    const goPath = path.join(outer, 'go');
    const holdA = path.join(outer, 'takeover-a-hold');
    const holdB = path.join(outer, 'takeover-b-hold');
    const claimerA = spawnTracked(children, 'claimer', dataRoot, {
      LIMCODE_OWNER_HOST: 'takeover-host-a',
      LIMCODE_OWNER_CLAIM: conversationId,
      LIMCODE_OWNER_MODE: 'claim',
      LIMCODE_OWNER_READY: path.join(outer, 'takeover-a-ready'),
      LIMCODE_OWNER_GO: goPath,
      LIMCODE_OWNER_HOLD: holdA,
      LIMCODE_OWNER_RESULT: path.join(outer, 'takeover-a-result.json')
    });
    const claimerB = spawnTracked(children, 'claimer', dataRoot, {
      LIMCODE_OWNER_HOST: 'takeover-host-b',
      LIMCODE_OWNER_CLAIM: conversationId,
      LIMCODE_OWNER_MODE: 'claim',
      LIMCODE_OWNER_READY: path.join(outer, 'takeover-b-ready'),
      LIMCODE_OWNER_GO: goPath,
      LIMCODE_OWNER_HOLD: holdB,
      LIMCODE_OWNER_RESULT: path.join(outer, 'takeover-b-result.json')
    });
    await waitForFile(path.join(outer, 'takeover-a-ready'), 60_000);
    await waitForFile(path.join(outer, 'takeover-b-ready'), 60_000);
    await fs.writeFile(goPath, 'go\n', 'utf8');
    const results = await Promise.all([
      waitForJson(path.join(outer, 'takeover-a-result.json'), 60_000),
      waitForJson(path.join(outer, 'takeover-b-result.json'), 60_000)
    ]);
    const winners = results.filter((result) => result.outcome === 'claimed');
    const losers = results.filter((result) => result.outcome === 'busy');
    assert.equal(winners.length, 1, '死亡宿主被接管时必须恰好一个胜者');
    assert.equal(losers.length, 1);
    assert.equal(losers[0].code, OWNER_BUSY_CODE);
    assert.equal(losers[0].ownerHostBootId, winners[0].hostBootId);

    const record = await readOwnerRecord(binding.paths, conversationId);
    assert.equal(record.hostBootId, winners[0].hostBootId);
    assert.notEqual(record.ownerToken, ready.ownerToken, '接管必须发布新的 ownerToken');
    const claimPath = conversationRuntimeOwnerClaimPath(binding.paths, conversationId);
    const tombstone = claimPrimitives.claimGenerationPath(claimPath, `dead-${ready.ownerToken}`);
    assert.ok((await fs.readdir(tombstone)).length > 0, '死亡代际墓碑必须保持非空');
    await fs.writeFile(holdA, 'release\n', 'utf8');
    await fs.writeFile(holdB, 'release\n', 'utf8');
    await waitForExit(claimerA, 60_000, true);
    await waitForExit(claimerB, 60_000, true);
  } finally {
    await cleanupChildren(children);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('存活宿主携带陈旧 ExecutionLease 也不可被偷，畸形所有权记录 fail closed（跨进程 + 管理器作用域）', {
  timeout: 180_000
}, async () => {
  const children = [];
  const { outer, binding } = await createIsolatedRoot('stale-lease');
  const dataRoot = binding.paths.dataRootPath;
  let observer;
  try {
    const conversationId = 'conversation-stale-lease';
    const holder = spawnTracked(children, 'host-holder', dataRoot, {
      LIMCODE_OWNER_HOST: 'live-owner-host',
      LIMCODE_OWNER_CLAIM: conversationId,
      LIMCODE_OWNER_READY: path.join(outer, 'live-ready.json')
    });
    const ready = await waitForJson(path.join(outer, 'live-ready.json'), 60_000);

    observer = await openObserverDatabase(binding, 'observer-stale-lease');
    const now = new Date().toISOString();
    await observer.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main',
        role: 'default', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: `${conversationId}-turn`, conversation_id: conversationId, status: 'terminated',
        created_at: now, updated_at: now, terminal_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: `${conversationId}-lease`, conversation_id: conversationId, turn_id: `${conversationId}-turn`,
        owner_id: 'ghost-owner', host_boot_id: 'ghost-host', generation: 1n,
        acquired_at: PAST, expires_at: PAST
      })
    ]);

    const denied = spawnTracked(children, 'claimer', dataRoot, {
      LIMCODE_OWNER_HOST: 'thief-host',
      LIMCODE_OWNER_CLAIM: conversationId,
      LIMCODE_OWNER_MODE: 'claim',
      LIMCODE_OWNER_RESULT: path.join(outer, 'thief-result.json')
    });
    await waitForExit(denied, 60_000, true);
    const deniedResult = await readJson(path.join(outer, 'thief-result.json'));
    assert.equal(deniedResult.outcome, 'busy', '存活宿主的所有权不得因陈旧 ExecutionLease 被偷');
    assert.equal(deniedResult.code, OWNER_BUSY_CODE);
    assert.equal(deniedResult.ownerHostBootId, ready.hostBootId);
    assert.equal(deniedResult.ownerProcessId, ready.pid);

    const deniedTry = spawnTracked(children, 'claimer', dataRoot, {
      LIMCODE_OWNER_HOST: 'thief-host-try',
      LIMCODE_OWNER_CLAIM: conversationId,
      LIMCODE_OWNER_MODE: 'try',
      LIMCODE_OWNER_RESULT: path.join(outer, 'thief-try-result.json')
    });
    await waitForExit(deniedTry, 60_000, true);
    assert.equal((await readJson(path.join(outer, 'thief-try-result.json'))).outcome, 'busy',
      'tryClaim 对存活宿主只能返回 false');

    const attempt = spawnTracked(children, 'input-attempt', dataRoot, {
      LIMCODE_OWNER_TARGET: conversationId,
      LIMCODE_OWNER_RESULT: path.join(outer, 'attempt-result.json')
    });
    await waitForExit(attempt, 90_000, true);
    const attemptResult = await readJson(path.join(outer, 'attempt-result.json'));
    assert.equal(attemptResult.outcome, 'rejected', '异主会话的显式命令必须被拒绝');
    assert.equal(attemptResult.code, OWNER_BUSY_CODE);
    assert.equal(attemptResult.providerCalls, 0, '被拒绝的命令绝不可触达 Provider');

    holder.kill('SIGTERM');
    await waitForExit(holder, 60_000, true);
    const after = spawnTracked(children, 'claimer', dataRoot, {
      LIMCODE_OWNER_HOST: 'after-close-host',
      LIMCODE_OWNER_CLAIM: conversationId,
      LIMCODE_OWNER_MODE: 'try',
      LIMCODE_OWNER_RESULT: path.join(outer, 'after-result.json')
    });
    await waitForExit(after, 60_000, true);
    assert.equal((await readJson(path.join(outer, 'after-result.json'))).outcome, 'claimed',
      '宿主正常退出后其会话必须可以被新宿主认领');

    const malformed = 'conversation-malformed-record';
    const holderManager = new ConversationRuntimeOwnerManager(binding, 'malformed-holder');
    holderManager.setPendingWorkProbe(async () => false);
    try {
      await holderManager.claim(malformed);
      const recordPath = path.join(conversationRuntimeOwnerClaimPath(binding.paths, malformed), 'owner.json');
      const peer = new ConversationRuntimeOwnerManager(binding, 'malformed-peer');
      try {
        await fs.writeFile(recordPath, '这不是合法 JSON\n', 'utf8');
        await assert.rejects(peer.tryClaim(malformed),
          (error) => error?.code === OWNER_INVALID_CODE, '畸形记录必须 fail closed');
        await assert.rejects(peer.claim(malformed),
          (error) => error?.code === OWNER_INVALID_CODE);
        await fs.writeFile(recordPath, '{}\n', 'utf8');
        await assert.rejects(peer.tryClaim(malformed),
          (error) => error?.code === OWNER_INVALID_CODE, '缺字段记录同样 fail closed');
        const emptyClaim = 'conversation-empty-claim-dir';
        await fs.mkdir(conversationRuntimeOwnerClaimPath(binding.paths, emptyClaim), { recursive: true });
        await assert.rejects(peer.tryClaim(emptyClaim),
          (error) => error?.code === OWNER_INVALID_CODE, '空 canonical 目录同样 fail closed');
        await assert.rejects(peer.claim(emptyClaim),
          (error) => error?.code === OWNER_INVALID_CODE);
      } finally {
        await peer.close();
      }
    } finally {
      await holderManager.close();
    }
  } finally {
    if (observer) await observer.close().catch(() => undefined);
    await cleanupChildren(children);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('陈旧代际模型回调与栅栏写入被拒绝且不产生持久化副作用（运行时证明）', { timeout: 180_000 }, async () => {
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
          await controls.onEvent({
            kind: 'completed',
            streamSeq: '2',
            content: { role: 'model', parts: [{ text: '陈旧回调不应提交' }] }
          });
        } catch (error) {
          providerErrors.push(error);
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
});

test('运行时维护等待存活持有者、接管死亡持有者，宿主离线守卫区分存活/畸形/死亡（跨进程）', {
  timeout: 240_000
}, async () => {
  const children = [];
  const { outer, binding } = await createIsolatedRoot('maintenance');
  const dataRoot = binding.paths.dataRootPath;
  try {
    const claimPath = hostControl.runtimeMaintenanceClaimPath(binding.paths);
    assert.equal(path.dirname(claimPath), outer, '维护锁必须落在临时夹具容器内');

    const maintenanceConversation = 'conversation-maintenance-waiter';
    const holderReady = path.join(outer, 'maintenance-ready.json');
    const holderGate = path.join(outer, 'maintenance-gate');
    const holderFinished = path.join(outer, 'maintenance-finished');
    const holder = spawnTracked(children, 'maintenance-holder', dataRoot, {
      LIMCODE_OWNER_READY: holderReady,
      LIMCODE_OWNER_GATE: holderGate,
      LIMCODE_OWNER_FINISHED: holderFinished,
      LIMCODE_OWNER_RESULT: path.join(outer, 'maintenance-result.json')
    });
    await waitForFile(holderReady, 60_000);

    let entered = false;
    const maintenancePromise = withRuntimeMaintenance(binding.paths, async () => {
      entered = true;
      await fs.access(holderFinished);
    });
    void maintenancePromise.catch(() => undefined);
    const waiter = spawnTracked(children, 'claimer', dataRoot, {
      LIMCODE_OWNER_HOST: 'maintenance-waiter-host',
      LIMCODE_OWNER_CLAIM: maintenanceConversation,
      LIMCODE_OWNER_MODE: 'claim',
      LIMCODE_OWNER_RESULT: path.join(outer, 'waiter-result.json')
    });
    await fs.writeFile(holderGate, 'release\n', 'utf8');
    await maintenancePromise;
    assert.equal(entered, true, '存活持有者释放后维护操作必须进入');
    await waitForExit(holder, 60_000, true);
    assert.equal((await readJson(path.join(outer, 'maintenance-result.json'))).outcome, 'completed');
    await waitForExit(waiter, 90_000, true);
    assert.equal((await readJson(path.join(outer, 'waiter-result.json'))).outcome, 'claimed',
      '维护期间的 RuntimeDatabase.open 必须等待而非失败');

    const doomedReady = path.join(outer, 'doomed-ready.json');
    const doomed = spawnTracked(children, 'maintenance-holder', dataRoot, {
      LIMCODE_OWNER_READY: doomedReady,
      LIMCODE_OWNER_GATE: path.join(outer, 'doomed-gate'),
      LIMCODE_OWNER_RESULT: path.join(outer, 'doomed-result.json')
    });
    const doomedMeta = await waitForJson(doomedReady, 60_000);
    assert.equal(typeof doomedMeta.claimToken, 'string');
    doomed.kill('SIGKILL');
    await waitForExit(doomed, 30_000);
    let takeoverEntered = false;
    await withRuntimeMaintenance(binding.paths, async () => { takeoverEntered = true; });
    assert.equal(takeoverEntered, true, '已终止进程的维护锁必须被接管');
    const maintenanceTombstone = claimPrimitives.claimGenerationPath(claimPath, `dead-${doomedMeta.claimToken}`);
    assert.ok((await fs.readdir(maintenanceTombstone)).length > 0, '死亡维护代际必须留下非空墓碑');

    await fs.mkdir(claimPath, { recursive: true });
    await fs.writeFile(path.join(claimPath, 'owner.json'), '损坏的维护记录\n', 'utf8');
    let invalidEntered = false;
    await assert.rejects(
      withRuntimeMaintenance(binding.paths, async () => { invalidEntered = true; }),
      (error) => error?.code === 'runtime-maintenance-invalid'
    );
    assert.equal(invalidEntered, false, '畸形维护记录绝不可被接管或进入');
    await fs.rm(claimPath, { recursive: true, force: true });

    const guardReady = path.join(outer, 'guard-ready.json');
    const guard = spawnTracked(children, 'host-holder', dataRoot, {
      LIMCODE_OWNER_HOST: 'guard-live-host',
      LIMCODE_OWNER_READY: guardReady
    });
    const guardMeta = await waitForJson(guardReady, 60_000);
    assert.equal(guardMeta.hostBootId, 'guard-live-host');
    await assert.rejects(
      assertRuntimeHostsOffline(binding.paths),
      (error) => error?.code === HOSTS_ACTIVE_CODE
        && Array.isArray(error.hosts)
        && error.hosts.some((host) => host.hostBootId === 'guard-live-host' && host.state === 'live'),
      '存活宿主必须阻止离线断言'
    );
    await assertRuntimeHostsOffline(binding.paths, 'guard-live-host');
    const livenessDirectory = hostControl.runtimeHostLivenessDirectory(binding.paths);
    const malformedLiveness = path.join(livenessDirectory, 'malformed.json');
    await fs.writeFile(malformedLiveness, '不是宿主记录\n', 'utf8');
    await assert.rejects(
      assertRuntimeHostsOffline(binding.paths, 'guard-live-host'),
      (error) => error?.code === HOSTS_ACTIVE_CODE
        && error.hosts.some((host) => host.state === 'malformed'),
      '畸形宿主记录同样 fail closed'
    );
    await fs.rm(malformedLiveness, { force: true });
    guard.kill('SIGTERM');
    await waitForExit(guard, 60_000, true);
    await assertRuntimeHostsOffline(binding.paths);

    const crashedReady = path.join(outer, 'crashed-ready.json');
    const crashed = spawnTracked(children, 'host-holder', dataRoot, {
      LIMCODE_OWNER_HOST: 'guard-crashed-host',
      LIMCODE_OWNER_READY: crashedReady
    });
    await waitForJson(crashedReady, 60_000);
    crashed.kill('SIGKILL');
    await waitForExit(crashed, 30_000);
    await assertRuntimeHostsOffline(binding.paths);

    const reentrant = await withRuntimeMaintenance(binding.paths, () =>
      withRuntimeMaintenance(binding.paths, async () => 'inner'));
    assert.equal(reentrant, 'inner', '同一异步作用域的嵌套维护必须可重入');
  } finally {
    await cleanupChildren(children);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('共享配置根准入期间新作用域注册不得绕过，死亡准入持有者可被接管（跨进程准入证明）', {
  timeout: 240_000
}, async () => {
  const children = [];
  const { outer, binding } = await createIsolatedRoot('admission');
  const dataRoot = binding.paths.dataRootPath;
  try {
    const configurationRoot = path.join(outer, 'config');
    await fs.mkdir(configurationRoot, { recursive: true });
    const admissionClaimPath = hostControl.runtimeDataRootAdmissionClaimPath(configurationRoot);
    assert.equal(path.dirname(admissionClaimPath), outer, '准入锁必须落在临时夹具容器内');

    const holderReady = path.join(outer, 'admission-ready.json');
    const holderGate = path.join(outer, 'admission-gate');
    const holderFinished = path.join(outer, 'admission-finished');
    const holder = spawnTracked(children, 'admission-holder', dataRoot, {
      LIMCODE_OWNER_CONFIG_ROOT: configurationRoot,
      LIMCODE_OWNER_READY: holderReady,
      LIMCODE_OWNER_GATE: holderGate,
      LIMCODE_OWNER_FINISHED: holderFinished,
      LIMCODE_OWNER_RESULT: path.join(outer, 'admission-result.json')
    });
    await waitForFile(holderReady, 60_000);

    const openerAttempting = path.join(outer, 'opener-attempting');
    const openerResult = path.join(outer, 'opener-result.json');
    const opener = spawnTracked(children, 'scoped-opener', dataRoot, {
      LIMCODE_OWNER_HOST: 'scoped-opener-host',
      LIMCODE_OWNER_CONFIG_ROOT: configurationRoot,
      LIMCODE_OWNER_ATTEMPTING: openerAttempting,
      LIMCODE_OWNER_FINISHED: holderFinished,
      LIMCODE_OWNER_RESULT: openerResult
    });
    await waitForFile(openerAttempting, 60_000);
    await assert.rejects(fs.access(openerResult), { code: 'ENOENT' },
      '共享根准入被持有期间作用域注册绝不可抢先完成');
    await fs.writeFile(holderGate, 'release\n', 'utf8');
    await waitForExit(holder, 60_000, true);
    assert.equal((await readJson(path.join(outer, 'admission-result.json'))).outcome, 'completed');
    await waitForExit(opener, 90_000, true);
    const opened = await readJson(openerResult);
    assert.equal(opened.outcome, 'opened', '准入释放后作用域注册必须完成');
    assert.equal(opened.finishedVisibleAtOpen, true,
      '作用域注册只能在准入持有者完成并释放之后发生');

    const doomedReady = path.join(outer, 'doomed-admission-ready.json');
    const doomed = spawnTracked(children, 'admission-holder', dataRoot, {
      LIMCODE_OWNER_CONFIG_ROOT: configurationRoot,
      LIMCODE_OWNER_READY: doomedReady,
      LIMCODE_OWNER_GATE: path.join(outer, 'doomed-admission-gate'),
      LIMCODE_OWNER_RESULT: path.join(outer, 'doomed-admission-result.json')
    });
    const doomedMeta = await waitForJson(doomedReady, 60_000);
    assert.equal(typeof doomedMeta.claimToken, 'string');
    doomed.kill('SIGKILL');
    await waitForExit(doomed, 30_000);
    const successor = spawnTracked(children, 'scoped-opener', dataRoot, {
      LIMCODE_OWNER_HOST: 'scoped-successor-host',
      LIMCODE_OWNER_CONFIG_ROOT: configurationRoot,
      LIMCODE_OWNER_RESULT: path.join(outer, 'successor-result.json')
    });
    await waitForExit(successor, 90_000, true);
    assert.equal((await readJson(path.join(outer, 'successor-result.json'))).outcome, 'opened',
      '已终止进程的准入锁必须被接管');
    const admissionTombstone = claimPrimitives.claimGenerationPath(
      admissionClaimPath, `dead-${doomedMeta.claimToken}`
    );
    assert.ok((await fs.readdir(admissionTombstone)).length > 0, '死亡准入代际必须留下非空墓碑');

    const nestedAdmission = await hostControl.withRuntimeDataRootAdmission(configurationRoot, () =>
      hostControl.withRuntimeDataRootAdmission(configurationRoot, async () => 'inner'));
    assert.equal(nestedAdmission, 'inner', '同一异步作用域的嵌套准入必须可重入');
  } finally {
    await cleanupChildren(children);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

}

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
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-owner-proof-${label}-`));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  return { outer, authority: candidate.authority, binding: candidate.binding };
}

async function openObserverDatabase(binding, hostBootId) {
  const authority = new kernel.RootAuthority(() => binding.paths.dataRootPath);
  return kernel.RuntimeDatabase.open(authority, { hostBootId });
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
