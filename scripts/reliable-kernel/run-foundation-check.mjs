import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { threadId } from 'node:worker_threads';
import { validateSqliteExtensionHostEvidence } from './lib/extension-host-evidence.mjs';

const root = process.cwd();
const checkId = option('check');
const expectedCommit = option('commit');
const require = createRequire(import.meta.url);
const kernelEntry = path.join(root, 'dist/extension/backend/reliableKernel/index.js');
if (!checkId) {
  console.error('用法：node scripts/reliable-kernel/run-foundation-check.mjs --check=<stable-id> [--commit=<sha>]');
  process.exit(2);
}
if (process.platform !== 'linux' || process.arch !== 'x64') {
  console.error(`Phase B冻结目标为linux/x64，实际为${process.platform}/${process.arch}`);
  process.exit(1);
}
let kernel;
try {
  kernel = require(kernelEntry);
} catch (error) {
  console.error(`无法加载已编译Phase B内核；请先运行npm run compile：${error.message}`);
  process.exit(1);
}

const handlers = new Map([
  ['foundation.sqlite-driver-load', checkSqliteDriverLoad],
  ['foundation.single-db-worker', checkSingleDatabaseWorker],
  ['foundation.schema-repositories', checkSchemaRepositories],
  ['foundation.cas-publish-before-reference', checkCasPublishBeforeReference],
  ['foundation.root-binding-fence', checkRootBindingFence],
  ['foundation.no-legacy-fallback', checkNoLegacyFallback],
  ['foundation.empty-root-current-epoch', checkEmptyRootCurrentEpoch]
]);
const handler = handlers.get(checkId);
if (!handler) {
  console.error(`没有Phase B foundation handler：${checkId}`);
  process.exit(2);
}
try {
  const summary = await handler();
  console.log(`PASS: ${checkId} — ${summary}`);
} catch (error) {
  console.error(`FAIL: ${checkId} — ${error?.stack || error}`);
  process.exit(1);
}

async function checkSqliteDriverLoad() {
  const result = validateSqliteExtensionHostEvidence({ root, expectedCommit });
  assert.deepEqual(result.problems, [], result.problems.join('；'));
  return `真实code-server Extension Host ${result.evidence.vscode.version}，Node ABI ${result.evidence.host.modules}，SQLite ${result.evidence.sqliteVersion}`;
}

