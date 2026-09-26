import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
const Database = require('better-sqlite3');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps, projectContextIdForUri } = kernelFile('conversationProject.js');
const {
  mergeRuntimeDataSetIntoTarget, mergeRuntimeDataSetsIntoSelected, precopyRuntimeDataSetCas,
  readRuntimeDataSetMergeStates, requestRuntimeDataSetMerge
} = kernelFile('runtimeDataSetMerge.js');
const { registerExclusiveMaintenanceParticipant, requestExclusiveRuntimeMaintenance } = kernelFile('runtimeExclusiveMaintenance.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot,
  selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');
const { ownProcessStartIdentity } = kernelFile('runtimeClaimPrimitives.js');

const NOW = '2026-09-26T00:00:00.000Z';
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const SHARED_PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
const SHARED_TEXT = JSON.stringify({ role: 'user', parts: [{ text: '各工作区都用过的同一段正文' }] });

test('旧工作区库自动合并进当前库：同项目可见、正文共享、可继续写入，来源原样保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, [{ id: 'conversation_current_1', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [
    { id: 'conversation_alpha_1', project: SHARED_PROJECT },
    { id: 'conversation_alpha_2', project: { uri: 'file:///workspace/alpha', name: 'alpha' } }
  ]);
  await seed(fixture.beta, [{ id: 'conversation_beta_1', project: SHARED_PROJECT }]);
  const sourcesBefore = { alpha: await treeSnapshot(fixture.alpha.scopeRoot), beta: await treeSnapshot(fixture.beta.scopeRoot) };

  const report = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.blocked, []);
  assert.deepEqual(report.merged.map((item) => item.candidateId).sort(), [fixture.alpha.id, fixture.beta.id].sort());
  assert.equal(report.merged.reduce((sum, item) => sum + item.insertedConversations, 0), 3);
  assert.ok(report.merged.every((item) => item.recoveredCommit === false));
  assert.equal(new Set(report.merged.map((item) => item.backupPath)).size, 1, '一次启动只备份一次当前库');

  const target = readTarget(fixture.current);
  try {
    assert.deepEqual(target.conversationsFor(SHARED_PROJECT.uri),
      ['conversation_alpha_1', 'conversation_beta_1', 'conversation_current_1']);
    assert.deepEqual(target.conversationsFor('file:///workspace/alpha'), ['conversation_alpha_2']);
    assert.equal(target.count('project_context', 'id = ?', projectContextIdForUri(SHARED_PROJECT.uri)), 1);
    const sharedObjects = target.database.prepare(
      'SELECT COUNT(*) FROM content_object WHERE sha256 = ?').pluck().get(sha256(SHARED_TEXT));
    assert.equal(Number(sharedObjects), 1, '相同正文只登记一次');
    assert.equal(target.count('turn', "status = 'active'"), 0);
    assert.deepEqual(target.database.pragma('foreign_key_check'), []);
  } finally { target.close(); }

  // The alpha-only message body is a hard link of the source file, so merging costs no CAS space.
  const alphaText = messageText('conversation_alpha_2', 0);
  const sourceStat = await fs.stat(casFile(fixture.alpha.binding, alphaText));
  const targetStat = await fs.stat(casFile(fixture.current.binding, alphaText));
  assert.equal(targetStat.ino, sourceStat.ino);

  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), sourcesBefore.alpha);
  assert.deepEqual(await treeSnapshot(fixture.beta.scopeRoot), sourcesBefore.beta);

  const backup = new Database(path.join(report.merged[0].backupPath, 'limcode.sqlite'), { readonly: true });
  try { assert.equal(backup.prepare('SELECT COUNT(*) FROM conversation').pluck().get(), 1); }
  finally { backup.close(); }

  const states = await readRuntimeDataSetMergeStates(fixture.paths);
  assert.equal(states.get(fixture.alpha.id)?.state, 'merged');
  assert.equal(states.get(fixture.beta.id)?.state, 'merged');

  const again = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.equal(again.pendingSources, 0);
  assert.deepEqual(again.merged, []);

  // A merged conversation continues in the selected Runtime like any other committed row.
  const runtime = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: 'merge-continue' });
  try {
    await runtime.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: 'turn_after_merge', conversation_id: 'conversation_alpha_1', status: 'terminated',
        created_at: NOW, updated_at: NOW, terminal_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').update('conversation_alpha_1', { updated_at: '2026-09-27T00:00:00.000Z' })
    ]);
  } finally { await runtime.close(); }
});

