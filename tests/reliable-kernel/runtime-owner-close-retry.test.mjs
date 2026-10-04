import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createConfigurationRoot, kernel, removeConfigurationRoot } from './fixtures/runtime-merge-fixture.mjs';

test('database close reports owner cleanup failure, finishes fencing, and permits cleanup retry', async t => {
  const fixture = await createConfigurationRoot();
  const database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: 'owner-close-retry' });
  const ownerClose = database.conversationOwners.close.bind(database.conversationOwners);
  t.after(async () => {
    database.conversationOwners.close = ownerClose;
    await database.close().catch(() => undefined);
    await removeConfigurationRoot(fixture.root);
  });
  const failure = Object.assign(new Error('temporary owner release failure'), { code: 'EACCES' });
  let calls = 0;
  database.conversationOwners.close = async () => {
    if (++calls === 1) throw failure;
    await ownerClose();
  };
  const hostRecord = database.hostLivenessPath(database.hostBootId);
  await fs.access(hostRecord);
  const first = database.close();
  assert.equal(database.close(), first, 'concurrent close callers share one attempt');
  await assert.rejects(first, error => error === failure);
  assert.equal(calls, 1);
  assert.equal(database.worker.threadId, -1, 'SQLite worker is terminated before owner cleanup');
  await assert.rejects(database.inspect(), /closed/);
  await assert.rejects(fs.access(hostRecord), { code: 'ENOENT' });
  assert.equal(database.performanceMetricSinks.size, 0);
  await database.close();
  assert.equal(calls, 2, 'a later close retries the failed owner cleanup');
  await database.close();
  assert.equal(calls, 2, 'a successful close stays complete');
});

test('application retries failed database cleanup without disposing capabilities a second time', async () => {
  const application = Object.create(kernel.ReliableKernelApplication.prototype);
  const calls = [];
  const historyPreparationStops = [];
  const close = name => async () => { calls.push(name); };
  const failure = Object.assign(new Error('temporary owner release failure'), { code: 'EACCES' });
  let databaseCalls = 0;
  Object.assign(application, {
    unsubscribeConvergence: () => {
      assert.ok(historyPreparationStops.length > 0, 'history preparation stops before dependency cleanup');
      calls.push('unsubscribe');
    },
    webviewFeed: { close: () => calls.push('webview') },
    runtime: { clientFeed: { close: () => calls.push('client-feed') } },
    modelProvider: { quiesceAllActiveDispatches: close('provider-handoff') },
    childOwnedProcessCleanup: { dispose: close('child-processes') },
    processes: { dispose: close('processes') },
    processDeliveries: { dispose: close('deliveries') },
    toolDispatcher: { quiesce: close('tool-handoff'), dispose: close('tools') },
    providers: { dispose: close('providers') },
    runtimeDiagnostics: { close: close('diagnostics') },
    database: {
      stopHistoryPreparation: reason => {
        assert.equal(reason.name, 'ExecutionHandoffError');
        historyPreparationStops.push(reason);
      },
      close: async () => { if (++databaseCalls === 1) throw failure; }
    }
  });
  const first = application.close();
  assert.ok(historyPreparationStops.length > 0, 'close stops history preparation before async cleanup');
  assert.equal(application.close(), first);
  await assert.rejects(first, error => error === failure);
  const finishedCapabilities = [...calls];
  await application.close();
  assert.equal(databaseCalls, 2);
  assert.deepEqual(calls, finishedCapabilities, 'cleanup retry cannot revive or dispose capabilities again');
  assert.equal(application.convergenceClosed, true);
  await application.close();
  assert.equal(databaseCalls, 2);
});