async function checkSingleDatabaseWorker() {
  return withRuntime('single-worker', async ({ authority, binding, database }) => {
    const initial = await database.inspect();
    assert.equal(threadId, 0);
    assert.ok(initial.workerThreadId > 0);
    assert.equal(initial.writerConnectionCount, 1);
    assert.equal(initial.readerConnectionCount, 1);
    assert.equal(initial.journalMode.toLowerCase(), 'wal');
    assert.equal(initial.readerJournalMode.toLowerCase(), 'wal');
    assert.equal(initial.readerForeignKeys, 1n);
    assert.equal(initial.readerBusyTimeoutMs, 5000n);
    assert.equal(initial.synchronous, 1n);
    assert.equal(initial.foreignKeys, 1n);
    assert.equal(initial.busyTimeoutMs, 5000n);
    await assert.rejects(
      kernel.RuntimeDatabase.open(authority),
      /already open/
    );

    const conversations = kernel.DOMAIN_REPOSITORIES.domain('Conversation');
    const messages = kernel.DOMAIN_REPOSITORIES.domain('Message');
    const partOf = kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation');
    const now = new Date().toISOString();
    const first = await database.transaction([
      conversations.insert(conversation('conv-a', now)),
      kernel.savepoint('duplicate_conversation', [
        conversations.insert(conversation('conv-a', now))
      ], {
        kind: 'rollback-and-continue-on-unique',
        constraints: [{ domain: 'Conversation', columns: ['id'] }]
      }),
      conversations.insert(conversation('conv-b', now))
    ]);
    assert.equal(first.commitSeq, '1');
    assert.deepEqual(first.changes.map((entry) => entry.id), ['conv-a', 'conv-b']);
    assert.deepEqual(first.allocatedSequences, []);

    await assert.rejects(database.transaction([
      conversations.insert(conversation('conv-b', now))
    ]), /UNIQUE|constraint/i);

    const sequenceOne = await database.transaction([
      messages.insert(message('message-1', now)),
      partOf.insertWithNextSequence({
        id: 'part-1', conversation_id: 'conv-a', message_id: 'message-1', created_at: now
      }, { column: 'message_seq', scope: { conversation_id: 'conv-a' } })
    ]);
    const sequenceTwo = await database.transaction([
      messages.insert(message('message-2', now)),
      partOf.insertWithNextSequence({
        id: 'part-2', conversation_id: 'conv-a', message_id: 'message-2', created_at: now
      }, { column: 'message_seq', scope: { conversation_id: 'conv-a' } })
    ]);
    assert.deepEqual(sequenceOne.allocatedSequences.map((entry) => entry.value), ['1']);
    assert.deepEqual(sequenceTwo.allocatedSequences.map((entry) => entry.value), ['2']);
    assert.equal(sequenceOne.commitSeq, '2');
    assert.equal(sequenceTwo.commitSeq, '3');

    const delivered = [];
    const subscriptionPromise = database.snapshotAndSubscribe(
      [conversations.list({ limit: 100 })],
      (result) => delivered.push(result)
    );
    const concurrentCommitPromise = database.transaction([
      conversations.insert(conversation('conv-c', now))
    ]);
    const [subscription, concurrentCommit] = await Promise.all([subscriptionPromise, concurrentCommitPromise]);
    const snapshotRows = subscription.barrier.snapshot[0];
    if (BigInt(concurrentCommit.commitSeq) <= BigInt(subscription.barrier.snapshotCommitSeq)) {
      assert.ok(snapshotRows.some((row) => row.id === 'conv-c'));
    } else {
      assert.ok(delivered.some((result) => result.commitSeq === concurrentCommit.commitSeq));
    }
    subscription.unsubscribe();

    const finalInspection = await database.inspect();
    assert.equal(finalInspection.workerThreadId, initial.workerThreadId);
    assert.equal(finalInspection.currentCommitSeq, '4');
    await database.close();
    const reopened = await kernel.RuntimeDatabase.open(authority, { hostBootId: 'foundation-reopen' });
    try {
      const reopenedInspection = await reopened.inspect();
      assert.equal(reopenedInspection.currentCommitSeq, '0');
      assert.notEqual(reopenedInspection.hostBootId, initial.hostBootId);
      const snapshot = await reopened.snapshot([conversations.get('conv-c')]);
      assert.equal(snapshot.snapshot[0].id, 'conv-c');
      assert.equal(snapshot.snapshotCommitSeq, '0');
      assert.equal(reopened.binding.rootGeneration, binding.rootGeneration);
    } finally {
      await reopened.close();
    }
    return '单worker持有writer+WAL reader，事务/savepoint/rollback/reopen、max+1序列与snapshot barrier均真实通过';
  });
}