test('未结束任务的旧库不合并、不重复提示，手动请求会重试；非工作区库只按请求合并', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_active', project: SHARED_PROJECT, activeTurn: true }]);
  await seed(fixture.beta, [{ id: 'conversation_beta_done', project: SHARED_PROJECT }]);
  const alphaBefore = await treeSnapshot(fixture.alpha.scopeRoot);

  const first = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.deepEqual(first.merged.map((item) => item.candidateId), [fixture.beta.id]);
  assert.equal(first.blocked.length, 1);
  assert.equal(first.blocked[0].candidateId, fixture.alpha.id);
  assert.equal(first.blocked[0].code, 'runtime-data-set-merge-unfinished-work');
  assert.equal(first.blocked[0].newlyBlocked, true);
  assert.match(first.blocked[0].message, /Turn\(active\)×1/);
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), alphaBefore);
  const target = readTarget(fixture.current);
  try { assert.equal(target.count('conversation', 'id = ?', 'conversation_alpha_active'), 0); }
  finally { target.close(); }

  const second = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.equal(second.pendingSources, 0);
  assert.deepEqual(second.blocked.map((item) => [item.candidateId, item.newlyBlocked]), [[fixture.alpha.id, false]]);

  await requestRuntimeDataSetMerge(fixture.paths, {
    candidateId: fixture.alpha.id,
    expectedDataSetId: fixture.alpha.binding.dataSetId,
    expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  });
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.state, 'requested');
  const retried = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.deepEqual(retried.blocked.map((item) => [item.candidateId, item.newlyBlocked]), [[fixture.alpha.id, true]]);
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.state, 'blocked');

  // The fixed default data set is not a historical workspace scope: never merged implicitly.
  const other = await createFixture(t, { selected: 'alpha' });
  await seed(other.current, [{ id: 'conversation_default_1', project: SHARED_PROJECT }]);
  const implicit = await mergeRuntimeDataSetsIntoSelected(other.paths);
  assert.deepEqual(implicit.merged.map((item) => item.candidateId), [other.beta.id]);
  await requestRuntimeDataSetMerge(other.paths, {
    candidateId: 'default',
    expectedDataSetId: other.current.binding.dataSetId,
    expectedRootInstanceId: other.current.binding.rootInstanceId
  });
  const explicit = await mergeRuntimeDataSetsIntoSelected(other.paths);
  assert.deepEqual(explicit.merged.map((item) => item.candidateId), ['default']);
  const merged = readTarget(other.alpha);
  try { assert.equal(merged.count('conversation', 'id = ?', 'conversation_default_1'), 1); }
  finally { merged.close(); }
});

test('每份旧库只自动合并一次：切换当前库或重置后不重复合并，也不把原目标库并走；明确请求仍会合并', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_once', project: SHARED_PROJECT }]);
  await seed(fixture.beta, [{ id: 'conversation_beta_once', project: SHARED_PROJECT }]);
  assert.equal((await mergeRuntimeDataSetsIntoSelected(fixture.paths)).merged.length, 2);

  // Switching to alpha: beta was merged before and default received merges, so nothing moves.
  await selectVscodeRuntimeDataSet(fixture.paths, fixture.alpha.id);
  const switched = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.equal(switched.pendingSources, 0);
  assert.deepEqual(switched.merged, []);
  await selectVscodeRuntimeDataSet(fixture.paths, 'default');

  // An archive-and-reset gives default a new identity; earlier merge records stay behind.
  const recordsDirectory = path.join(path.dirname(fixture.current.binding.paths.dataRootPath), 'merged-sources');
  for (const name of await fs.readdir(recordsDirectory)) {
    const file = path.join(recordsDirectory, name);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...record, target: { ...record.target, rootInstanceId: 'before-reset' } }));
  }
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id), undefined);
  const afterReset = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.equal(afterReset.pendingSources, 0);

  await requestRuntimeDataSetMerge(fixture.paths, {
    candidateId: fixture.alpha.id,
    expectedDataSetId: fixture.alpha.binding.dataSetId,
    expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  });
  const explicit = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.deepEqual(explicit.merged.map((item) => item.candidateId), [fixture.alpha.id]);
  assert.equal(explicit.merged[0].insertedConversations, 0, '已有的相同行只复用');
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.state, 'merged');
});

