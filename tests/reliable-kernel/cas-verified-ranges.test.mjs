import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { RootAuthority } = require(path.join(compiled, 'backend/reliableKernel/rootAuthority.js'));
const { initializeEmptyRuntimeRoot } = require(path.join(compiled, 'backend/reliableKernel/runtimeDatabase.js'));
const { ContentAddressedStore } = require(path.join(compiled, 'backend/reliableKernel/contentAddressedStore.js'));
const { LocalCasByteAccess, LocalSynchronousCasByteAccess } = require(path.join(compiled, 'backend/reliableKernel/looseCasObjectAccess.js'));
async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-range-test-'));
  try {
    const authority = new RootAuthority(() => path.join(directory, 'runtime'));
    const binding = await initializeEmptyRuntimeRoot(authority);
    const store = new ContentAddressedStore(authority, binding);
    const publish = async (size, byte = 97) => {
      const value = await store.publish(Buffer.alloc(size, byte), 'text/plain');
      return { id: value.sha256, content_type: value.contentType, sha256: value.sha256,
        byte_length: value.byteLength, storage_key: value.storageKey, created_at: new Date().toISOString(), file: value.absolutePath };
    };
    await run({ store, publish, authority, binding });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
test('CAS paging verifies oversized and interleaved objects once without retaining file bodies', async () => fixture(async ({ store, publish }) => {
  const large = await publish(65 * 1048576);
  for (let i = 0; i < 8; i++) assert.equal((await store.readChunk(large, i * 262144, 262144)).chunk.length, 262144);
  assert.equal(store.inspectRangeReadCache().verifications, 1);
  const left = await publish(20 * 1048576, 98), right = await publish(20 * 1048576, 99);
  for (let i = 0; i < 8; i++) await store.readChunk(i % 2 ? right : left, Math.floor(i / 2) * 262144, 262144);
  assert.equal(store.inspectRangeReadCache().verifications, 3);
  assert.equal(store.inspectReadCache().bytes, 0);
  assert.equal(store.inspectRangeReadCache().activeHandles, 0);
}));
test('CAS concurrent first pages share verification and close every handle', async () => fixture(async ({ store, publish }) => {
  const item = await publish(2 * 1048576);
  await Promise.all(Array.from({ length: 4 }, (_, i) => store.readChunk(item, i * 262144, 262144)));
  assert.equal(store.inspectRangeReadCache().verifications, 1);
  assert.equal(store.inspectRangeReadCache().activeHandles, 0);
  assert.equal(store.inspectRangeReadCache().inflight, 0);
}));
test('CAS range cache revalidates replacement and mutation', async () => fixture(async ({ store, publish, binding }) => {
  const item = await publish(4096);
  await store.readChunk(item, 0, 32);
  await fs.rename(item.file, item.file + '.old');
  await fs.writeFile(item.file, Buffer.alloc(4096, 97));
  await store.readChunk(item, 32, 32);
  assert.equal(store.inspectRangeReadCache().verifications, 2);
  await fs.writeFile(item.file, Buffer.alloc(4096, 98));
  await assert.rejects(store.readChunk(item, 64, 32), /digest mismatch/);
  const bytes = new LocalCasByteAccess(binding.paths.casRootPath);
  new LocalSynchronousCasByteAccess(binding.paths.casRootPath).assertPublished(item);
  assert.equal(await bytes.containsExactLength(item), true, 'admission and backup retain length-only proofs');
  await assert.rejects(bytes.readBytes(item), /digest mismatch/);
  assert.equal(store.inspectRangeReadCache().entries, 0);
  assert.equal(store.inspectRangeReadCache().activeHandles, 0);
  assert.equal(store.inspectRangeReadCache().inflight, 0);
}));
test('CAS range metadata cache is bounded and root fences still apply', async () => fixture(async ({ store, publish, authority }) => {
  for (let i = 0; i < 132; i++) {
    const item = await publish(16, i);
    await store.readChunk(item, 0, 4);
  }
  assert.equal(store.inspectRangeReadCache().entries, 128);
  const item = await publish(16, 200);
  authority.validate = async () => { throw new Error('root fence fixture'); };
  await assert.rejects(store.readChunk(item, 0, 4), /root fence fixture/);
  assert.equal(store.inspectRangeReadCache().activeHandles, 0);
}));
test('CAS rejects a file replaced during verification and releases descriptors', async () => fixture(async ({ store, publish }) => {
  const item = await publish(2 * 1048576);
  const canonical = await fs.realpath(item.file);
  const open = fs.open;
  let replaced = false;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === canonical) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!replaced) {
          replaced = true;
          await fs.rename(item.file, item.file + '.old');
          await fs.writeFile(item.file, Buffer.alloc(2 * 1048576, 97));
        }
        return result;
      };
    }
    return handle;
  };
  try { await assert.rejects(store.readChunk(item, 0, 32), /replaced|changed/); }
  finally { fs.open = open; }
  assert.equal(replaced, true, 'reach the replacement instead of rejecting the initial file identity');
  assert.equal(store.inspectRangeReadCache().activeHandles, 0);
  assert.equal(store.inspectRangeReadCache().inflight, 0);
}));
test('CAS supports existing symbolic digest directories', async (t) => fixture(async ({ store, publish }) => {
  const item = await publish(4096);
  await store.readChunk(item, 0, 32);
  const directory = path.dirname(item.file);
  await fs.rename(directory, directory + '.old');
  if (!await makeSymlink(t, directory + '.old', directory, 'dir')) return;
  assert.equal((await store.readChunk(item, 32, 32)).chunk.equals(Buffer.alloc(32, 97)), true);
  assert.equal(store.inspectRangeReadCache().activeHandles, 0);
}));

