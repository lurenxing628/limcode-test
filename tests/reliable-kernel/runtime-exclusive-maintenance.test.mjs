import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { resolveVscodeRuntimeDataRoot } = kernelFile('vscodeRootAuthority.js');
const { ownProcessStartIdentity } = kernelFile('runtimeClaimPrimitives.js');
const {
  readExclusiveMaintenanceRequest, registerExclusiveMaintenanceParticipant, requestExclusiveRuntimeMaintenance,
  runtimeExclusiveMaintenanceDirectory
} = kernelFile('runtimeExclusiveMaintenance.js');

const NOW = '2026-09-26T00:00:00.000Z';

test('没有其它窗口时立即执行维护操作，不发布请求', async (t) => {
  const { paths } = await createRoot(t);
  let waits = 0;
  const outcome = await requestExclusiveRuntimeMaintenance(paths, {
    operation: 'historical-merge', message: '为合并旧聊天记录', timeoutMs: 1_000, onWaitStart: () => { waits += 1; }
  }, async () => 'done');
  assert.deepEqual(outcome, { state: 'completed', result: 'done', waited: false });
  assert.equal(waits, 0);
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
});

test('有未参与协作的存活窗口（旧版本）时不等待，直接返回 not-coordinatable', async (t) => {
  const { paths, binding } = await createRoot(t);
  await publishHost(binding, 'old-window');
  let ran = false;
  const outcome = await requestExclusiveRuntimeMaintenance(paths, {
    operation: 'historical-merge', message: '为合并旧聊天记录', timeoutMs: 5_000
  }, async () => { ran = true; });
  assert.equal(outcome.state, 'not-coordinatable');
  assert.deepEqual(outcome.hosts.map((host) => host.hostBootId), ['old-window']);
  assert.equal(ran, false);
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
});

test('参与协作的窗口看到请求、下线后请求方获得独占并执行，结束后清理请求', async (t) => {
  const { paths, binding } = await createRoot(t);
  const host = await publishHost(binding, 'peer-window');
  const participant = await registerExclusiveMaintenanceParticipant(paths, 'peer-window');
  const seen = [];
  const events = [];
  const requesting = requestExclusiveRuntimeMaintenance(paths, {
    operation: 'data-root-migration', message: '为迁移数据目录', timeoutMs: 5_000, pollMs: 10,
    onWaitStart: (hosts) => events.push(['wait-start', hosts.map((item) => item.hostBootId)]),
    onWaitEnd: () => events.push('wait-end')
  }, async () => {
    events.push('operation');
    // The request is still published while the operation runs, so a reloaded window keeps waiting.
    assert.equal((await readExclusiveMaintenanceRequest(paths))?.operation, 'data-root-migration');
    return 42;
  });
  for (let i = 0; i < 200 && seen.length === 0; i += 1) {
    const request = await readExclusiveMaintenanceRequest(paths);
    if (request) seen.push(request);
    else await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(seen[0].operation, 'data-root-migration');
  assert.equal(seen[0].message, '为迁移数据目录');
  assert.equal(seen[0].requesterProcessId, process.pid);
  // The peer finished its running work and reloaded: its liveness disappears with its registration.
  await participant.unregister();
  await fs.rm(host);
  assert.deepEqual(await requesting, { state: 'completed', result: 42, waited: true });
  assert.deepEqual(events, [['wait-start', ['peer-window']], 'wait-end', 'operation']);
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
  assert.deepEqual(await fs.readdir(runtimeExclusiveMaintenanceDirectory(paths)).then((names) => names.filter((name) => name.endsWith('.json'))), []);
});

test('等待有上限：超时或取消都不执行操作，并撤回请求', async (t) => {
  const { paths, binding } = await createRoot(t);
  await publishHost(binding, 'busy-window');
  const participant = await registerExclusiveMaintenanceParticipant(paths, 'busy-window');
  t.after(() => participant.unregister());
  let ran = false;
  const timedOut = await requestExclusiveRuntimeMaintenance(paths, {
    operation: 'historical-merge', message: '为合并旧聊天记录', timeoutMs: 60, pollMs: 10
  }, async () => { ran = true; });
  assert.equal(timedOut.state, 'timed-out');
  assert.deepEqual(timedOut.hosts.map((host) => host.hostBootId), ['busy-window']);
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);

  let cancel = false;
  const cancelling = requestExclusiveRuntimeMaintenance(paths, {
    operation: 'historical-merge', message: '为合并旧聊天记录', timeoutMs: 5_000, pollMs: 10, isCancelled: () => cancel
  }, async () => { ran = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  cancel = true;
  assert.equal((await cancelling).state, 'cancelled');
  assert.equal(ran, false);
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
});

test('过期请求或请求方进程已不存在的请求不会让窗口重载；死进程的参与登记会被清理', async (t) => {
  const { paths } = await createRoot(t);
  const directory = runtimeExclusiveMaintenanceDirectory(paths);
  await fs.mkdir(path.join(directory, 'hosts'), { recursive: true });
  const request = {
    kind: 'limcode-runtime-exclusive-maintenance-request', requestId: 'request-1', operation: 'historical-merge',
    message: '为合并旧聊天记录', requesterProcessId: process.pid, requesterProcessStartIdentity: ownProcessStartIdentity(),
    createdAt: NOW, expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify(request));
  assert.equal((await readExclusiveMaintenanceRequest(paths))?.requestId, 'request-1');
  await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify({ ...request, expiresAt: NOW }));
  assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
  if (ownProcessStartIdentity() !== undefined) {
    await fs.writeFile(path.join(directory, 'request.json'),
      JSON.stringify({ ...request, requesterProcessStartIdentity: 'another-process-start' }));
    assert.equal(await readExclusiveMaintenanceRequest(paths), undefined);
    await fs.writeFile(path.join(directory, 'hosts', 'stale-window.json'), JSON.stringify({
      kind: 'limcode-runtime-exclusive-maintenance-participant', hostBootId: 'stale-window',
      processId: process.pid, processStartIdentity: 'another-process-start', registeredAt: NOW
    }));
    const participant = await registerExclusiveMaintenanceParticipant(paths, 'fresh-window');
    assert.deepEqual(await fs.readdir(path.join(directory, 'hosts')), ['fresh-window.json']);
    await participant.unregister();
  }
  await assert.rejects(registerExclusiveMaintenanceParticipant(paths, '../escape'), /safe file name/);
});

async function createRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-exclusive-maintenance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { root, binding, paths: binding.paths };
}

async function publishHost(binding, hostBootId) {
  const target = path.join(binding.paths.dataRootPath, `host-liveness/${hostBootId}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ kind: 'limcode-runtime-host-liveness', dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId,
    rootGeneration: binding.rootGeneration, hostBootId, livenessId: `${hostBootId}-liveness`, processId: process.pid,
    processStartIdentity: ownProcessStartIdentity(), startedAt: NOW, heartbeatAt: NOW }));
  return target;
}
