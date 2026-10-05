const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const kernel = require('../dist/extension/backend/reliableKernel/index.js');

test('Bash 专属语法的进程输出完整保存，启动补扫后删除临时目录且历史输出仍可读', { timeout: 30_000 }, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-process-spool-cleanup-'));
  const candidate = await kernel.resetCandidateRuntimeRoot(parent);
  const database = await kernel.RuntimeDatabase.open(candidate.authority, {
    hostBootId: 'process-spool-cleanup-test'
  });
  const store = kernel.ContentAddressedStore.forDatabase(candidate.authority, database);
  const effects = new kernel.EffectControlPlane(database, store);
  const processes = new kernel.ProcessControlPlane(
    database,
    store,
    effects,
    candidate.authority,
    candidate.binding
  );

  try {
    const now = new Date().toISOString();
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'conversation-spool-cleanup', title: 'spool cleanup', status: 'active',
        created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: 'turn-spool-cleanup', conversation_id: 'conversation-spool-cleanup', status: 'active',
        created_at: now, updated_at: now, terminal_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: 'lease-spool-cleanup', conversation_id: 'conversation-spool-cleanup',
        turn_id: 'turn-spool-cleanup', owner_id: 'owner-spool-cleanup',
        host_boot_id: 'process-spool-cleanup-test', generation: 1n, acquired_at: now,
        expires_at: '2099-01-01T00:00:00.000Z'
      })
    ]);

    const toolCallId = 'tool-call-spool-cleanup';
    await effects.createToolCall({
      source: { kind: 'callback', key: 'tool-call:spool-cleanup' },
      toolCallId,
      turnId: 'turn-spool-cleanup',
      toolName: 'bash',
      arguments: { command: 'write durable output' }
    });
    const prepared = await processes.prepareStart({
      source: { kind: 'internal', key: 'process:spool-cleanup' },
      toolCallId,
      command: "values=(durable output); for ((i=0; i<${#values[@]}; i++)); do ((i > 0)) && printf '-'; printf '%s' \"${values[$i]}\"; done; cat <(printf '%s' '-process-substitution'); sleep 0.35",
      cwd: parent
    });
    const started = await processes.dispatchStart(prepared.effect.effectIntentId);
    assert.equal(started.observation?.state, 'background_started');

    const processId = prepared.request.processId;
    const spoolPath = kernel.processSpoolPath(candidate.binding, prepared.request.spoolLocator);
    await waitUntilTerminal(processes, processId);
    await processes.reconcileProcessExit(processId);

    assert.equal(await processes.cleanupArchivedSpool(processId), 'retained');
    await fs.access(spoolPath);

    const report = await processes.cleanupArchivedSpools();
    assert.deepEqual(report, {
      scanned: 1,
      removed: 1,
      alreadyAbsent: 0,
      retained: 0,
      failed: 0
    });
    await assert.rejects(fs.access(spoolPath), { code: 'ENOENT' });

    const reconciled = await processes.reconcileOutput(processId);
    assert.equal(reconciled.retainedChunks > 0n, true);
    const output = await processes.readOutputPage(processId);
    assert.equal(output.stdout, 'durable-output-process-substitution');
    assert.equal(output.complete, true);
  } finally {
    await processes.dispose().catch(() => undefined);
    await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

async function waitUntilTerminal(processes, processId) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const observed = await processes.wait(processId, 100);
    if (observed.state === 'exited') return observed;
    if (observed.state === 'outcome_unknown') throw new Error(observed.reason);
    if (Date.now() >= deadline) throw new Error(`Process ${processId} did not exit.`);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
