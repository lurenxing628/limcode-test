import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const { preparedContentObjectSteps } = require(path.join(compiled, 'backend/reliableKernel/contentObjectTransaction.js'));

test('附件可共享一次识别结果，原输入修改和伪造摘要不会改变 CAS 正文', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-identified-content-'));
  const authority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const database = await kernel.RuntimeDatabase.open(authority);
  try {
    const store = kernel.ContentAddressedStore.forDatabase(authority, database);
    const bytes = Buffer.from('identified before the first await');
    const content = store.identify(bytes, 'text/plain');
    assert.ok(Object.isFrozen(content));
    assert.ok(Object.isFrozen(content.identity));
    assert.throws(() => { content.identity.sha256 = '0'.repeat(64); }, TypeError);
    bytes.fill(0);
    const [first, duplicate] = await store.prepareIdentifiedBatch(database, [content, content]);
    assert.equal(first, duplicate);
    assert.equal(first.metadata.sha256, content.identity.sha256);
    assert.equal(first.metadata.id, content.identity.id);
    await database.transaction(preparedContentObjectSteps([first, duplicate], 'identified_content'));
    assert.equal((await store.read(first.metadata)).toString(), 'identified before the first await');
    assert.equal((await store.prepareIdentified(database, content)).insert, undefined);
    await assert.rejects(store.prepareIdentified(database, { identity: content.identity }),
      /requires a contentStore.identify result/);
  } finally {
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