async function makeSymlink(t, target, link, type) {
  try { await fs.symlink(target, link, type); return true; }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows host does not grant symbolic-link creation permission');
      return false;
    }
    throw error;
  }
}
test('CAS supports an existing symbolic object path', async (t) => fixture(async ({ store, publish, binding }) => {
  const item = await publish(4096);
  await store.readChunk(item, 0, 32);
  await fs.rename(item.file, item.file + '.old');
  if (!await makeSymlink(t, item.file + '.old', item.file, 'file')) return;
  assert.equal((await store.readChunk(item, 0, 32)).chunk.equals(Buffer.alloc(32, 97)), true);
  new LocalSynchronousCasByteAccess(binding.paths.casRootPath).assertPublished(item);
  assert.equal(await new LocalCasByteAccess(binding.paths.casRootPath).containsExactLength(item), false,
    'backup proof rejects a symbolic leaf while local reads and admission still follow it');
  assert.equal(store.inspectRangeReadCache().activeHandles, 0);
}));
test('CAS range boundaries handle EOF and reject invalid offsets and sizes', async () => fixture(async ({ store, publish }) => {
  const empty = await publish(0);
  assert.deepEqual(await store.readChunk(empty, 0, 1), { chunk: Buffer.alloc(0), totalBytes: 0, hasMore: false });
  const item = await publish(16);
  assert.equal((await store.readChunk(item, 16, 1)).chunk.length, 0);
  const tail = await store.readChunk(item, 15, 64);
  assert.equal(tail.chunk.length, 1);
  assert.equal(tail.hasMore, false);
  for (const offset of [-1, 0.5, 17, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.readChunk(item, offset, 4), RangeError);
  }
  for (const count of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.readChunk(item, 0, count), RangeError);
  }
  assert.equal(store.inspectRangeReadCache().activeHandles, 0);
}));

