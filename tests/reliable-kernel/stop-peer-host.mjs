import { load, openStopHost } from './stop-control-fixture.mjs';

const { runWithExecutionLeaseFence } = load('backend/reliableKernel/executionLeaseFence.js');

const [rootPath, mode, label] = process.argv.slice(2);
let f, ready, activeMode = mode;
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));

async function controlOnly(work) {
  const owners = f.app.database.conversationOwners;
  const eligibility = owners.executionEligibility;
  owners.executionEligibility = async () => 'ineligible';
  try { return await work(); }
  finally { owners.executionEligibility = eligibility; }
}

async function stopNow() {
  return controlOnly(() => f.runner.interrupt({ commandId: f.id('stop'), conversationId: ready.conversationId,
    turnId: ready.turnId, reason: '用户停止' }));
}

async function action(name, input) {
  if (name === 'prepare') {
    ready = await prepare(input.mode, input.label);
    activeMode = input.mode;
    return ready;
  }
  if (name === 'finish') {
    if (activeMode === 'mcp') {
      const recorded = await f.app.runtime.effects.recordEffectReceipt({ source: { kind: 'callback', key: `peer-finish:${ready.attemptId}` },
        attemptId: ready.attemptId, effectKind: 'mcp_tool_call', outcome: 'succeeded', detail: { outcome: 'succeeded', result: { content: [{ type: 'text', text: 'peer completed' }] } } });
      await f.app.mcp.reconcileEffectReceipt(recorded.effectReceiptId, 'internal');
    } else if (activeMode === 'spawn') {
      const recorded = await f.app.runtime.children.recordSpawnReceipt({ sourceKey: `peer-finish:${ready.attemptId}`, attemptId: ready.attemptId,
        outcome: 'succeeded', detail: { adapter: 'reliable-local-agent-loop' } });
      await f.app.runtime.children.reconcileSpawnReceipt(recorded.effectReceiptId);
    } else if (activeMode === 'process') await f.app.processes.stopOwnedProcess(ready.processId);
    const stopped = await stopNow();
    return { ...stopped, modelCalls: f.modelCalls.length };
  }
  if (name === 'stopNow') return stopNow();
  if (name === 'poll') {
    await controlOnly(() => f.runner.pollExternalWakes());
    await f.runner.waitForIdle();
    return { turn: await f.get('Turn', ready.turnId), errors: f.errors.map(String), modelCalls: f.modelCalls.length };
  }
  if (name === 'close') {
    if (ready.processId && (await f.get('Process', ready.processId))?.status === 'running') await f.app.processes.stopOwnedProcess(ready.processId);
    await f.close();
    return { closed: true };
  }
  throw new Error(`Unknown stop peer action ${name}`);
}

async function prepare(mode, label = mode) {
  const conversationId = await f.conversation(label);
  const admitted = await f.input(conversationId);
  const preparedReady = { conversationId, turnId: admitted.turnId, hostBootId: f.app.database.hostBootId };
  if (mode === 'mcp') {
    const source = await f.source(admitted.turnId);
    const effect = await f.app.mcp.prepare({ source: { kind: 'internal', key: f.id('prepare') }, toolCallId: source.toolCallId,
      serverId: 'fixture', toolName: 'fixture_hang', arguments: {} });
    if (effect.disposition !== 'prepared') throw new Error('Peer MCP was rejected');
    if (!await f.app.runtime.effects.claimEffectDispatch(effect.effectIntentId)) throw new Error('Peer MCP dispatch was not claimed');
    Object.assign(preparedReady, { toolCallId: source.toolCallId, intentId: effect.effectIntentId, attemptId: effect.attemptId });
  } else if (mode === 'spawn') {
    const child = await f.spawn(admitted.turnId, { receipt: false });
    Object.assign(preparedReady, { toolCallId: child.toolCallId, intentId: child.effectIntentId, attemptId: child.attemptId,
      childIds: [child.childExecutionId], childExecutionId: child.childExecutionId, childConversationId: child.childConversationId, childTurnId: child.childTurnId,
      spawned: child });
  } else if (mode === 'process') {
    const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
    const command = `${quote(process.execPath)} -e ${quote('setInterval(() => {}, 1000)')}`;
    const source = await f.source(admitted.turnId, 'bash', { mode: 'execute', command, explanation: 'Keep a real child process running', foregroundWaitMs: 0 });
    const prepared = await f.app.processes.prepareStart({ source: { kind: 'internal', key: f.id('prepare') }, toolCallId: source.toolCallId,
      command, cwd: rootPath, executionTimeoutMs: 60000, maxOutputBytes: 1024 });
    const dispatched = await f.app.processes.dispatchStart(prepared.effect.effectIntentId, 0);
    if (dispatched.observation?.state !== 'background_started') throw new Error(`Peer process failed to start: ${JSON.stringify(dispatched.observation)}`);
    const fence = await f.app.turns.heldExecutionLeaseFence({ turnId: admitted.turnId,
      leaseOwnerId: f.runner.leaseOwnerId, hostBootId: f.app.database.hostBootId });
    if (!fence) throw new Error('Peer process source Turn has no held execution lease');
    const completed = await runWithExecutionLeaseFence(fence, () => f.app.agentLoop.drive(admitted.turnId));
    if (completed.terminalStatus !== 'completed' || (await f.get('Turn', admitted.turnId)).status !== 'terminated') {
      throw new Error('Peer process source Turn did not complete');
    }
    if ((await f.get('Process', prepared.request.processId)).status !== 'running') throw new Error('Peer background process did not remain running');
    Object.assign(preparedReady, { toolCallId: source.toolCallId, intentId: prepared.effect.effectIntentId, attemptId: prepared.effect.attemptId, processId: prepared.request.processId });
  } else throw new Error(`Unknown peer mode ${mode}`);
  return preparedReady;
}

try {
  f = await openStopHost(rootPath, { label });
  ready = await prepare(mode);
  let tail = Promise.resolve();
  process.on('message', message => {
    tail = tail.then(async () => {
      try {
        const result = await action(message.action, message.input);
        await send({ kind: 'result', id: message.id, result });
        if (message.action === 'close') process.disconnect();
      } catch (error) { await send({ kind: 'error', id: message.id, error: String(error.stack ?? error) }); }
    });
  });
  await send({ kind: 'ready', ready });
} catch (error) {
  await send({ kind: 'error', error: String(error.stack ?? error) }).catch(() => undefined);
  await f?.close().catch(() => undefined);
  process.exitCode = 1;
  process.disconnect();
}
