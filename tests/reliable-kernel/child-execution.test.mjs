import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { load, kernel, repo, gate, policy, openChildFixture, taskToolsFixture } from './child-execution-fixture.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { boundChildToolPolicy, boundChildSkillPolicy, frozenToolPolicyDocument, inheritedToolPolicyChain } = load('backend/reliableKernel/childExecutionBoundary.js');
const { toolAllowedByPolicy } = load('shared/toolPolicyResolution.js');
const { isSkillEnabledByPolicy } = load('backend/world/modules/skill/policy.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { splitPreloadedSkills } = load('backend/reliableKernel/childSkillPreload.js');
const { prepareCollaborationCapacity } = load('backend/reliableKernel/collaborationCapacity.js');
const { executeConversationChildTaskSnapshot } = load('backend/reliableKernel/childTaskFactsSnapshot.js');
let f;
before(async () => { f = await openChildFixture(); });
after(async () => { await f?.close(); });

// One immutable authority graph, rather than a matrix over spawn/send/edit/provider entry points.
test('child permissions and approval respect the complete frozen ancestor chain', async () => {
  const top = policy({ id: 'top', allowedTools: ['read', 'write'], sourceConfigs: { exa: { enabled: true, enabledTools: ['search'] } },
    toolConfigs: { write: { config: {}, autoApproveExecution: false, autoApplyChange: false } } });
  const middle = boundChildToolPolicy(policy({ id: 'middle', allowedTools: ['read', 'write', 'skills'], sourceConfigs: { exa: { enabled: true } } }), top);
  const leaf = boundChildToolPolicy(policy({ id: 'leaf', preset: 'yolo', sourceConfigs: { exa: { enabled: true }, other: { enabled: true } } }), frozenToolPolicyDocument({ toolPolicy: middle }));
  assert.deepEqual(leaf.allowedTools, ['read', 'write']);
  assert.deepEqual(inheritedToolPolicyChain(leaf).map(layer => layer.preset), ['custom', 'custom']);
  assert.equal(toolAllowedByPolicy(leaf, { name: 'other_search', source: { kind: 'mcp', sourceId: 'other', originalToolName: 'search' } }), false);
  const dispatcher = { authorityCache: new Map([['turn', Promise.resolve({ snapshotId: 'authority', document: { toolPolicy: leaf } })]]) };
  const authority = await ReliableToolDispatcher.prototype.readAuthority.call(dispatcher, 'turn', { name: 'write' });
  const decision = ReliableToolDispatcher.prototype.freezeDecision.call({}, { turnId: 'turn', modelRequestId: 'request', toolCallId: 'call',
    toolName: 'write', arguments: { path: 'a.txt', content: 'x' }, definition: { name: 'write', description: 'write', parameters: {}, metadata: {} } }, undefined, authority);
  assert.equal(decision.executionGate, 'approval_required');
  assert.equal(decision.changeApplyMode, 'manual');
  const skills = boundChildSkillPolicy({ id: 'child', sourceConfigs: { claude: { enabled: false } } }, { id: 'parent', sourceConfigs: { agents: { enabled: true, disabledSkills: ['deploy'] } } });
  assert.equal(isSkillEnabledByPolicy(skills, { id: 'deploy', source: 'agents' }), false);
  assert.equal(isSkillEnabledByPolicy(skills, { id: 'lint', source: 'claude' }), false);
});

test('an externally approved Plan compiles its executor without the planner authority bound', async () => {
  const parent = await f.parent('approved-plan', policy({ allowedTools: ['read', 'submit_plan'] }));
  const turn = await f.app.turns.input(parent.input('plan'));
  const source = await f.source(turn.turnId, 'submit_plan');
  const [execution] = await f.rows('ToolExecution', { tool_call_id: source });
  await f.app.database.transaction([
    repo('ToolCall').update(source, { status: 'waiting_answer' }),
    repo('ToolExecution').update(execution.id, { status: 'waiting_answer' })
  ]);
  const child = await f.app.runtime.children.spawn({ ...f.command(source), sourceSettlement: 'external', authorityBound: 'executor_agent' });
  const compiled = f.compileRequests.find(request => request.turnId === child.childTurnId);
  assert.equal(compiled.inheritedToolPolicy, undefined);
  assert.equal(compiled.inheritedSkillPolicy, undefined);
  const [snapshot] = await f.rows('AuthoritySnapshot', { turn_id: child.childTurnId });
  const [metadata] = await f.rows('ContentObject', { id: snapshot.content_object_id });
  const document = JSON.parse((await f.app.contentStore.read(metadata)).toString('utf8'));
  assert.ok(document.toolPolicy.allowedTools.includes('write'));
  assert.equal(document.toolPolicy.inherited, undefined);
  assert.equal(document.skillPolicy.inherited, undefined);
});

test('a child lease begins after preparation and a durable replay does not grant a second generation', async () => {
  const parent = await f.parent('lease', policy({ allowedTools: ['read', 'run_agent'] }));
  const turn = await f.app.turns.input(parent.input('delegate'));
  const command = f.command(await f.source(turn.turnId));
  const before = Date.parse(f.now());
  f.preparation(31000);
  let child;
  try { child = await f.app.runtime.children.spawn(command); } finally { f.preparation(0); }
  const [lease] = await f.rows('ExecutionLease', { turn_id: child.childTurnId });
  assert.ok(Date.parse(lease.acquired_at) >= before + 31000);
  assert.equal(Date.parse(lease.expires_at) - Date.parse(lease.acquired_at), 30000);
  assert.equal(child.initialExecutionFence.id, lease.id);
  assert.equal(child.initialExecutionFence.generation, 1n);
  const [snapshot] = await f.rows('AuthoritySnapshot', { turn_id: child.childTurnId });
  const [metadata] = await f.rows('ContentObject', { id: snapshot.content_object_id });
  const frozen = JSON.parse((await f.app.contentStore.read(metadata)).toString('utf8'));
  assert.deepEqual(frozen.toolPolicy.allowedTools, ['read', 'run_agent']);
  assert.deepEqual(frozen.toolPolicy.inherited.allowedTools, ['read', 'run_agent']);
  const replay = await f.app.runtime.children.spawn(command);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.initialExecutionFence, undefined);
  assert.deepEqual((await f.rows('ExecutionLease', { id: lease.id }))[0], lease);
});