test('CAS supports a symbolic CAS root', async (t) => fixture(async ({ store, publish, binding }) => {
  const item = await publish(4096);
  const root = binding.paths.casRootPath;
  await fs.rename(root, root + '.old');
  if (!await makeSymlink(t, root + '.old', root, 'dir')) return;
  assert.equal((await store.readChunk(item, 0, 32)).chunk.equals(Buffer.alloc(32, 97)), true);
}));
test('CAS rejects symbolic target changes during verification', async (t) => fixture(async ({ store, publish }) => {
  const item = await publish(2 * 1048576);
  await fs.rename(item.file, item.file + '.one');
  await fs.copyFile(item.file + '.one', item.file + '.two');
  if (!await makeSymlink(t, item.file + '.one', item.file, 'file')) return;
  const canonical = await fs.realpath(item.file);
  const open = fs.open;
  let changed = false;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === canonical) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed) {
          changed = true;
          await fs.unlink(item.file);
          await fs.symlink(item.file + '.two', item.file, 'file');
        }
        return result;
      };
    }
    return handle;
  };
  try { await assert.rejects(store.readChunk(item, 0, 32), /target changed/); }
  finally { fs.open = open; }
  assert.equal(changed, true, 'reach the symbolic target change instead of rejecting the initial file identity');
  assert.equal(store.inspectRangeReadCache().entries, 0);
  assert.equal(store.inspectRangeReadCache().activeHandles, 0);
}));

test('Windows CAS paging keeps complete pathname and descriptor identities through verification and cached reads', async (t) => {
  for (const pathnameDevice of ['missing', 'full-width']) {
    for (const stage of ['verification', 'cached-range']) {
      for (const change of ['none', 'pathname-high-bits', 'descriptor-high-bits', 'replacement']) {
        await t.test(`${pathnameDevice}: ${stage}: ${change}`, async (sub) => fixture(async ({ store, publish }) => {
          const item = await publish(4096);
          const canonical = await fs.realpath(item.file);
          const pathnameDev = pathnameDevice === 'missing' ? 0n : 0x1234_5678_89ab_cdefn;
          const descriptorDev = pathnameDevice === 'missing' ? 742408122n : BigInt.asUintN(32, pathnameDev);
          const realLstat = fs.lstat, realOpen = fs.open;
          let armed = stage === 'verification', changed = false;
          sub.mock.method(fs, 'lstat', async (target, ...args) => {
            const stat = await realLstat(target, ...args);
            if (String(target) === canonical && args[0]?.bigint) {
              stat.dev = pathnameDev + (changed && change === 'pathname-high-bits' ? 1n << 32n : 0n);
            }
            return stat;
          });
          sub.mock.method(fs, 'open', async (target, ...args) => {
            const handle = await realOpen(target, ...args);
            if (String(target) === canonical) {
              const realStat = handle.stat.bind(handle), realRead = handle.read.bind(handle);
              handle.stat = async (...statArgs) => {
                const stat = await realStat(...statArgs);
                stat.dev = descriptorDev + (changed && change === 'descriptor-high-bits' ? 1n << 32n : 0n);
                return stat;
              };
              handle.read = async (...readArgs) => {
                const result = await realRead(...readArgs);
                if (armed && !changed && change !== 'none') {
                  changed = true;
                  if (change === 'replacement') {
                    await fs.rename(item.file, item.file + '.old');
                    await fs.copyFile(item.file + '.old', item.file);
                  }
                }
                return result;
              };
            }
            return handle;
          });
          const platform = Object.getOwnPropertyDescriptor(process, 'platform');
          Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
          try {
            if (stage === 'cached-range') {
              assert.equal((await store.readChunk(item, 0, 32)).chunk.equals(Buffer.alloc(32, 97)), true);
              assert.equal(store.inspectRangeReadCache().verifications, 1);
              armed = true;
            }
            if (change === 'none') {
              assert.equal((await store.readChunk(item, 32, 32)).chunk.equals(Buffer.alloc(32, 97)), true);
              assert.equal((await store.readChunk(item, 64, 32)).chunk.equals(Buffer.alloc(32, 97)), true);
              assert.equal(store.inspectRangeReadCache().verifications, 1, 'reuse only the unchanged complete identity');
            } else {
              await assert.rejects(store.readChunk(item, 32, 32), /replaced|changed/);
              assert.equal(changed, true, 'exercise the fence after verification or cached range bytes were read');
            }
            assert.equal(store.inspectRangeReadCache().activeHandles, 0);
            assert.equal(store.inspectRangeReadCache().inflight, 0);
          } finally { Object.defineProperty(process, 'platform', platform); }
        }));
      }
    }
  }
});