test('同一身份内容不同则整份回滚，目标和来源都不变', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, [{ id: 'conversation_duplicate', project: SHARED_PROJECT, title: '当前库标题' }]);
  await seed(fixture.alpha, [
    { id: 'conversation_duplicate', project: SHARED_PROJECT, title: '旧库标题' },
    { id: 'conversation_alpha_unique', project: SHARED_PROJECT }
  ]);
  const before = await treeSnapshot(fixture.alpha.scopeRoot);
  const targetBefore = targetDigest(fixture.current);
  const report = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  const alpha = report.blocked.find((item) => item.candidateId === fixture.alpha.id);
  assert.equal(alpha?.code, 'runtime-data-set-merge-conflict');
  assert.match(alpha.message, /Conversation#conversation_duplicate/);
  assert.equal(targetDigestAfterIgnoring(fixture.current, ['conversation_beta']), targetBefore);
  const target = readTarget(fixture.current);
  try { assert.equal(target.count('conversation', 'id = ?', 'conversation_alpha_unique'), 0); }
  finally { target.close(); }
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), before);
});

test('提交前中断时目标不变并在下次完成；提交后记录前中断只补记录不重复合并', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_fault', project: SHARED_PROJECT }]);
  const before = targetDigest(fixture.current);
  const crashed = await mergeRuntimeDataSetsIntoSelected(fixture.paths, {
    onFaultPoint(point) { if (point === 'before-row-commit') throw new Error('simulated crash before commit'); }
  });
  assert.equal(crashed.failures.length, 1);
  assert.match(crashed.failures[0].message, /simulated crash before commit/);
  assert.equal(targetDigest(fixture.current), before);
  const resumed = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.equal(resumed.merged.length, 1);
  assert.equal(resumed.merged[0].recoveredCommit, false);
  assert.equal(resumed.merged[0].insertedConversations, 1);

  const second = await createFixture(t, { withBeta: false });
  await seed(second.alpha, [{ id: 'conversation_alpha_after_commit', project: SHARED_PROJECT }]);
  const interrupted = await mergeRuntimeDataSetsIntoSelected(second.paths, {
    onFaultPoint(point) { if (point === 'after-row-commit') throw new Error('simulated crash after commit'); }
  });
  assert.equal(interrupted.failures.length, 1);
  const recovered = await mergeRuntimeDataSetsIntoSelected(second.paths);
  assert.equal(recovered.merged.length, 1);
  assert.equal(recovered.merged[0].recoveredCommit, true);
  const target = readTarget(second.current);
  try { assert.equal(target.count('conversation', 'id = ?', 'conversation_alpha_after_commit'), 1); }
  finally { target.close(); }
});

test('CAS 不能硬链接时复制到临时文件、校验摘要后发布', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_copy', project: SHARED_PROJECT }]);
  const report = await mergeRuntimeDataSetsIntoSelected(fixture.paths, {
    async linkFile() { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); }
  });
  assert.equal(report.merged.length, 1);
  assert.ok(report.merged[0].copiedCasObjects > 0);
  assert.equal(report.merged[0].linkedCasObjects, 0);
  const text = messageText('conversation_alpha_copy', 0);
  const [source, target] = [casFile(fixture.alpha.binding, text), casFile(fixture.current.binding, text)];
  assert.notEqual((await fs.stat(source)).ino, (await fs.stat(target)).ino);
  assert.equal(await fs.readFile(target, 'utf8'), text);
  assert.deepEqual(await fs.readdir(path.join(fixture.current.binding.paths.casRootPath, 'tmp')), []);
});

