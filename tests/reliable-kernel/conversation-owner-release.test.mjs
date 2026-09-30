import assert from 'node:assert/strict';
import nativeFs from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernelRoot = path.join(compiledRoot, 'backend/reliableKernel');
const require = createRequire(path.join(kernelRoot, 'index.js'));
const kernel = require('./index.js');
const { ReliableConversationRunner } = require('../application/reliableKernel/ReliableConversationRunner.js');

function loadWithFileSystem(fileName, fileSystem, claimPrimitives) {
  const file = path.join(kernelRoot, fileName);
  const nativeRequire = createRequire(file);
  const exports = {};
  vm.runInThisContext(`(function(exports, require) {${nativeFs.readFileSync(file, 'utf8')}\n})`, { filename: file })(
    exports, (name) => name === 'node:fs/promises' ? fileSystem
      : name === './runtimeClaimPrimitives' && claimPrimitives ? claimPrimitives : nativeRequire(name)
  );
  return exports;
}

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-owner-release-'));
  const authority = new kernel.RootAuthority(() => path.join(temporary, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const managers = [];
  let failRelease = false;
  let holdPublication;
  const fileSystem = {
    ...fs,
    async rename(source, destination) {
      if (failRelease && String(destination).includes('.generation-released-')) {
        throw Object.assign(new Error('Temporary owner release failure'), {
          code: 'EACCES', syscall: 'rename', path: source, dest: destination
        });
      }
      await fs.rename(source, destination);
      if (holdPublication && destination === holdPublication.claimPath) {
        holdPublication.published();
        await holdPublication.gate;
      }
    }
  };
  const primitives = loadWithFileSystem('runtimeClaimPrimitives.js', fileSystem);
  const ownerModule = loadWithFileSystem('ConversationRuntimeOwnerManager.js', fileSystem, primitives);
  const createManager = (hostBootId) => {
    const manager = new ownerModule.ConversationRuntimeOwnerManager(binding, hostBootId);
    manager.setPendingWorkProbe(async () => false);
    managers.push(manager);
    return manager;
  };
  const claimPath = (id) => ownerModule.conversationRuntimeOwnerClaimPath(binding.paths, id);
  t.after(async () => {
    failRelease = false;
    holdPublication?.release();
    await Promise.allSettled(managers.map((manager) => manager.close()));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return {
    createManager, claimPath,
    failRelease(value) { failRelease = value; },
    async record(id) { return JSON.parse(await fs.readFile(path.join(claimPath(id), 'owner.json'), 'utf8')); },
    async exists(id) { return fs.stat(claimPath(id)).then(() => true, () => false); },
    holdPublication(id) {
      let published, release;
      const publishedPromise = new Promise((resolve) => { published = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      holdPublication = { claimPath: claimPath(id), published, gate, release };
      return { published: publishedPromise, release };
    }
  };
}

test('owner run 释放失败立即撤销 authority，下一次真实输入先清理旧 token 再重新认领', async (t) => {
  const h = await fixture(t);
  const owner = h.createManager('input-host');
  const id = 'conversation-input';
  let committed = false;
  h.failRelease(true);
  await assert.rejects(owner.run(id, async () => { committed = true; }), { code: 'EACCES' });
  assert.equal(committed, true);
  assert.equal(owner.owns(id), false);
  assert.deepEqual(owner.ownedActivity(), []);
  await assert.rejects(owner.assertOwned(id), { code: 'conversation-runtime-owner-mismatch' });
  assert.equal(await h.exists(id), true);
  const previousToken = (await h.record(id)).ownerToken;

  h.failRelease(false);
  let inputCalls = 0;
  const runner = new ReliableConversationRunner({
    database: { conversationOwners: owner, hostBootId: 'input-host', onCommit: () => () => {} },
    turns: { input: async () => {
      inputCalls += 1;
      assert.equal(owner.owns(id), true);
      assert.notEqual((await h.record(id)).ownerToken, previousToken);
      return { admitted: false, deduplicated: false };
    } }
  }, 'input-lease');
  t.after(() => runner.dispose());
  await runner.input({ commandId: 'next-input', conversationId: id, text: 'hello' });
  assert.equal(inputCalls, 1);
  assert.equal(owner.owns(id), false);
  assert.equal(await h.exists(id), false);
});

for (const retry of ['releaseIfIdle', 'sweepIdle']) {
  test(`owner ${retry} 重试失败释放，不因本地 owner 已删除而遗忘 token`, async (t) => {
    const h = await fixture(t);
    const owner = h.createManager(`retry-${retry}`);
    const peer = h.createManager(`peer-${retry}`);
    const id = `conversation-${retry}`;
    await owner.claim(id);
    h.failRelease(true);
    await assert.rejects(owner.releaseIfIdle(id), { code: 'EACCES' });
    assert.equal(owner.owns(id), false);
    assert.equal(await peer.tryClaim(id), false);
    h.failRelease(false);
    await owner[retry](id);
    assert.equal(await h.exists(id), false);
    assert.equal(await peer.tryClaim(id), true);
  });
}

for (const cleanup of ['sweepIdle', 'close']) {
  test(`失败释放经 ${cleanup} 重试只清理自己的 exact token，peer 替换 owner 保持不变`, async (t) => {
    const h = await fixture(t);
    const owner = h.createManager('previous-host');
    const peer = h.createManager('replacement-host');
    const id = 'conversation-replacement';
    await owner.claim(id);
    h.failRelease(true);
    await assert.rejects(owner.releaseIfIdle(id), { code: 'EACCES' });
    h.failRelease(false);
    await fs.rename(h.claimPath(id), `${h.claimPath(id)}.test-old-token`);
    await peer.claim(id);
    const replacement = await h.record(id);
    await owner[cleanup]();
    if (cleanup === 'sweepIdle') assert.equal(await owner.tryClaim(id), false);
    await owner.close();
    assert.deepEqual(await h.record(id), replacement);
    assert.equal(peer.owns(id), true);
  });
}

test('owner close 释放失败必须报告且保留 token，重复 close 单飞并可在 I/O 恢复后重试', async (t) => {
  const h = await fixture(t);
  const owner = h.createManager('closing-host');
  const peer = h.createManager('after-close-host');
  const id = 'conversation-close';
  await owner.claim(id);
  h.failRelease(true);
  const first = owner.close();
  const concurrent = owner.close();
  assert.equal(first, concurrent);
  await assert.rejects(first, { code: 'EACCES' });
  assert.equal(owner.owns(id), false);
  assert.equal(await h.exists(id), true);
  await assert.rejects(owner.claim(id), { code: 'conversation-runtime-owner-closed' });
  h.failRelease(false);
  await owner.close();
  assert.equal(await h.exists(id), false);
  assert.equal(await peer.tryClaim(id), true);
});

test('claim 发布与 close 交错时释放失败仍保留 token，close 不吞错误且可重试', async (t) => {
  const h = await fixture(t);
  const owner = h.createManager('publishing-host');
  const peer = h.createManager('after-publish-host');
  const id = 'conversation-publish-close';
  const publication = h.holdPublication(id);
  const claim = owner.claim(id);
  await publication.published;
  h.failRelease(true);
  const closing = owner.close();
  publication.release();
  await assert.rejects(claim, { code: 'EACCES' });
  await assert.rejects(closing, { code: 'EACCES' });
  assert.equal(owner.owns(id), false);
  assert.equal(await h.exists(id), true);
  h.failRelease(false);
  await owner.close();
  assert.equal(await h.exists(id), false);
  assert.equal(await peer.tryClaim(id), true);
});
