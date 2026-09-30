import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { once } from 'node:events';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const { captureFilePlanningRoot, withFileMutationTargets } = require(path.join(compiled, 'backend/reliableKernel/fileTargetBoundary.js'));
const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
const rows = async (database, domain, where = {}) => (await database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-file-integrity-'));
  let database;
  try {
    const root = path.join(temporary, 'workspace');
    await fs.mkdir(root);
    const authority = new kernel.RootAuthority(() => path.join(temporary, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    database = await kernel.RuntimeDatabase.open(authority);
    const store = new kernel.ContentAddressedStore(authority, database.binding);
    const effects = new kernel.EffectControlPlane(database, store);
    const files = new kernel.FileChangeControlPlane(database, store, effects);
    const now = new Date().toISOString();
    await database.transaction([
      repo('Conversation').insert({ id: 'conversation', title: 'File integrity fixture', status: 'active', created_at: now, updated_at: now }),
      repo('Turn').insert({ id: 'turn', conversation_id: 'conversation', status: 'active', created_at: now, updated_at: now, terminal_at: null }),
      repo('ExecutionLease').insert({ id: 'lease', conversation_id: 'conversation', turn_id: 'turn', owner_id: 'fixture', host_boot_id: database.hostBootId,
        generation: 1n, acquired_at: now, expires_at: new Date(Date.now() + 600_000).toISOString() })
    ]);
    let sequence = 0;
    const resolver = id => ({ id, rootPath: root });
    const planner = new kernel.LocalFileToolPlanner(input => kernel.resolvePathInsideBoundary('workspace', root, input));
    const propose = async (name, args) => {
      const id = `tool-${++sequence}`;
      await effects.createToolCall({ source: { kind: 'internal', key: `create-${id}` }, toolCallId: id, turnId: 'turn', toolName: name, arguments: args });
      const members = await planner.plan({ declaration: { name } }, { arguments: args }, {});
      const proposal = await files.propose({ source: { kind: 'internal', key: `propose-${id}` }, toolCallId: id, members });
      return { id, members, proposal };
    };
    const approve = async (name, args) => {
      const call = await propose(name, args);
      const decision = await files.decide({ source: { kind: 'command', key: `approve-${call.id}` }, changeSetId: call.proposal.changeSetId, decision: 'approved' });
      return { ...call, effect: decision.preparedEffect.effectIntentId };
    };
    await run({ temporary, root, database, store, effects, files, resolver, planner, approve, propose,
      dispatcher: new kernel.FileMutationDispatcher(database, store, effects, resolver) });
  } finally {
    if (database) await database.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

test('target CAS wait never overwrites a newer editor write', async () => fixture(async h => {
  const target = path.join(h.root, 'note.txt');
  await fs.writeFile(target, 'base');
  const call = await h.approve('write', { path: 'note.txt', content: 'approved' });
  const request = await h.effects.readEffectRequest(call.effect);
  const original = h.store.read.bind(h.store);
  let injected = false;
  h.store.read = async metadata => {
    const bytes = await original(metadata);
    if (metadata.id === request.members[0].targetContentObjectId && !injected) {
      injected = true;
      await fs.writeFile(target, 'newer editor content');
    }
    return bytes;
  };
  const observed = await h.dispatcher.dispatchRecordAndReconcile(call.effect);
  assert.equal(injected, true);
  assert.equal(observed.observation.outcome, 'conflict');
  assert.equal(observed.terminal.status, 'conflict');
  assert.equal(await fs.readFile(target, 'utf8'), 'newer editor content');
}));

test('different dispatcher instances serialize the same target across CAS waits', async () => fixture(async h => {
  const target = path.join(h.root, 'note.txt');
  await fs.writeFile(target, 'base');
  const first = await h.approve('write', { path: 'note.txt', content: 'first' });
  const second = await h.approve('write', { path: 'note.txt', content: 'second' });
  const firstRequest = await h.effects.readEffectRequest(first.effect);
  const secondRequest = await h.effects.readEffectRequest(second.effect);
  const entered = deferred(), release = deferred();
  const original = h.store.read.bind(h.store);
  let secondReads = 0;
  h.store.read = async metadata => {
    const bytes = await original(metadata);
    if (metadata.id === firstRequest.members[0].targetContentObjectId) { entered.resolve(); await release.promise; }
    if (metadata.id === secondRequest.members[0].targetContentObjectId) secondReads++;
    return bytes;
  };
  const firstDispatch = h.dispatcher.dispatchRecordAndReconcile(first.effect);
  await entered.promise;
  const other = new kernel.FileMutationDispatcher(h.database, h.store, h.effects, h.resolver);
  const secondDispatch = other.dispatchRecordAndReconcile(second.effect);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(secondReads, 0);
  release.resolve();
  const results = await Promise.all([firstDispatch, secondDispatch]);
  assert.deepEqual(results.map(result => result.observation.outcome), ['succeeded', 'conflict']);
  assert.equal(await fs.readFile(target, 'utf8'), 'first');
}));

for (const change of ['symlink', 'directory-identity']) {
  test(`approval persists the planning root and rejects changed ${change}`, async () => fixture(async h => {
    let physical = h.root;
    if (change === 'symlink') {
      physical = path.join(h.temporary, 'physical-root');
      await fs.rename(h.root, physical);
      await fs.symlink(physical, h.root, 'junction');
    }
    const call = await h.approve('write', { path: 'approved.txt', content: 'approved for old root' });
    const proposalRequest = (await rows(h.database, 'InteractionRequest', { id: call.proposal.interactionRequestId }))[0];
    const proposalBody = JSON.parse((await h.store.read((await rows(h.database, 'ContentObject', { id: proposalRequest.prompt_object_id }))[0])).toString('utf8'));
    assert.deepEqual(proposalBody.members[0].planningRoot, await captureFilePlanningRoot(h.root));
    if (change === 'symlink') {
      const other = path.join(h.temporary, 'other-root');
      await fs.mkdir(other);
      await fs.unlink(h.root);
      await fs.symlink(other, h.root, 'junction');
    } else {
      await fs.rename(h.root, `${h.root}-retired`);
      await fs.mkdir(h.root);
    }
    const rebuilt = new kernel.FileMutationDispatcher(h.database, h.store, h.effects, h.resolver);
    const result = await rebuilt.dispatchRecordAndReconcile(call.effect);
    assert.equal(result.observation.outcome, 'conflict');
    assert.match(result.observation.members[0].error, /root identity changed/);
    assert.equal(await fs.stat(path.join(h.root, 'approved.txt')).then(() => true, () => false), false);
  }));
}

test('root symlink stays supported for nested directory creation', async () => fixture(async h => {
  const physical = path.join(h.temporary, 'physical-root');
  await fs.rename(h.root, physical);
  await fs.symlink(physical, h.root, 'junction');
  const call = await h.approve('write', { path: 'one/two/note.txt', content: 'approved' });
  assert.deepEqual(call.members.map(member => member.operation), ['create_directory', 'create_directory', 'create_file']);
  assert.ok(call.members.every(member => member.planningRoot.canonicalPath === physical));
  assert.equal((await h.dispatcher.dispatchRecordAndReconcile(call.effect)).terminal.status, 'succeeded');
  assert.equal(await fs.readFile(path.join(physical, 'one/two/note.txt'), 'utf8'), 'approved');
}));

for (const name of ['write', 'edit', 'delete']) {
  test(`${name} rejects intermediate symlinks before reading outside bytes`, async () => fixture(async h => {
    const outside = path.join(h.temporary, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private fixture bytes');
    await fs.symlink(outside, path.join(h.root, 'escape'), 'junction');
    const args = name === 'write' ? { path: 'escape/secret.txt', content: 'replacement' }
      : name === 'edit' ? { path: 'escape/secret.txt', insert: { line: 1, content: 'replacement' } }
      : { paths: ['escape/secret.txt'] };
    const realRead = fs.readFile;
    let contentReads = 0;
    fs.readFile = async (target, ...rest) => {
      if (String(target).endsWith('secret.txt')) contentReads++;
      return realRead(target, ...rest);
    };
    try {
      await assert.rejects(h.planner.plan({ declaration: { name } }, { arguments: args }, {}), /Symbolic-link/);
      assert.equal(contentReads, 0);
    } finally { fs.readFile = realRead; }
  }));
}

test('delete repeats content and root fences after initial inspection', async () => fixture(async h => {
  const target = path.join(h.root, 'delete.txt');
  await fs.writeFile(target, 'base');
  const call = await h.approve('delete', { paths: ['delete.txt'] });
  let checks = 0;
  const dispatcher = new kernel.FileMutationDispatcher(h.database, h.store, h.effects, async id => {
    if (++checks === 2) await fs.writeFile(target, 'newer content');
    return h.resolver(id);
  });
  const result = await dispatcher.dispatchRecordAndReconcile(call.effect);
  assert.equal(result.observation.outcome, 'conflict');
  assert.equal(await fs.readFile(target, 'utf8'), 'newer content');
}));

test('a new proposal without planning evidence fails closed', async () => fixture(async h => {
  await h.effects.createToolCall({ source: { kind: 'internal', key: 'no-evidence-tool' }, toolCallId: 'no-evidence-tool', turnId: 'turn', toolName: 'write', arguments: {} });
  await assert.rejects(h.files.propose({ source: { kind: 'internal', key: 'no-evidence-proposal' }, toolCallId: 'no-evidence-tool',
    members: [{ operation: 'create_file', workEnvironmentId: 'workspace', targetPath: 'not-written.txt', targetContent: 'no' }] }), /planningRoot/);
  assert.equal((await rows(h.database, 'FileChangeSet')).length, 0);
}));

for (const overlap of ['same-root', 'nested-root']) {
test(`separate cooperating host processes serialize ${overlap} claims and allow unrelated roots`, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-file-host-lock-'));
  const children = [];
  try {
    await fs.mkdir(path.join(temporary, 'workspace', 'nested'), { recursive: true });
    await fs.mkdir(path.join(temporary, 'other'));
    const coordination = path.join(temporary, 'coordination');
    await fs.mkdir(coordination);
    const root = await captureFilePlanningRoot(path.join(temporary, 'workspace'));
    const nested = await captureFilePlanningRoot(path.join(temporary, 'workspace', 'nested'));
    const unrelated = await captureFilePlanningRoot(path.join(temporary, 'other'));
    const target = path.join(nested.canonicalPath, 'note.txt');
    const code = `const { withFileMutationTargets } = require(${JSON.stringify(path.join(compiled, 'backend/reliableKernel/fileTargetBoundary.js'))});
      process.send('ready'); process.once('message', async data => {
        process.send('waiting');
        try { await withFileMutationTargets([{ root: data.root, target: data.target }], async () => {
          process.send('entered'); await new Promise(resolve => process.once('message', resolve));
        }); process.send('released'); process.disconnect(); } catch(error) { process.send({ error: error.message }); process.exitCode=1; process.disconnect(); }
      });`;
    const start = async () => {
      const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, TMPDIR: coordination, TMP: coordination, TEMP: coordination } });
      children.push(child);
      const events = [];
      child.on('message', value => events.push(value));
      await once(child, 'message');
      return { child, events };
    };
    const first = await start(), second = await start(), third = await start();
    const waitFor = async (entry, value) => {
      while (!entry.events.includes(value)) {
        if (entry.events.some(event => event?.error)) assert.fail(JSON.stringify(entry.events));
        await once(entry.child, 'message');
      }
    };
    first.child.send({ root, target });
    await waitFor(first, 'entered');
    second.child.send({ root: overlap === 'same-root' ? root : nested, target });
    await waitFor(second, 'waiting');
    third.child.send({ root: unrelated, target: path.join(unrelated.canonicalPath, 'note.txt') });
    await waitFor(third, 'entered');
    third.child.send('release');
    await waitFor(third, 'released');
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(second.events.includes('entered'), false);
    first.child.send('release');
    await waitFor(first, 'released');
    await waitFor(second, 'entered');
    second.child.send('release');
    await waitFor(second, 'released');
    await Promise.all(children.map(child => child.exitCode === null ? once(child, 'exit') : undefined));
    assert.ok(children.every(child => child.exitCode === 0));
  } finally {
    for (const child of children) { if (child.connected) child.send('release'); }
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
}

// Model an unfenced persisted payload from before root identity was part of the proposal contract.
async function removeHistoricalPlanningEvidence(h, call) {
  const rewrite = async (domain, id, column) => {
    const row = (await rows(h.database, domain, { id }))[0];
    const metadata = (await rows(h.database, 'ContentObject', { id: row[column] }))[0];
    const payload = JSON.parse((await h.store.read(metadata)).toString('utf8'));
    for (const member of payload.members) delete member.planningRoot;
    const content = await h.store.prepare(h.database, JSON.stringify(payload), metadata.content_type);
    await h.database.transaction([...kernel.preparedContentSteps([content], 'historical-fixture'), repo(domain).update(id, { [column]: content.metadata.id })]);
  };
  await rewrite('InteractionRequest', call.proposal.interactionRequestId, 'prompt_object_id');
  if (call.effect) await rewrite('EffectIntent', call.effect, 'request_object_id');
}

test('completed historical unfenced proposals remain readable and reconciled without workspace reads', async () => fixture(async h => {
  const call = await h.approve('write', { path: 'history.txt', content: 'historical content' });
  const complete = await h.dispatcher.dispatchRecordAndReconcile(call.effect);
  assert.equal(complete.terminal.status, 'succeeded');
  await removeHistoricalPlanningEvidence(h, { ...call, effect: undefined });
  const members = await h.files.readToolDiffMembers(call.id);
  assert.equal(members[0].targetContent.toString('utf8'), 'historical content');
  const receipt = (await rows(h.database, 'EffectReceipt'))[0];
  assert.equal((await h.files.reconcileEffectReceipt(receipt.id)).status, 'succeeded');
}));

test('pending historical unfenced proposals stay cancellable', async () => fixture(async h => {
  const call = await h.propose('write', { path: 'old-pending.txt', content: 'must not write' });
  await removeHistoricalPlanningEvidence(h, call);
  assert.equal((await h.files.readToolDiffMembers(call.id)).length, 1);
  const decision = await h.files.decide({ source: { kind: 'command', key: 'cancel-old-proposal' }, changeSetId: call.proposal.changeSetId, decision: 'cancelled' });
  assert.equal(decision.terminal.status, 'cancelled');
  assert.equal(await fs.stat(path.join(h.root, 'old-pending.txt')).then(() => true, () => false), false);
}));

test('new dispatch of historical unfenced approval durably conflicts without consulting workspace', async () => fixture(async h => {
  const call = await h.approve('write', { path: 'old-approved.txt', content: 'must not write' });
  await removeHistoricalPlanningEvidence(h, call);
  let resolutions = 0;
  const dispatcher = new kernel.FileMutationDispatcher(h.database, h.store, h.effects, () => { resolutions++; throw new Error('workspace must not be inspected'); });
  const result = await dispatcher.dispatchRecordAndReconcile(call.effect);
  assert.equal(result.terminal.status, 'conflict');
  assert.equal(result.observation.outcome, 'conflict');
  assert.match(result.observation.members[0].error, /planning.*replan/i);
  assert.equal(resolutions, 0);
  assert.equal((await rows(h.database, 'EffectReceipt'))[0].outcome, 'conflict');
  assert.equal(await fs.stat(path.join(h.root, 'old-approved.txt')).then(() => true, () => false), false);
}));

test('recovery of historical unfenced dispatched work records unknown without replay or workspace reads', async () => fixture(async h => {
  const call = await h.approve('write', { path: 'old-dispatched.txt', content: 'must not write' });
  await removeHistoricalPlanningEvidence(h, call);
  await h.effects.claimEffectDispatch(call.effect);
  let resolutions = 0;
  const result = await h.files.recoverDispatchedEffect({ source: { kind: 'recovery', key: 'old-unfenced-recovery' }, effectIntentId: call.effect,
    resolver() { resolutions++; throw new Error('workspace must not be inspected'); } });
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(resolutions, 0);
  assert.equal((await rows(h.database, 'EffectReceipt'))[0].outcome, 'outcome_unknown');
}));

test('cancellation while queued for a shared target settles cancelled without inspecting the workspace', async () => fixture(async h => {
  const call = await h.approve('write', { path: 'cancelled.txt', content: 'must not write' });
  const entered = deferred(), release = deferred();
  const planningRoot = await captureFilePlanningRoot(h.root);
  const holder = withFileMutationTargets([{ root: planningRoot, target: path.join(h.root, 'cancelled.txt') }], async () => {
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  const abort = new AbortController();
  let inspected = 0;
  const dispatcher = new kernel.FileMutationDispatcher(h.database, h.store, h.effects, () => { inspected++; throw new Error('workspace must not be inspected'); });
  try {
    const pending = dispatcher.dispatchRecordAndReconcile(call.effect, abort.signal);
    while ((await rows(h.database, 'EffectIntent', { id: call.effect }))[0].dispatch_state !== 'dispatched') await new Promise(resolve => setTimeout(resolve, 2));
    abort.abort(new Error('cancel queued file mutation'));
    const result = await pending;
    assert.equal(result.terminal.status, 'cancelled');
    assert.equal(result.observation.outcome, 'cancelled');
    assert.equal(inspected, 0);
    assert.equal(await fs.stat(path.join(h.root, 'cancelled.txt')).then(() => true, () => false), false);
  } finally { release.resolve(); await holder; }
}));

for (const mutation of ['target', 'root', 'member-tail']) {
  test(`effect request ${mutation} substitution cannot escape its complete approved proposal`, async () => fixture(async h => {
    const call = await h.approve('write', { path: 'one/two/note.txt', content: 'approved' });
    const intent = (await rows(h.database, 'EffectIntent', { id: call.effect }))[0];
    const payload = await h.effects.readEffectRequest(call.effect);
    if (mutation === 'target') payload.members[0].targetPath = 'not-approved';
    else if (mutation === 'root') payload.members[0].planningRoot.canonicalPath = h.temporary;
    else payload.members.pop();
    const content = await h.store.prepare(h.database, JSON.stringify(payload), 'application/vnd.limcode.effect-file_mutation+json');
    await h.database.transaction([...kernel.preparedContentSteps([content], 'corrupted-effect-fixture'), repo('EffectIntent').update(intent.id, { request_object_id: content.metadata.id })]);
    let inspected = 0;
    const dispatcher = new kernel.FileMutationDispatcher(h.database, h.store, h.effects, () => { inspected++; throw new Error('workspace must not be inspected'); });
    const result = await dispatcher.dispatchRecordAndReconcile(call.effect);
    assert.equal(result.terminal.status, 'conflict');
    assert.match(result.observation.members[0].error, /complete approved proposal/);
    assert.equal(inspected, 0);
    assert.deepEqual(await fs.readdir(h.root), []);
  }));
}

test('approving a historical unfenced proposal reaches replan conflict without mutation', async () => fixture(async h => {
  const call = await h.propose('write', { path: 'old-pending.txt', content: 'must not write' });
  await removeHistoricalPlanningEvidence(h, call);
  const approved = await h.files.decide({ source: { kind: 'command', key: 'approve-old-pending' }, changeSetId: call.proposal.changeSetId, decision: 'approved' });
  const result = await h.dispatcher.dispatchRecordAndReconcile(approved.preparedEffect.effectIntentId);
  assert.equal(result.terminal.status, 'conflict');
  assert.match(result.observation.members[0].error, /planning.*replan/i);
  assert.deepEqual(await fs.readdir(h.root), []);
}));

for (const kind of ['active', 'admission']) {
  test(`file mutation registry recovers a verified dead ${kind} owner in an isolated namespace`, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-file-dead-claim-'));
    const children = [];
    try {
      const coordination = path.join(temporary, 'coordination');
      await fs.mkdir(coordination);
      const root = await captureFilePlanningRoot(temporary);
      const code = `const fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto');
        const {withFileMutationTargets}=require(${JSON.stringify(path.join(compiled, 'backend/reliableKernel/fileTargetBoundary.js'))});
        const {tryPublishClaimRecord,ownProcessStartIdentity}=require(${JSON.stringify(path.join(compiled, 'backend/reliableKernel/runtimeClaimPrimitives.js'))});
        process.send('ready'); process.once('message',async config=>{try {
          const hold=async()=>{process.send('entered');await new Promise(resolve=>process.once('message',message=>{if(message==='exit')process.exit(0);resolve();}));};
          if(config.kind==='admission') {const namespace=path.join(os.tmpdir(),'limcode-file-mutations-'+(process.getuid?.()??'user'));await fs.mkdir(namespace,{recursive:true});
            const record={kind:'file-mutation-admission',ownerToken:crypto.randomUUID(),processId:process.pid,processStartIdentity:ownProcessStartIdentity(),roots:[]};
            await tryPublishClaimRecord(path.join(namespace,'admission'),'owner.json',JSON.stringify(record));await hold();
          } else await withFileMutationTargets([{root:config.root,target:path.join(config.root.canonicalPath,'note.txt')}],hold);
          process.send('released');process.disconnect();
        }catch(error){process.send({error:error.message});process.exitCode=1;process.disconnect();}});`;
      const start = async () => {
        const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, TMPDIR: coordination, TMP: coordination, TEMP: coordination } });
        children.push(child);
        const events = [];
        child.on('message', value => events.push(value));
        await once(child, 'message');
        return { child, events };
      };
      const waitFor = async (entry, expected) => {
        while (!entry.events.includes(expected)) {
          if (entry.events.some(event => event?.error)) assert.fail(JSON.stringify(entry.events));
          await once(entry.child, 'message');
        }
      };
      const crashed = await start();
      crashed.child.send({ kind, root });
      await waitFor(crashed, 'entered');
      crashed.child.send('exit'); // The fixture exits itself; no signals are sent to any process.
      await once(crashed.child, 'exit');
      const recovered = await start();
      recovered.child.send({ kind: 'active', root });
      await waitFor(recovered, 'entered');
      recovered.child.send('release');
      await waitFor(recovered, 'released');
      await once(recovered.child, 'exit');
      assert.equal(recovered.child.exitCode, 0);
    } finally {
      for (const child of children) if (child.connected) child.send('release');
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
}

for (const replacement of ['inode', 'symlink']) {
  test(`replacement ${replacement} substitution at open preserves the substitute`, async () => fixture(async h => {
    const target = path.join(h.root, 'note.txt');
    const outside = path.join(h.temporary, 'outside.txt');
    await fs.writeFile(target, 'base');
    await fs.writeFile(outside, 'outside content');
    const call = await h.approve('write', { path: 'note.txt', content: 'approved' });
    const originalOpen = fs.open;
    let substituted = false;
    fs.open = async (input, ...rest) => {
      if (String(input) === target && typeof rest[0] === 'number' && (rest[0] & constants.O_RDWR) === constants.O_RDWR && !substituted) {
        substituted = true;
        await fs.rename(target, `${target}.previous`);
        if (replacement === 'inode') await fs.writeFile(target, 'substitute content');
        else await fs.symlink(outside, target, 'file');
      }
      return originalOpen(input, ...rest);
    };
    try {
      const result = await h.dispatcher.dispatchRecordAndReconcile(call.effect);
      assert.equal(substituted, true);
      assert.ok(['conflict', 'failed'].includes(result.observation.outcome));
      assert.equal(await fs.readFile(target, 'utf8'), replacement === 'inode' ? 'substitute content' : 'outside content');
      assert.equal(await fs.readFile(outside, 'utf8'), 'outside content');
    } finally { fs.open = originalOpen; }
  }));
}

test('parent symlink substitution on final boundary fence leaves outside bytes untouched', async () => fixture(async h => {
  const directory = path.join(h.root, 'sub');
  const outside = path.join(h.temporary, 'outside');
  await fs.mkdir(directory);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(directory, 'note.txt'), 'base');
  await fs.writeFile(path.join(outside, 'note.txt'), 'outside content');
  const call = await h.approve('write', { path: 'sub/note.txt', content: 'approved' });
  let checks = 0;
  const dispatcher = new kernel.FileMutationDispatcher(h.database, h.store, h.effects, async id => {
    if (++checks === 2) {
      await fs.rename(directory, `${directory}.previous`);
      await fs.symlink(outside, directory, 'junction');
    }
    return h.resolver(id);
  });
  const result = await dispatcher.dispatchRecordAndReconcile(call.effect);
  assert.equal(result.observation.outcome, 'conflict');
  assert.equal(await fs.readFile(path.join(outside, 'note.txt'), 'utf8'), 'outside content');
  assert.equal(await fs.readFile(path.join(`${directory}.previous`, 'note.txt'), 'utf8'), 'base');
}));

test('replacement rejects a non-regular opened handle before attempting any content read', async () => fixture(async h => {
  const target = path.join(h.root, 'note.txt');
  await fs.writeFile(target, 'base');
  const call = await h.approve('write', { path: 'note.txt', content: 'approved' });
  const originalOpen = fs.open;
  let targetReads = 0;
  fs.open = async (input, ...rest) => {
    const handle = await originalOpen(input, ...rest);
    if (String(input) === target && typeof rest[0] === 'number' && (rest[0] & constants.O_RDWR) === constants.O_RDWR) {
      const originalStat = handle.stat.bind(handle);
      handle.stat = async (...args) => {
        const stat = await originalStat(...args);
        stat.isFile = () => false; // A replaced FIFO/device must never be read, even if open succeeds.
        return stat;
      };
      handle.readFile = async () => { targetReads++; throw new Error('non-regular content read must not start'); };
    }
    return handle;
  };
  try {
    const result = await h.dispatcher.dispatchRecordAndReconcile(call.effect);
    assert.equal(result.observation.outcome, 'conflict');
    assert.equal(targetReads, 0);
    assert.equal(await fs.readFile(target, 'utf8'), 'base');
  } finally { fs.open = originalOpen; }
}));

for (const stage of ['planning', 'dispatch']) {
  test(`${stage} rejects a post-stat symlink substitution before reading the substituted path`, async () => fixture(async h => {
    const target = path.join(h.root, 'note.txt');
    const outside = path.join(h.temporary, 'outside.txt');
    await fs.writeFile(target, 'base');
    await fs.writeFile(outside, 'outside private fixture');
    const call = stage === 'dispatch' ? await h.approve('write', { path: 'note.txt', content: 'approved' }) : undefined;
    const originalStat = fs.lstat, originalRead = fs.readFile;
    let targetStats = 0, pathReads = 0;
    fs.lstat = async (input, ...rest) => {
      const stat = await originalStat(input, ...rest);
      if (String(input) === target && rest[0]?.bigint === true && ++targetStats === 1) {
        await fs.rename(target, `${target}.previous`);
        await fs.symlink(outside, target, 'file');
      }
      return stat;
    };
    fs.readFile = async (input, ...rest) => {
      if (String(input) === target) pathReads++;
      return originalRead(input, ...rest);
    };
    try {
      if (stage === 'planning') {
        await assert.rejects(h.planner.plan({ declaration: { name: 'write' } }, { arguments: { path: 'note.txt', content: 'approved' } }, {}), /Symbolic-link|changed/);
      } else {
        const result = await h.dispatcher.dispatchRecordAndReconcile(call.effect);
        assert.equal(result.observation.outcome, 'conflict');
      }
      assert.equal(pathReads, 0, 'a path already proven substituted must never be read');
      assert.equal(await originalRead(outside, 'utf8'), 'outside private fixture');
    } finally { fs.lstat = originalStat; fs.readFile = originalRead; }
  }));
}

for (const stage of ['planning', 'dispatch']) {
  test(`${stage} rejects a substituted FIFO without blocking or reading it`, { skip: process.platform === 'win32' || !constants.O_NONBLOCK, timeout: 10_000 }, async () => fixture(async h => {
    const target = path.join(h.root, 'note.txt');
    await fs.writeFile(target, 'base');
    const call = stage === 'dispatch' ? await h.approve('write', { path: 'note.txt', content: 'approved' }) : undefined;
    const originalStat = fs.lstat;
    let targetStats = 0;
    fs.lstat = async (input, ...rest) => {
      const stat = await originalStat(input, ...rest);
      if (String(input) === target && rest[0]?.bigint === true && ++targetStats === 1) {
        await fs.rename(target, `${target}.previous`);
        await new Promise((resolve, reject) => execFile('mkfifo', [target], error => error ? reject(error) : resolve()));
      }
      return stat;
    };
    try {
      if (stage === 'planning') {
        await assert.rejects(h.planner.plan({ declaration: { name: 'write' } }, { arguments: { path: 'note.txt', content: 'approved' } }, {}), /identity or type changed/);
      } else {
        const result = await h.dispatcher.dispatchRecordAndReconcile(call.effect);
        assert.equal(result.observation.outcome, 'conflict');
      }
      assert.equal((await originalStat(target)).isFIFO(), true);
      assert.equal(await fs.readFile(`${target}.previous`, 'utf8'), 'base');
    } finally { fs.lstat = originalStat; }
  }));
}

for (const scenario of ['write-existing', 'write-create', 'edit', 'delete']) {
  test(`${scenario} preserves in-root directory aliases by approving their physical target`, async () => fixture(async h => {
    const physical = path.join(h.root, 'physical');
    await fs.mkdir(physical);
    await fs.symlink(physical, path.join(h.root, 'alias'), 'junction');
    await fs.writeFile(path.join(physical, 'note.txt'), 'base\n');
    const name = scenario.startsWith('write') ? 'write' : scenario;
    const args = scenario === 'write-create' ? { path: 'alias/new/deep/note.txt', content: 'created' }
      : scenario === 'write-existing' ? { path: 'alias/note.txt', content: 'updated' }
      : scenario === 'edit' ? { path: 'alias/note.txt', insert: { line: 1, content: 'inserted\n' } }
      : { paths: ['alias/note.txt'] };
    const call = await h.approve(name, args);
    assert.ok(call.members.every(member => member.targetPath.startsWith('physical/')));
    const result = await h.dispatcher.dispatchRecordAndReconcile(call.effect);
    assert.equal(result.terminal.status, 'succeeded');
    if (scenario === 'delete') assert.equal(await fs.stat(path.join(physical, 'note.txt')).then(() => true, () => false), false);
    else if (scenario === 'write-create') assert.equal(await fs.readFile(path.join(physical, 'new/deep/note.txt'), 'utf8'), 'created');
    else if (scenario === 'write-existing') assert.equal(await fs.readFile(path.join(physical, 'note.txt'), 'utf8'), 'updated');
    else assert.match(await fs.readFile(path.join(physical, 'note.txt'), 'utf8'), /inserted/);
  }));
}

test('an in-root alias retargeted during planning is rejected before descriptor content is read', async () => fixture(async h => {
  const first = path.join(h.root, 'first'), second = path.join(h.root, 'second'), alias = path.join(h.root, 'alias');
  await fs.mkdir(first); await fs.mkdir(second);
  await fs.writeFile(path.join(first, 'note.txt'), 'first');
  await fs.writeFile(path.join(second, 'note.txt'), 'second');
  await fs.symlink(first, alias, 'junction');
  const originalOpen = fs.open;
  let contentReads = 0, retargeted = false;
  fs.open = async (input, ...rest) => {
    const handle = await originalOpen(input, ...rest);
    if (String(input) === path.join(first, 'note.txt') && !retargeted) {
      retargeted = true;
      await fs.unlink(alias); await fs.symlink(second, alias, 'junction');
      const originalRead = handle.readFile.bind(handle);
      handle.readFile = (...args) => { contentReads++; return originalRead(...args); };
    }
    return handle;
  };
  try {
    await assert.rejects(h.planner.plan({ declaration: { name: 'write' } }, { arguments: { path: 'alias/note.txt', content: 'approved' } }, {}), /alias changed its physical target/);
    assert.equal(retargeted, true);
    assert.equal(contentReads, 0);
  } finally { fs.open = originalOpen; }
}));

test('an alias retarget after approval cannot redirect the approved physical write', async () => fixture(async h => {
  const first = path.join(h.root, 'first'), second = path.join(h.root, 'second'), alias = path.join(h.root, 'alias');
  await fs.mkdir(first); await fs.mkdir(second);
  await fs.writeFile(path.join(first, 'note.txt'), 'base');
  await fs.writeFile(path.join(second, 'note.txt'), 'base');
  await fs.symlink(first, alias, 'junction');
  const call = await h.approve('write', { path: 'alias/note.txt', content: 'approved for first' });
  assert.equal(call.members[0].targetPath, 'first/note.txt');
  await fs.unlink(alias); await fs.symlink(second, alias, 'junction');
  const result = await h.dispatcher.dispatchRecordAndReconcile(call.effect);
  assert.equal(result.terminal.status, 'succeeded');
  assert.equal(await fs.readFile(path.join(first, 'note.txt'), 'utf8'), 'approved for first');
  assert.equal(await fs.readFile(path.join(second, 'note.txt'), 'utf8'), 'base');
}));

for (const name of ['write', 'edit', 'delete']) {
  test(`${name} still rejects final file symlinks even when their target is inside the root`, async () => fixture(async h => {
    await fs.writeFile(path.join(h.root, 'physical.txt'), 'base');
    await fs.symlink(path.join(h.root, 'physical.txt'), path.join(h.root, 'linked.txt'), 'file');
    const args = name === 'write' ? { path: 'linked.txt', content: 'approved' }
      : name === 'edit' ? { path: 'linked.txt', insert: { line: 1, content: 'approved' } }
      : { paths: ['linked.txt'] };
    await assert.rejects(h.planner.plan({ declaration: { name } }, { arguments: args }, {}), /Symbolic-link file targets/);
    assert.equal(await fs.readFile(path.join(h.root, 'physical.txt'), 'utf8'), 'base');
  }));
}
