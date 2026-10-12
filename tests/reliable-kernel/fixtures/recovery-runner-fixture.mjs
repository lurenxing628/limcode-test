// Focused real production probes; no matrix or duplicate registrations.
import assert from 'node:assert/strict';

import { kernel } from './runtime-behavior-fixture.mjs';

const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);

const textReply = text => ({ role: 'model', parts: [{ text }] });

async function withHarness(getRuntime, verify) {
  const fixture = await getRuntime();
  let providerCalls = 0;
  const scope = await fixture.scope('runner-recovery', {
    async reply(_request, controls) {
      providerCalls += 1;
      await controls.onEvent({ kind: 'completed', streamSeq: '1',
        content: textReply('完成。') });
    }
  });
  const { app, conversationId, ownerId } = scope;
  const errors = [];
  const runner = scope.runner(errors);
  const originalClaim = app.database.conversationOwners.tryClaimEligible;
  const originalAppend = app.turnOutput.appendAssistantMessage;
  try {
    await verify({ app, runner, conversationId, ownerId, errors,
      dormantInput: key => scope.input(key, key),
      get providerCalls() { return providerCalls; } });
  } finally {
    runner.dispose();
    await runner.waitForIdle();
    app.database.conversationOwners.tryClaimEligible = originalClaim;
    app.turnOutput.appendAssistantMessage = originalAppend;
  }
}

const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(repo(domain).list({
  where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
}))).snapshot;

async function eventually(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function gate() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function queueAfterTerminal(h) {
  const first = await h.dormantInput('pre-restart-first');
  const queued = await h.dormantInput('pre-restart-second');
  assert.equal(queued.admitted, false);
  await h.app.turns.terminal({ source: { kind: 'internal', key: 'pre-restart-first-terminal' },
    turnId: first.turnId, terminalStatus: 'cancelled', reason: 'Fixture restart between terminal commit and admission' });
  assert.deepEqual(await rows(h.app, 'Turn', { conversation_id: h.conversationId, status: 'active' }), []);
  return queued;
}

const localBusyError = () => Object.assign(new Error('Temporary local writer contention'), { code: 'SQLITE_BUSY' });

export const scenario1 = async getRuntime => {
    await withHarness(getRuntime, async h => {
      const queued = await queueAfterTerminal(h);
      const owners = h.app.database.conversationOwners;
      const tryClaim = owners.tryClaimEligible.bind(owners);
      let blockedNow = true;
      let admissionClaims = 0;
      owners.tryClaimEligible = async id => {
        assert.equal(id, h.conversationId);
        admissionClaims += 1;
        return blockedNow ? 'busy' : tryClaim(id);
      };
      // Commit-triggered idle sweeps also ask the eligibility probe whether to keep an owner.
      // Force those unrelated checks before recovery; they must not be mistaken for admission
      // retries or make this bound depend on whether a background cleanup timer happened to run.
      await owners.sweepIdle();
      await owners.sweepIdle();
      assert.equal(admissionClaims, 0, 'idle cleanup never attempts queued admission');
      await h.runner.recoverStartup(undefined, h.conversationId);
      assert.ok(h.runner.admissionRetries.get(h.conversationId)?.timer, 'the queued-only candidate retains its retry timer');
      assert.equal(h.runner.admissionRetries.get(h.conversationId).failures, 1);
      assert.equal(admissionClaims, 1, 'the initial recovery pass attempts admission exactly once before backoff');
      assert.equal(h.providerCalls, 0);
      blockedNow = false;
      // Only the existing backoff timer may wake admission; no resume, rescan, or new input.
      await eventually(async () => (await rows(h.app, 'TurnIntent', { id: queued.intentId }))[0].state === 'admitted', 'queue did not recover');
      await h.runner.waitForIdle();
      assert.equal(h.providerCalls, 1);
      assert.equal(h.runner.admissionRetries.size, 0);
      assert.deepEqual(h.errors, []);
    });
  };

export const scenario2 = async getRuntime => {
    await withHarness(getRuntime, async h => {
      const original = h.app.turnOutput.appendAssistantMessage.bind(h.app.turnOutput);
      let attempts = 0;
      h.app.turnOutput.appendAssistantMessage = async input => {
        attempts += 1;
        if (attempts === 1) {
          await original(input);
          throw localBusyError();
        }
        return original(input);
      };
      const input = await h.runner.input({ commandId: 'local-output-after-commit', conversationId: h.conversationId, text: '完成回答。' });
      await h.runner.waitForIdle();
      const [termination] = await rows(h.app, 'TurnTermination', { turn_id: input.turnId });
      assert.equal(termination.terminal_status, 'completed');
      assert.equal(h.providerCalls, 1, 'completed checkpoint is replayed locally');
      assert.equal(attempts, 2);
      const links = await rows(h.app, 'MessageTurnLink', { turn_id: input.turnId });
      assert.equal(links.filter(link => link.role === 'model').length, 1, 'the exact output identity is retained');
      assert.deepEqual(h.errors, []);
    });
  };

export const scenario3 = async getRuntime => {
  await withHarness(getRuntime, async h => {
    const failed = gate();
    let attempts = 0;
    h.app.turnOutput.appendAssistantMessage = async () => {
      attempts += 1;
      failed.resolve();
      throw localBusyError();
    };
    const input = await h.runner.input({ commandId: 'local-output-stop', conversationId: h.conversationId, text: '完成回答。' });
    await failed.promise;
    await h.runner.interrupt({ commandId: 'stop-local-retry', conversationId: h.conversationId, turnId: input.turnId, reason: 'User stopped local recovery' });
    await h.runner.waitForIdle();
    assert.equal((await rows(h.app, 'TurnTermination', { turn_id: input.turnId }))[0].terminal_status, 'interrupted');
    assert.equal(h.providerCalls, 1);
    assert.ok(attempts < 9, 'interrupt did not wait for the recovery budget');
  });
};