async function checkSchemaRepositories() {
  const authorityContract = JSON.parse(await fs.readFile(
    path.join(root, 'docs/architecture/reliable-kernel/contracts/authority.json'),
    'utf8'
  ));
  const projected = kernel.RUNTIME_DOMAIN_SCHEMAS.map((entry) => ({
    key: entry.key,
    table: entry.table,
    repository: entry.repository,
    codec: entry.codec,
    mutations: [...entry.mutations],
    client: entry.client,
    deletePolicy: entry.deletePolicy,
    resetPolicy: entry.resetPolicy,
    indexes: [...entry.indexes]
  }));
  const expected = authorityContract.runtimeDomains.map((entry) => ({
    key: entry.key,
    table: entry.table,
    repository: entry.repository,
    codec: entry.codec,
    mutations: entry.mutations,
    client: entry.client,
    deletePolicy: entry.deletePolicy,
    resetPolicy: entry.resetPolicy,
    indexes: entry.indexes
  }));
  assert.deepEqual(projected, expected);
  const domainCount = expected.length;
  assert.equal(kernel.DOMAIN_REPOSITORIES.all().length, domainCount);
  assert.equal(new Set(kernel.DOMAIN_REPOSITORIES.all().map((entry) => entry.name)).size, domainCount);
  assert.equal(new Set(kernel.DOMAIN_REPOSITORIES.all().map((entry) => entry.codec.name)).size, domainCount);

  return withRuntime('schema', async ({ authority, binding, database }) => {
    const inspection = await database.inspect();
    assert.equal(inspection.tables.length, domainCount + 2);
    assert.deepEqual(inspection.triggers, [
      'delete_interaction_request_with_turn',
      'prevent_runtime_delivery_after_final_output_fence'
    ]);
    assert.equal(inspection.manifestDomainCount, domainCount);
    assert.equal(inspection.indexes.length, expected.reduce((count, entry) => count + entry.indexes.length, 0));
    assert.equal(inspection.foreignKeys, 1n);
    assert.equal(inspection.foreignKeyViolationCount, 0);

    const now = new Date().toISOString();
    const conversations = kernel.DOMAIN_REPOSITORIES.domain('Conversation');
    const reuseLinks = kernel.DOMAIN_REPOSITORIES.domain('ConversationReuseLink');
    const turns = kernel.DOMAIN_REPOSITORIES.domain('Turn');
    const interactionRequests = kernel.DOMAIN_REPOSITORIES.domain('InteractionRequest');
    const interactionOwners = kernel.DOMAIN_REPOSITORIES.domain('InteractionOwnerLink');
    const interactionResponses = kernel.DOMAIN_REPOSITORIES.domain('InteractionResponse');
    const toolCalls = kernel.DOMAIN_REPOSITORIES.domain('ToolCall');
    const operations = kernel.DOMAIN_REPOSITORIES.domain('Operation');
    const inbox = kernel.DOMAIN_REPOSITORIES.domain('RuntimeInboxItem');
    const deliveries = kernel.DOMAIN_REPOSITORIES.domain('RuntimeDelivery');
    const attempts = kernel.DOMAIN_REPOSITORIES.domain('Attempt');
    const content = await kernel.ContentAddressedStore.forDatabase(authority, database).ingest(database, 'schema interaction', 'text/plain');
    await database.transaction([
      conversations.insert(conversation('conv-schema', now)),
      reuseLinks.insert({
        id: 'reuse-schema', reuse_key: 'schema-key', conversation_id: 'conv-schema', agent_id: 'agent-soft', created_at: now, updated_at: now
      }),
      turns.insert({
        id: 'turn-schema', conversation_id: 'conv-schema', status: 'pending', created_at: now, updated_at: now, terminal_at: null
      }),
      interactionRequests.insert({
        id: 'request-schema', request_kind: 'approval', status: 'pending', prompt_object_id: content.id, created_at: now, updated_at: now
      }),
      interactionOwners.insert({
        id: 'owner-schema', request_id: 'request-schema', turn_id: 'turn-schema', created_at: now
      }),
      interactionResponses.insert({
        id: 'response-schema', request_id: 'request-schema', content_object_id: content.id, created_at: now
      }),
      toolCalls.insert({
        id: 'tool-call-schema', turn_id: 'turn-schema', call_seq: 1n, tool_name: 'schema', status: 'pending',
        arguments_object_id: content.id, created_at: now, updated_at: now
      }),
      operations.insert({
        id: 'operation-schema', owner_kind: 'process', owner_id: 'process-soft', operation_seq: 1n,
        tool_call_id: 'tool-call-schema', status: 'pending', created_at: now, updated_at: now
      }),
      inbox.insert({
        id: 'inbox-schema', dedupe_key: 'schema-dedupe', source_kind: 'internal', source_id: 'source-schema', state: 'pending', created_at: now, updated_at: now
      })
    ]);
    await database.transaction([deliveries.insert(delivery('delivery-null-1', null, 1n, now))]);
    await assert.rejects(
      database.transaction([deliveries.insert(delivery('delivery-null-duplicate', null, 1n, now))]),
      /UNIQUE|constraint/i
    );
    await assert.rejects(
      database.transaction([deliveries.insert(delivery('delivery-turn-same-attempt', 'turn-soft', 1n, now))]),
      /UNIQUE|constraint/i
    );
    await database.transaction([deliveries.insert(delivery('delivery-turn-attempt-2', 'turn-soft', 2n, now))]);
    await assert.rejects(
      database.transaction([deliveries.insert(delivery('delivery-turn-attempt-2-duplicate', 'turn-soft', 2n, now))]),
      /UNIQUE|constraint/i
    );
    await database.transaction([deliveries.insert(delivery('delivery-null-attempt-3', null, 3n, now))]);
    await assert.rejects(database.transaction([attempts.insert({
      id: 'attempt-missing-parent', operation_id: 'missing-operation', attempt_seq: 1n,
      status: 'pending', created_at: now, updated_at: now
    })]), /FOREIGN KEY|constraint/i);

    const deletion = await database.transaction([conversations.delete('conv-schema')]);
    const cascade = await database.snapshot([
      reuseLinks.get('reuse-schema'),
      turns.get('turn-schema'),
      interactionOwners.get('owner-schema'),
      interactionRequests.get('request-schema'),
      interactionResponses.get('response-schema'),
      toolCalls.get('tool-call-schema'),
      operations.get('operation-schema')
    ]);
    assert.deepEqual(cascade.snapshot.slice(0, 6), [null, null, null, null, null, null]);
    assert.equal(cascade.snapshot[6].tool_call_id, null);
    const changed = new Set(deletion.changes.map((entry) => `${entry.domain}:${entry.kind}:${entry.id}`));
    for (const expectedChange of [
      'ConversationReuseLink:remove:reuse-schema',
      'Turn:remove:turn-schema',
      'InteractionRequest:remove:request-schema',
      'InteractionResponse:remove:response-schema',
      'ToolCall:remove:tool-call-schema',
      'Operation:upsert:operation-schema',
      'Conversation:remove:conv-schema'
    ]) assert.ok(changed.has(expectedChange), `缺少隐式SQLite变化：${expectedChange}`);
    return `${domainCount}域/${domainCount + 2}表 exact set、独立Repository/Codec、FK/级联删除及其changes、自动投递全局attempt UNIQUE索引均真实生效`;
  });
}