test('disposal drains an admitted child startup and releases renewal before any child drive', async () => {
  const parent = await f.parent('startup-dispose');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const source = await f.source(turn.turnId);
  const entered = gate(), release = gate();
  const coordinator = f.coordinator({ profile: async () => { entered.resolve(); await release.promise; } });
  const started = coordinator.spawnChild({ toolCallId: source, turnId: turn.turnId, toolName: 'run_agent' },
    { taskName: 'Inspect' }, 'Inspect', 0, { document: f.authority({ turnId: turn.turnId, conversationId: parent.id, executorAgentId: 'parent-agent' }) });
  const settled = started.catch(error => error);
  try {
    await entered.promise;
    assert.equal(coordinator.childLeaseRenewals.size, 1);
    let disposed = false;
    const closing = coordinator.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    assert.equal(disposed, false);
    release.resolve();
    await closing;
    assert.ok((await settled) instanceof Error);
    assert.equal(coordinator.childLeaseRenewals.size, 0);
    assert.equal(coordinator.startupOperations.size, 0);
    assert.equal(coordinator.activeTurns.size, 0);
  } finally { release.resolve(); await settled; await coordinator.dispose(); }
});

test('preloaded skills use the frozen child policy and replay the committed first input without a reload', async () => {
  const parent = await f.parent('skill-preload');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const source = await f.source(turn.turnId);
  let loads = 0, selectedPolicy;
  const skill = '<skill name="review" source=".agents">\nReview code\n</skill>';
  const command = { ...f.command(source), preloadSkills: { names: ['review'], async load(names, authority) {
    loads++; selectedPolicy = authority;
    assert.deepEqual(names, ['review']);
    return [skill];
  } } };
  const child = await f.app.runtime.children.spawn(command);
  assert.equal(isSkillEnabledByPolicy(selectedPolicy, { id: 'deploy', source: 'agents' }), false);
  const [input] = await f.rows('MessageTurnLink', { turn_id: child.childTurnId, role: 'input' });
  const [current] = await f.rows('MessageCurrentRevisionLink', { message_id: input.message_id });
  const [revision] = await f.rows('MessageRevision', { id: current.revision_id });
  const [metadata] = await f.rows('ContentObject', { id: revision.content_object_id });
  const body = (await f.app.contentStore.read(metadata)).toString('utf8');
  assert.deepEqual(splitPreloadedSkills(body), { skills: [{ name: 'review', text: skill }], prompt: command.prompt });
  const replay = await f.app.runtime.children.spawn({ ...command, preloadSkills: { names: ['review'], async load() { assert.fail('replay reloaded skill'); } } });
  assert.equal(replay.childExecutionId, child.childExecutionId);
  assert.equal(loads, 1);
});

