import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernelFile = (name) => require(path.join(compiledRoot, 'backend/reliableKernel', name));
const Database = require('better-sqlite3');
const { assertDatabaseBinding } = kernelFile('databaseSchema.js');
const { RUNTIME_KERNEL_EPOCH } = kernelFile('contracts.js');
const { attachRuntimeStatementCache, detachRuntimeStatementCache } = kernelFile('runtimeStatementCache.js');
const { RUNTIME_DOMAIN_SCHEMAS, createRootBindingTableSql, domainSchemaDigest } = kernelFile('schema/domainManifest.js');

test('RootBinding 查询复用语句，每次仍读取实际行并拒绝身份变化', () => {
  const database = new Database(':memory:');
  database.defaultSafeIntegers(true);
  const binding = {
    paths: {
      dataRootPath: '/runtime', databasePath: '/runtime/runtime.sqlite', casRootPath: '/runtime/cas',
      rootPointerPath: '/runtime/root.json', rootPendingPath: '/runtime/pending.json', runtimeEpochPath: '/runtime/epoch.json'
    },
    dataSetId: 'test-data-set', rootInstanceId: 'test-root', rootGeneration: 1,
    pointerRevision: 1, runtimeKernelEpoch: RUNTIME_KERNEL_EPOCH
  };
  try {
    database.exec(createRootBindingTableSql());
    database.prepare('INSERT INTO root_binding VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      ...Object.values(binding.paths), binding.dataSetId, binding.rootInstanceId,
      binding.rootGeneration, binding.pointerRevision, binding.runtimeKernelEpoch
    );
    const cache = attachRuntimeStatementCache(database);
    assertDatabaseBinding(database, binding);
    assertDatabaseBinding(database, binding);
    assert.equal(cache.inspect().prepares, 1);
    assert.equal(cache.inspect().hits, 1);

    database.prepare('UPDATE root_binding SET pointer_revision = pointer_revision + 1').run();
    assert.throws(() => assertDatabaseBinding(database, binding), /RootBinding fence mismatch/);
    database.prepare('DELETE FROM root_binding').run();
    assert.throws(() => assertDatabaseBinding(database, binding), /root_binding row is missing/);
  } finally {
    detachRuntimeStatementCache(database);
    database.close();
  }
});

test('固定 descriptor 的摘要复用只按对象身份，构造描述的变化仍按内容判断', () => {
  const current = RUNTIME_DOMAIN_SCHEMAS.find((schema) => schema.columns.some((column) => column.references));
  const currentReference = current.columns.find((column) => column.references).references;
  assert.equal(Object.isFrozen(currentReference), true);
  const expected = domainSchemaDigest(current);
  const constructed = structuredClone(current);
  assert.equal(domainSchemaDigest(constructed), expected);
  constructed.columns.find((column) => column.references).references.table = 'different_referenced_table';
  assert.notEqual(domainSchemaDigest(constructed), expected);
  assert.equal(domainSchemaDigest(current), expected);
});