async function checkCasPublishBeforeReference() {
  return withRuntime('cas', async ({ authority, binding, database }) => {
    const store = kernel.ContentAddressedStore.loose(authority, binding);
    const contentObjects = kernel.DOMAIN_REPOSITORIES.domain('ContentObject');
    const durability = await traceFsDurability(async (events) => {
      const firstStart = events.length;
      const orphan = await store.publish('published-before-reference', 'text/plain');
      const first = events.slice(firstStart);
      const secondStart = events.length;
      const duplicate = await store.publish('published-before-reference', 'text/plain');
      return { orphan, duplicate, first, second: events.slice(secondStart) };
    });
    const orphan = durability.orphan;
    assert.equal(durability.duplicate.absolutePath, orphan.absolutePath);
    assertDurablePublishTrace(durability.first, binding, orphan.absolutePath, 'linked');
    assertDurablePublishTrace(durability.second, binding, orphan.absolutePath, 'EEXIST');
    const beforeReference = await database.snapshot([contentObjects.list({
      where: { content_type: orphan.contentType, sha256: orphan.sha256, byte_length: orphan.byteLength },
      limit: 10
    })]);
    assert.deepEqual(beforeReference.snapshot[0], []);
    assert.ok((await fs.stat(orphan.absolutePath)).isFile());

    const metadata = await store.ingest(database, 'committed-content', 'text/plain');
    assert.equal((await store.read(metadata)).toString('utf8'), 'committed-content');
    const referenced = await database.snapshot([contentObjects.get(metadata.id)]);
    assert.equal(referenced.snapshot[0].sha256, metadata.sha256);
    assert.ok((await fs.stat(path.join(binding.paths.casRootPath, ...metadata.storage_key.split('/')))).isFile());

    const missingDigest = 'f'.repeat(64);
    await assert.rejects(database.transaction([contentObjects.insert({
      id: 'missing-content-object', content_type: 'text/plain', sha256: missingDigest,
      byte_length: 1n, storage_key: kernel.storageKeyForDigest(missingDigest), created_at: new Date().toISOString()
    })]), /missing|wrong length|ENOENT/i);
    const missing = await database.snapshot([contentObjects.get('missing-content-object')]);
    assert.equal(missing.snapshot[0], null);

    await fs.rm(binding.paths.casRootPath, { recursive: true, force: true });
    await fs.writeFile(binding.paths.casRootPath, 'blocked');
    await assert.rejects(store.publish('cannot-publish', 'text/plain'));
    const afterFailure = await database.snapshot([contentObjects.list({ limit: 100 })]);
    assert.equal(afterFailure.snapshot[0].length, 1);
    return 'CAS对象先原子发布并fsync新建目录/对象目录项，EEXIST观察者也重验并fsync；随后才提交ContentObject；orphan允许，缺失/发布失败均无SQLite引用';
  });
}

