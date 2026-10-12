import { createOwnershipScope } from './ownership-scope-fixture.mjs';
// Focused production ownership boundary; old review matrices are absent.
import assert from 'node:assert/strict';

import nativeFs from 'node:fs';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import vm from 'node:vm';

import { createRequire } from 'node:module';

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
  const { outer: temporary, binding } = await createOwnershipScope('release');
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

export const scenario1 = async (t) => {
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
};