test('当前库仍有其它窗口时不合并；来源被旧窗口占用时单独推迟', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_busy', project: SHARED_PROJECT }]);
  await seed(fixture.beta, [{ id: 'conversation_beta_free', project: SHARED_PROJECT }]);
  const targetHost = await publishHost(fixture.current.binding);
  const blocked = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.equal(blocked.targetHostsActive.length, 1);
  assert.equal(blocked.pendingSources, 2);
  assert.deepEqual(blocked.merged, []);
  await fs.rm(targetHost);

  await publishHost(fixture.alpha.binding);
  const partial = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.deepEqual(partial.deferred.map((item) => item.candidateId), [fixture.alpha.id]);
  assert.deepEqual(partial.merged.map((item) => item.candidateId), [fixture.beta.id]);
});

test('当前库被参与协作的窗口使用时，在准入内等它让出后完成合并', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_coordinated', project: SHARED_PROJECT }]);
  const targetHost = await publishHost(fixture.current.binding);
  const participant = await registerExclusiveMaintenanceParticipant(fixture.current.binding.paths, 'fixture-host');
  const events = [];
  const report = await mergeRuntimeDataSetsIntoSelected(fixture.paths, {
    coordinateTargetHosts: (targetPaths, merge) => requestExclusiveRuntimeMaintenance(targetPaths, {
      operation: 'historical-merge', message: '为合并旧聊天记录', timeoutMs: 5_000, pollMs: 10,
      onWaitStart: () => {
        events.push('wait');
        // The other window reloads once idle; its Runtime closes and its liveness disappears.
        setTimeout(() => { void participant.unregister().then(() => fs.rm(targetHost)); }, 20);
      }
    }, async () => { events.push('merge'); await merge(); })
  });
  assert.deepEqual(events, ['wait', 'merge']);
  assert.deepEqual(report.targetHostsActive, []);
  assert.deepEqual(report.merged.map((item) => item.candidateId), [fixture.alpha.id]);

  // A failed coordination (an older window cannot take part, or the wait timed out) changes nothing.
  const gamma = await initializeScope(fixture.paths, 'gamma');
  await seed(gamma, [{ id: 'conversation_gamma_waiting', project: SHARED_PROJECT }]);
  await publishHost(fixture.current.binding);
  const before = targetDigest(fixture.current);
  const waiting = await mergeRuntimeDataSetsIntoSelected(fixture.paths, {
    coordinateTargetHosts: (targetPaths, merge) => requestExclusiveRuntimeMaintenance(targetPaths, {
      operation: 'historical-merge', message: '为合并旧聊天记录', timeoutMs: 50, pollMs: 10
    }, merge)
  });
  assert.equal(waiting.targetHostsActive.length, 1);
  assert.deepEqual(waiting.merged, []);
  assert.equal(targetDigest(fixture.current), before);
});

test('迁移复用：CAS 在线预复制到另一文件系统上的全新空根，独占时只补增量并携带未完成工作', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [
    { id: 'conversation_alpha_moved', project: SHARED_PROJECT },
    { id: 'conversation_alpha_running', project: SHARED_PROJECT, activeTurn: true }
  ]);
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-dataset-merge-other-'));
  t.after(() => fs.rm(otherRoot, { recursive: true, force: true }));
  const fresh = await initialize(otherRoot, 'default');
  const source = { configurationRootPath: fixture.root, binding: fixture.alpha.binding };
  const target = { configurationRootPath: otherRoot, binding: fresh.binding };
  const crossDevice = async () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
  const sourceBefore = await treeSnapshot(fixture.alpha.scopeRoot);

  const precopy = await precopyRuntimeDataSetCas(source, target, { linkFile: crossDevice });
  assert.ok(precopy.copiedCasObjects >= 3);
  assert.equal(precopy.linkedCasObjects, 0);
  const text = messageText('conversation_alpha_moved', 0);
  assert.equal(await fs.readFile(casFile(fresh.binding, text), 'utf8'), text);

  const input = {
    candidateId: fixture.alpha.id,
    expectedDataSetId: fixture.alpha.binding.dataSetId,
    expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  };
  const emptyDigest = targetDigest(fresh);
  await assert.rejects(mergeRuntimeDataSetIntoTarget(fixture.paths, input, target, { linkFile: crossDevice }),
    { code: 'runtime-data-set-merge-unfinished-work' });
  assert.equal(targetDigest(fresh), emptyDigest, '默认仍拒绝携带未完成工作');

  const result = await mergeRuntimeDataSetIntoTarget(fixture.paths, input, target,
    { linkFile: crossDevice, allowUnfinishedWork: true });
  assert.equal(result.insertedConversations, 2);
  assert.equal(result.copiedCasObjects, 0, '预复制之后独占期间不再复制正文');
  assert.equal(result.linkedCasObjects, 0);
  assert.equal(result.reusedCasObjects, precopy.copiedCasObjects);
  const moved = readTarget(fresh);
  try {
    assert.equal(moved.count('turn', "status = 'active'"), 1, '迁移时未完成工作原样带到新根，由新根的恢复处理');
    assert.equal(moved.count('execution_lease'), 1);
    assert.deepEqual(moved.conversationsFor(SHARED_PROJECT.uri), ['conversation_alpha_moved', 'conversation_alpha_running']);
    assert.deepEqual(moved.database.pragma('foreign_key_check'), []);
  } finally { moved.close(); }
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), sourceBefore);
});