function snapshotRead(database, request) {
  const repository = repo(request.domain);
  if (request.kind === 'get') { const row = database.prepare(`SELECT * FROM "${repository.schema.table}" WHERE id=?`).get(request.id); return row ? repository.codec.decode(row) : null; }
  const parameters = repository.codec.encodeWhere(request.where ?? {});
  const predicates = Object.entries(parameters).map(([key, value]) => value === null ? `"${key}" IS NULL` : `"${key}"=@${key}`);
  for (const [key, value] of Object.entries(parameters)) if (value === null) delete parameters[key];
  if (request.afterId) { predicates.push('id>@after'); parameters.after = request.afterId; }
  parameters.limit = BigInt(request.limit);
  return database.prepare(`SELECT * FROM "${repository.schema.table}"${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY id ASC LIMIT @limit`)
    .all(parameters).map(row => repository.codec.decode(row));
}

test('a concurrent connection commit cannot tear one child task fact snapshot', async () => {
  const parent = await f.parent('snapshot');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const child = await f.app.runtime.children.spawn(f.command(await f.source(turn.turnId)));
  const file = kernel.toSqliteFilePath(f.app.database.binding.paths.databasePath);
  const reader = new Database(file, { readonly: true }), writer = new Database(file);
  reader.defaultSafeIntegers(true); writer.defaultSafeIntegers(true);
  const snapshot = read => executeConversationChildTaskSnapshot(reader, parent.id, 0n, read ?? snapshotRead, () => { assert.fail('no queued envelope in this task'); });
  try {
    const before = snapshot();
    let changed = false;
    const during = snapshot((database, request) => {
      const values = snapshotRead(database, request);
      if (!changed && request.domain === 'Conversation') {
        changed = true;
        writer.transaction(() => {
          writer.prepare('UPDATE child_execution SET status=? WHERE id=?').run('active', child.childExecutionId);
          writer.prepare('UPDATE conversation SET title=? WHERE id=?').run('Changed child', child.childConversationId);
        })();
      }
      return values;
    });
    const after = snapshot();
    assert.equal(changed, true);
    assert.deepEqual(during.snapshot, before.snapshot);
    assert.equal(after.snapshot.childExecutions[0].status, 'active');
    assert.equal(after.snapshot.conversations[0].title, 'Changed child');
    assert.equal(after.snapshotCommitSeq, before.snapshotCommitSeq);
    assert.equal(reader.inTransaction, false);
  } finally { reader.close(); writer.close(); }
});