async function checkRootBindingFence() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-foundation-root-fence-'));
  let firstDatabase;
  let secondDatabase;
  try {
    const first = await kernel.resetCandidateRuntimeRoot(parent);
    firstDatabase = await kernel.RuntimeDatabase.open(first.authority, { hostBootId: 'root-first' });
    const firstStore = kernel.ContentAddressedStore.forDatabase(first.authority, firstDatabase);
    await assert.rejects(
      kernel.resetCandidateRuntimeRoot(parent),
      /requires the current Runtime database worker to be closed/i
    );

    const originalEpoch = JSON.parse(await fs.readFile(first.binding.paths.runtimeEpochPath, 'utf8'));
    const stalePointer = {
      ...first.binding,
      paths: { ...first.binding.paths },
      rootGeneration: first.binding.rootGeneration + 1,
      pointerRevision: first.binding.pointerRevision + 1
    };
    await fs.writeFile(first.binding.paths.rootPointerPath, `${JSON.stringify(stalePointer, null, 2)}\n`);
    await fs.writeFile(first.binding.paths.runtimeEpochPath, `${JSON.stringify({
      ...originalEpoch,
      rootGeneration: stalePointer.rootGeneration
    }, null, 2)}\n`);
    await assert.rejects(firstDatabase.inspect(), (error) => error?.code === 'stale-root-binding');
    await assert.rejects(firstStore.publish('stale-cas', 'text/plain'), (error) => error?.code === 'stale-root-binding');

    await fs.writeFile(first.binding.paths.rootPointerPath, `${JSON.stringify(first.binding, null, 2)}\n`);
    await fs.writeFile(first.binding.paths.runtimeEpochPath, `${JSON.stringify(originalEpoch, null, 2)}\n`);
    await firstDatabase.close();
    firstDatabase = undefined;

    const second = await kernel.resetCandidateRuntimeRoot(parent);
    assert.equal(second.binding.rootGeneration, first.binding.rootGeneration + 1);
    assert.equal(second.binding.pointerRevision, first.binding.pointerRevision + 1);
    assert.notEqual(second.binding.paths.dataRootPath, first.binding.paths.dataRootPath);
    secondDatabase = await kernel.RuntimeDatabase.open(second.authority, { hostBootId: 'root-second' });
    const inspection = await secondDatabase.inspect();
    assert.equal(inspection.currentCommitSeq, '0');
    assert.equal(secondDatabase.binding.rootInstanceId, second.binding.rootInstanceId);
    return '每次request/CAS校验generation；打开时拒绝换根，stale fail closed，close后才能reset并reopen';
  } finally {
    if (firstDatabase) await firstDatabase.close().catch(() => undefined);
    if (secondDatabase) await secondDatabase.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function checkNoLegacyFallback() {
  const reliableKernelRoot = path.join(root, 'backend/reliableKernel');
  const sourceFiles = await walkFiles(reliableKernelRoot, (file) => file.endsWith('.ts'));
  const source = (await Promise.all(sourceFiles.map((file) => fs.readFile(file, 'utf8')))).join('\n');
  for (const forbidden of [
    'fileConversationTransactionBackend',
    'runtimeAuthorityStore',
    "vscodeStorage/migration",
    "vscodeStorage/dataEpoch"
  ]) assert.ok(!source.includes(forbidden), `new kernel imports legacy path: ${forbidden}`);
  const migration = JSON.parse(await fs.readFile(
    path.join(root, 'docs/architecture/reliable-kernel/contracts/migration.json'),
    'utf8'
  ));
  for (const field of ['legacyRuntimeImport', 'dualWrite', 'fallbackToLegacyRuntime', 'runtimeProtocolNegotiation']) {
    assert.equal(migration[field], false);
  }

  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-foundation-no-fallback-'));
  let database;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    database = await kernel.RuntimeDatabase.open(candidate.authority);
    await database.close();
    database = undefined;
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${candidate.binding.paths.databasePath}${suffix}`, { force: true });
    await assert.rejects(kernel.RuntimeDatabase.open(candidate.authority));
    const entries = new Set(await fs.readdir(candidate.binding.paths.dataRootPath));
    for (const legacy of ['conversations', 'operations', 'turns', 'tool-calls', 'conversation-history']) {
      assert.ok(!entries.has(legacy), `SQLite failure routed to legacy root ${legacy}`);
    }
    return '真实SQLite open失败直接抛错，新内核导入图无旧writer，未创建任何legacy Runtime数据';
  } finally {
    if (database) await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function checkEmptyRootCurrentEpoch() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-foundation-empty-root-'));
  let database;
  try {
    const dataRoot = path.join(parent, 'empty-runtime');
    await fs.mkdir(dataRoot);
    await fs.writeFile(path.join(dataRoot, 'user-owned.txt'), 'keep');
    const authority = new kernel.RootAuthority(() => dataRoot);
    const binding = await kernel.initializeEmptyRuntimeRoot(authority);
    assert.equal(binding.runtimeKernelEpoch, kernel.RUNTIME_KERNEL_EPOCH);
    assert.equal(await fs.readFile(path.join(dataRoot, 'user-owned.txt'), 'utf8'), 'keep');
    for (const required of [binding.paths.databasePath, binding.paths.casRootPath, binding.paths.runtimeEpochPath, binding.paths.rootPointerPath]) {
      await fs.stat(required);
    }
    database = await kernel.RuntimeDatabase.open(authority);
    assert.equal((await database.inspect()).manifestDomainCount, kernel.RUNTIME_DOMAIN_SCHEMAS.length);
    await database.close();
    database = undefined;
    await fs.rm(binding.paths.runtimeEpochPath);
    await assert.rejects(authority.current(), (error) => error?.code === 'runtime-epoch-missing-or-invalid');

    const pendingParent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-foundation-pending-'));
    try {
      const pendingRoot = path.join(pendingParent, 'runtime');
      const pendingAuthority = new kernel.RootAuthority(() => pendingRoot);
      await assert.rejects(pendingAuthority.initializeEmptyRoot(async () => {
        throw new Error('injected initialization failure');
      }), (error) => error?.code === 'root-activation-failed');
      await fs.stat(path.join(pendingParent, kernel.ROOT_BINDING_PENDING_FILE));
      await assert.rejects(pendingAuthority.current(), (error) => error?.code === 'root-binding-pending');
      await assert.rejects(fs.stat(path.join(pendingParent, kernel.ROOT_BINDING_POINTER_FILE)));
    } finally {
      await fs.rm(pendingParent, { recursive: true, force: true });
    }

    const interruptedCandidateParent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-foundation-candidate-retry-'));
    try {
      await assert.rejects(kernel.RootAuthority.resetCandidateRoot(interruptedCandidateParent, async () => {
        throw new Error('injected candidate failure');
      }), (error) => error?.code === 'root-activation-failed');
      await fs.stat(path.join(interruptedCandidateParent, kernel.ROOT_BINDING_PENDING_FILE));
      const recovered = await kernel.resetCandidateRuntimeRoot(interruptedCandidateParent);
      await recovered.authority.current();
      await assert.rejects(fs.stat(path.join(interruptedCandidateParent, kernel.ROOT_BINDING_PENDING_FILE)));
    } finally {
      await fs.rm(interruptedCandidateParent, { recursive: true, force: true });
    }
    return '空root直接创建current epoch/limcode.sqlite/CAS；用户文件保留，pending/缺epoch fail closed且candidate可显式重置';
  } finally {
    if (database) await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function traceFsDurability(body) {
  const promises = require('node:fs/promises');
  const originalOpen = promises.open;
  const originalLink = promises.link;
  const events = [];
  promises.open = async (filePath, ...args) => {
    const handle = await originalOpen(filePath, ...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'sync') {
          return async (...syncArgs) => {
            events.push({ kind: 'sync', path: path.resolve(String(filePath)) });
            return target.sync(...syncArgs);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };
  promises.link = async (sourcePath, targetPath) => {
    const event = {
      kind: 'link',
      sourcePath: path.resolve(String(sourcePath)),
      targetPath: path.resolve(String(targetPath)),
      outcome: 'pending'
    };
    events.push(event);
    try {
      const result = await originalLink(sourcePath, targetPath);
      event.outcome = 'linked';
      return result;
    } catch (error) {
      event.outcome = error?.code ?? 'error';
      throw error;
    }
  };
  try {
    return await body(events);
  } finally {
    promises.open = originalOpen;
    promises.link = originalLink;
  }
}

function assertDurablePublishTrace(events, binding, objectPath, expectedLinkOutcome) {
  const target = path.resolve(objectPath);
  const linkIndex = events.findIndex((event) => event.kind === 'link' && event.targetPath === target);
  assert.ok(linkIndex >= 0, `CAS trace missed link for ${target}`);
  assert.equal(events[linkIndex].outcome, expectedLinkOutcome);
  const beforeLink = events.slice(0, linkIndex);
  const afterLink = events.slice(linkIndex + 1);
  const casRoot = path.resolve(binding.paths.casRootPath);
  const temporaryRoot = path.join(casRoot, 'tmp');
  const digestRoot = path.join(casRoot, 'sha256');
  const digestPrefix = path.dirname(target);
  const syncCount = (part, directory) => part.filter((event) =>
    event.kind === 'sync' && event.path === directory
  ).length;
  assert.ok(syncCount(beforeLink, temporaryRoot) >= 1, 'CAS tmp directory was not synced before publish');
  assert.ok(syncCount(beforeLink, casRoot) >= 2, 'CAS root was not synced for both direct child directories');
  assert.ok(syncCount(beforeLink, digestRoot) >= 2, 'CAS digest root was not synced as child and prefix parent');
  assert.ok(syncCount(beforeLink, digestPrefix) >= 1, 'CAS digest prefix was not synced before publish');
  assert.ok(syncCount(afterLink, digestPrefix) >= 1, 'CAS object directory entry was not synced after link/EEXIST');
  assert.ok(syncCount(afterLink, temporaryRoot) >= 1, 'CAS temporary unlink was not synced');
}

async function withRuntime(label, body) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-foundation-${label}-`));
  let database;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    database = await kernel.RuntimeDatabase.open(candidate.authority, { hostBootId: `foundation-${label}` });
    return await body({ ...candidate, database });
  } finally {
    if (database) await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

function conversation(id, now) {
  return { id, title: id, status: 'active', created_at: now, updated_at: now };
}

function message(id, now) {
  return { id, created_at: now, updated_at: now };
}

function delivery(id, targetTurnId, attemptSeq, now) {
  return {
    id,
    inbox_item_id: 'inbox-schema',
    target_conversation_id: 'conv-schema',
    target_turn_id: targetTurnId,
    phase: 'next_turn',
    attempt_seq: attemptSeq,
    retry_of_delivery_id: null,
    state: 'pending',
    failure_reason: null,
    created_at: now,
    updated_at: now
  };
}

async function walkFiles(directory, predicate) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(absolute, predicate));
    else if (predicate(absolute)) result.push(absolute);
  }
  return result.sort();
}

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}
