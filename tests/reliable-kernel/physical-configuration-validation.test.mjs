import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { kernelFile, NOW } from './fixtures/runtime-merge-fixture.mjs';

const { verifyPhysicalConfigurationRoot, filterPhysicalConfigurationRoot } = kernelFile('physicalCutover.js');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-configuration-validation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, value) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
    return file;
  };
  const store = async (relative, rows) => {
    await write(`${relative}/index.json`, {
      schemaVersion: 1, savedAt: NOW,
      records: rows.map((row) => ({ id: row.id, file: `records/${row.id}.json`, updatedAt: NOW }))
    });
    for (const row of rows) await write(`${relative}/records/${row.id}.json`, { schemaVersion: 1, savedAt: NOW, record: row });
  };
  return { root, write, store };
}

test('配置校验一次读取每份 JSON，保留记录身份与孤儿检查，下一次校验重新读取', async (t) => {
  const f = await fixture(t);
  await f.write('settings/llm.json', { settings: { activeProviderConfigId: 'provider' } });
  await f.store('settings/llm-provider-configs', [{ id: 'provider', model: 'model' }]);
  await f.store('agents', [{ id: 'agent' }]);
  await f.write('settings/unknown.json', { arbitrary: true });
  const reads = new Map();
  const readFile = fs.readFile;
  fs.readFile = async function(file, ...args) {
    if (typeof file === 'string' && file.startsWith(`${f.root}${path.sep}`) && file.endsWith('.json')) {
      reads.set(file, (reads.get(file) ?? 0) + 1);
    }
    return readFile.call(this, file, ...args);
  };
  try { await verifyPhysicalConfigurationRoot(f.root); }
  finally { fs.readFile = readFile; }
  assert.equal(reads.size, 6);
  assert.ok([...reads.values()].every((count) => count === 1), JSON.stringify([...reads]));
  await f.write('settings/llm-provider-configs/records/provider.json', { record: { id: 'different' } });
  await assert.rejects(verifyPhysicalConfigurationRoot(f.root), /id与index不一致/);
  await f.write('settings/llm-provider-configs/records/provider.json', { record: { id: 'provider' } });
  await f.write('settings/llm-provider-configs/records/orphan.json', { record: { id: 'orphan' } });
  await assert.rejects(verifyPhysicalConfigurationRoot(f.root), /orphan或缺失文件/);
});

test('配置过滤后的单次校验保留全局记录，删除对话设置与 scope 记录', async (t) => {
  const f = await fixture(t);
  await f.write('settings/llm.json', { settings: {} });
  await f.write('settings/conversation-old-llm.json', { old: true });
  await f.write('settings/.conversation-settings-transactions/pending.json', { pending: true });
  await f.store('model-profile-scope-links', [{ id: 'global', scopeKind: 'global' }, { id: 'old', scopeKind: 'conversation' }]);
  await filterPhysicalConfigurationRoot(f.root);
  await assert.rejects(fs.readFile(path.join(f.root, 'settings/conversation-old-llm.json')), { code: 'ENOENT' });
  await assert.rejects(fs.readFile(path.join(f.root, 'settings/.conversation-settings-transactions/pending.json')), { code: 'ENOENT' });
  const index = JSON.parse(await fs.readFile(path.join(f.root, 'model-profile-scope-links/index.json'), 'utf8'));
  assert.deepEqual(index.records.map((row) => row.id), ['global']);
  await assert.rejects(fs.readFile(path.join(f.root, 'model-profile-scope-links/records/old.json')), { code: 'ENOENT' });
  await verifyPhysicalConfigurationRoot(f.root, true);
});