test('forkTurns=1 atomically inherits only the latest completed exchange and replays that exact copy', async () => {
  const parent = await f.parent('fork');
  await f.app.agentLoop.runInput(parent.input('first-completed'));
  await f.app.agentLoop.runInput(parent.input('second-completed'));
  const current = await f.app.turns.input(parent.input('still-incomplete'));
  const command = { ...f.command(await f.source(current.turnId)), forkTurns: '1' };
  const child = await f.app.runtime.children.spawn(command);
  const context = await f.app.context.materialize(await f.app.context.currentHeadRootId(child.childConversationId));
  const text = context.segments.map(segment => segment.content).join('\n');
  assert.ok(text.includes('second-completed'));
  assert.equal(text.includes('first-completed'), false);
  assert.equal(text.includes('still-incomplete'), false);
  const turns = await f.rows('Turn', { conversation_id: child.childConversationId });
  assert.equal(turns.length, 2);
  const copied = turns.find(value => value.id !== child.childTurnId);
  const [authority] = await f.rows('AuthoritySnapshot', { turn_id: copied.id });
  assert.ok(authority);
  assert.equal((await f.rows('ExecutionLease', { turn_id: copied.id })).length, 0);
  const before = await f.rows('MessagePartOfConversation', { conversation_id: child.childConversationId });
  assert.equal((await f.app.runtime.children.spawn(command)).deduplicated, true);
  assert.deepEqual(await f.rows('MessagePartOfConversation', { conversation_id: child.childConversationId }), before);
});

test('readonly child list ignores assignment arguments without spawning or sending work', async () => {
  const value = taskToolsFixture();
  const result = await value.call({ operation: 'list', prompt: 'unused assignment' });
  assert.equal(result.detail.operation, 'list');
  assert.equal(result.detail.tasks[0].answerBridgeId, 'bridge');
  assert.deepEqual(value.events, { spawns: [], sends: [], interrupts: [] });
  assert.equal(value.listeners.size, 0);
});

test('parent abort cleans its child wait subscription while the child remains active', async () => {
  const value = taskToolsFixture(), controller = new AbortController();
  const pending = value.call({ operation: 'wait', answerBridgeId: 'bridge', timeoutMs: 5000 }, controller.signal);
  const rejected = assert.rejects(pending, /parent stopped waiting/);
  await value.observed.promise;
  controller.abort(new Error('parent stopped waiting'));
  await rejected;
  assert.equal(value.task.status, 'active');
  assert.equal(value.listeners.size, 0);
  assert.deepEqual(value.events, { spawns: [], sends: [], interrupts: [] });
});

test('two child reservations compete for one frozen capacity slot and only one transaction commits', async () => {
  const parent = await f.parent('capacity');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const reserve = () => prepareCollaborationCapacity(f.app.database, f.app.contentStore, parent.id, turn.turnId);
  const [left, right] = await Promise.all([reserve(), reserve()]);
  const child = id => [repo('Conversation').insert({ id, title: id, status: 'active', created_at: f.now(), updated_at: f.now() }),
    repo('ChildExecution').insert({ id: `${id}-execution`, child_conversation_id: id, status: 'starting', created_at: f.now(), updated_at: f.now() }),
    repo('ChildExecutionParentLink').insert({ id: `${id}-parent`, child_execution_id: `${id}-execution`, parent_turn_id: turn.turnId,
      parent_child_execution_id: null, source_tool_call_id: `${id}-source`, created_at: f.now() }),
    repo('Turn').insert({ id: `${id}-turn`, conversation_id: id, status: 'active', created_at: f.now(), updated_at: f.now(), terminal_at: null })];
  const results = await Promise.allSettled([
    f.app.database.transaction([...left, ...child(`${parent.id}-left`)]),
    f.app.database.transaction([...right, ...child(`${parent.id}-right`)])
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await f.rows('ChildExecutionParentLink', { parent_turn_id: turn.turnId })).length, 1);
  await assert.rejects(reserve(), /capacity/i);
});