test('已发布 epoch 4 旧工作区库先精确升级再合并', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_epoch4', project: SHARED_PROJECT }]);
  await downgradeToEpoch4(fixture.alpha.binding);
  const report = await mergeRuntimeDataSetsIntoSelected(fixture.paths);
  assert.deepEqual(report.failures, []);
  assert.equal(report.merged.length, 1);
  assert.equal(report.merged[0].upgradedFromEpoch, 4);
  const target = readTarget(fixture.current);
  try { assert.equal(target.count('conversation', 'id = ?', 'conversation_alpha_epoch4'), 1); }
  finally { target.close(); }
});

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-dataset-merge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { globalStoragePath: root };
  const current = await initialize(root, 'default');
  const alpha = await initializeScope(paths, 'alpha');
  const beta = options.withBeta === false ? undefined : await initializeScope(paths, 'beta');
  await selectVscodeRuntimeDataSet(paths, options.selected === 'alpha' ? alpha.id : 'default');
  return { root, paths, current, alpha, beta };
}

async function initializeScope(paths, name) {
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: [`file:///workspace/${name}`] });
  const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  return initialize(scopeRoot, `workspace:${scope.key}`);
}

async function initialize(scopeRoot, id) {
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { id, scopeRoot, authority, binding };
}

async function seed(dataSet, conversations) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `seed-${randomUUID()}` });
  try {
    const store = new kernel.ContentAddressedStore(dataSet.authority, dataSet.binding);
    const shared = await store.ingest(runtime, SHARED_TEXT, MESSAGE_TYPE);
    for (const spec of conversations) {
      const own = await store.ingest(runtime, messageText(spec.id, 0), MESSAGE_TYPE);
      const turnId = `${spec.id}_turn`;
      const steps = [
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
          id: spec.id, title: spec.title ?? spec.id, status: 'active', created_at: NOW, updated_at: NOW
        }),
        ...projectFolderAssignmentSteps({ conversationId: spec.id, folder: spec.project, now: NOW }),
        kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
          id: turnId, conversation_id: spec.id, status: spec.activeTurn ? 'active' : 'terminated',
          created_at: NOW, updated_at: NOW, terminal_at: spec.activeTurn ? null : NOW
        })
      ];
      if (spec.activeTurn) {
        steps.push(kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
          id: `${spec.id}_lease`, conversation_id: spec.id, turn_id: turnId, owner_id: 'old-owner',
          host_boot_id: 'old-host', generation: 1n, acquired_at: NOW, expires_at: NOW
        }));
      } else {
        steps.push(kernel.DOMAIN_REPOSITORIES.domain('TurnTermination').insert({
          id: `${spec.id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW
        }));
      }
      for (const [index, content] of [own, shared].entries()) {
        const messageId = `${spec.id}_message_${index}`;
        steps.push(
          kernel.DOMAIN_REPOSITORIES.domain('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
          kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
            id: `${messageId}_revision`, message_id: messageId, revision_seq: 1n, role: 'user',
            content_object_id: content.id, created_at: NOW
          }),
          kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
            id: `${messageId}_current`, message_id: messageId, revision_id: `${messageId}_revision`, updated_at: NOW
          }),
          kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insert({
            id: `${messageId}_member`, conversation_id: spec.id, message_id: messageId,
            message_seq: BigInt(index + 1), created_at: NOW
          })
        );
      }
      await runtime.transaction(steps);
    }
  } finally { await runtime.close(); }
}

async function downgradeToEpoch4(binding) {
  const oldKeys = new Set(kernel.EPOCH_4_RUNTIME_DOMAIN_SCHEMAS.map((schema) => schema.key));
  const added = kernel.RUNTIME_DOMAIN_SCHEMAS.filter((schema) => !oldKeys.has(schema.key));
  const database = new Database(kernel.toSqliteFilePath(binding.paths.databasePath));
  try {
    database.defaultSafeIntegers(true);
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    for (const schema of [...added].reverse()) database.exec(`DROP TABLE ${schema.table}`);
    const dropManifest = database.prepare('DELETE FROM schema_manifest WHERE domain_key = ?');
    for (const schema of added) dropManifest.run(schema.key);
    database.prepare('UPDATE schema_manifest SET runtime_kernel_epoch = 4').run();
    database.prepare('UPDATE root_binding SET runtime_kernel_epoch = 4 WHERE singleton = 1').run();
    database.exec('COMMIT');
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
  const epoch = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8'));
  await fs.writeFile(binding.paths.runtimeEpochPath, `${JSON.stringify({ ...epoch, runtimeKernelEpoch: 4 }, null, 2)}\n`);
  await fs.writeFile(binding.paths.rootPointerPath, `${JSON.stringify({ ...binding, runtimeKernelEpoch: 4 }, null, 2)}\n`);
}

function messageText(conversationId, index) {
  return JSON.stringify({ role: 'user', parts: [{ text: `${conversationId} 的第 ${index} 条消息` }] });
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function casFile(binding, text) {
  const digest = sha256(text);
  return path.join(binding.paths.casRootPath, 'sha256', digest.slice(0, 2), digest);
}

function readTarget(dataSet) {
  const database = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  return {
    database,
    count(table, where = '1 = 1', ...params) {
      return Number(database.prepare(`SELECT COUNT(*) FROM ${table} WHERE ${where}`).pluck().get(...params));
    },
    conversationsFor(uri) {
      return database.prepare(`
        SELECT link.conversation_id FROM conversation_project_link AS link
          JOIN project_context AS project ON project.id = link.project_context_id
         WHERE project.uri = ? ORDER BY link.conversation_id`).pluck().all(uri);
    },
    close() { database.close(); }
  };
}

function targetDigest(dataSet) {
  return targetDigestAfterIgnoring(dataSet, []);
}

function targetDigestAfterIgnoring(dataSet, ignoredPrefixes) {
  const database = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  try {
    database.defaultSafeIntegers(true);
    const hash = createHash('sha256');
    for (const schema of kernel.RUNTIME_DOMAIN_SCHEMAS) {
      for (const row of database.prepare(`SELECT * FROM ${schema.table} ORDER BY id`).iterate()) {
        if (ignoredPrefixes.some((prefix) => String(row.id).startsWith(prefix))) continue;
        hash.update(schema.table).update(JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? `${value}n` : value));
      }
    }
    return hash.digest('hex');
  } finally { database.close(); }
}

async function publishHost(binding) {
  const target = path.join(binding.paths.dataRootPath, 'host-liveness/fixture.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ kind: 'limcode-runtime-host-liveness', dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId,
    rootGeneration: binding.rootGeneration, hostBootId: 'fixture-host', livenessId: 'fixture-liveness', processId: process.pid,
    processStartIdentity: ownProcessStartIdentity(), startedAt: NOW, heartbeatAt: NOW }));
  return target;
}

async function treeSnapshot(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const stat = await fs.stat(file);
        files[path.relative(root, file)] = { size: stat.size, mtime: stat.mtimeMs,
          sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') };
      }
    }
  }
  await visit(root);
  return files;
}
